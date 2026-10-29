import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { controlsFor, cardRequest, cardUpdate, freezeCard } from '../src/policy/card.js'
import { SAAS_OFFER } from '../src/demo/company.js'
import { cents } from '../src/policy/money.js'
import { FileRailStore, SimulatedRail } from '../src/rail/simulated.js'
import { RailError } from '../src/rail/types.js'

const charge = (card_id: string, amount: number, extra: Record<string, unknown> = {}) => ({
  card_id,
  transaction_amount: amount,
  transaction_currency: 'USD',
  merchant_category_code: '5734',
  merchant_info: 'Framewise Inc.',
  ...extra,
})

async function issue(rail: SimulatedRail, plan: 'monthly' | 'annual' = 'monthly', id = 'decision-1') {
  const holder = await rail.createIndividualCardholder({ email: 'a@example.com', first_name: 'A', last_name: 'B', date_of_birth: '1990-01-01', address: { line1: 'x', city: 'y', postcode: '1', country: 'US' } })
  const card = await rail.createCard(cardRequest({ id, plan, offer: SAAS_OFFER, revisitOn: null }, holder.cardholder_id, 'Ana'))
  return { holder, card }
}

test('the exact price is approved; any other amount, currency or category is declined with its reason', async () => {
  const rail = new SimulatedRail()
  const { card } = await issue(rail)
  assert.equal((await rail.simulateAuthorization(charge(card.card_id, 600, { transaction_currency: 'EUR' }))).failure_reason, 'CURRENCY_NOT_ALLOWED')
  assert.equal((await rail.simulateAuthorization(charge(card.card_id, 600, { merchant_category_code: '5812' }))).failure_reason, 'MERCHANT_CATEGORY_NOT_ALLOWED')
  assert.equal((await rail.simulateAuthorization(charge(card.card_id, 5904))).failure_reason, 'LIMIT_EXCEEDED')
  assert.equal((await rail.simulateAuthorization(charge(card.card_id, 600.01))).failure_reason, 'LIMIT_EXCEEDED')
  assert.equal((await rail.simulateAuthorization(charge(card.card_id, 600))).process_result, 'APPROVED')
})

test('the monthly limit is cumulative and resets with the calendar month', async () => {
  let now = new Date('2026-11-10T12:00:00Z')
  const rail = new SimulatedRail({ now: () => now })
  const { card } = await issue(rail)
  assert.equal((await rail.simulateAuthorization(charge(card.card_id, 600))).process_result, 'APPROVED')
  assert.equal((await rail.simulateAuthorization(charge(card.card_id, 1))).failure_reason, 'LIMIT_EXCEEDED')
  assert.deepEqual((await rail.getCardLimits(card.card_id)).limits.map((l) => l.remaining), [600, 0])
  now = new Date('2026-12-01T00:00:00Z')
  assert.equal((await rail.simulateAuthorization(charge(card.card_id, 600))).process_result, 'APPROVED')
})

test('an annual card accepts one charge, once', async () => {
  const rail = new SimulatedRail()
  const { card } = await issue(rail, 'annual')
  assert.equal((await rail.simulateAuthorization(charge(card.card_id, 5904))).process_result, 'APPROVED')
  assert.equal((await rail.simulateAuthorization(charge(card.card_id, 5904))).failure_reason, 'TRANSACTION_COUNT_EXCEEDED')
})

test('an update resends the controls and keeps the transaction count; freezing declines everything', async () => {
  const rail = new SimulatedRail()
  const { card } = await issue(rail)
  const raised = { ...SAAS_OFFER, monthlyPrice: cents(690) }
  assert.equal((await rail.simulateAuthorization(charge(card.card_id, 690))).failure_reason, 'LIMIT_EXCEEDED')
  const updated = await rail.updateCard(card.card_id, cardUpdate(raised, 'monthly'))
  assert.equal(updated.authorization_controls?.allowed_transaction_count, 'MULTIPLE')
  assert.deepEqual(updated.authorization_controls?.allowed_merchant_categories, ['5734'])
  assert.equal((await rail.simulateAuthorization(charge(card.card_id, 690))).process_result, 'APPROVED')
  await rail.updateCard(card.card_id, freezeCard())
  assert.equal((await rail.simulateAuthorization(charge(card.card_id, 1))).failure_reason, 'CARD_NOT_ACTIVE')
})

test('a reused request_id is rejected with a stable code and the card can be found by its metadata', async () => {
  const rail = new SimulatedRail()
  const { holder, card } = await issue(rail, 'monthly', 'same-decision')
  await assert.rejects(
    rail.createCard(cardRequest({ id: 'same-decision', plan: 'monthly', offer: SAAS_OFFER, revisitOn: null }, holder.cardholder_id, 'Ana')),
    (e: unknown) => e instanceof RailError && e.code === 'duplicate_request_id',
  )
  const listed = await rail.listCards({ cardholder_id: holder.cardholder_id })
  assert.equal(listed.items[0]!.card_id, card.card_id)
  assert.equal(listed.items[0]!.metadata?.decision_id, 'same-decision')
})

test('declined and accepted charges are listed newest first, and state survives a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rail-'))
  try {
    const first = new SimulatedRail({ store: new FileRailStore(join(dir, 'rail.json')) })
    const { card } = await issue(first)
    await first.simulateAuthorization(charge(card.card_id, 600))
    await first.simulateAuthorization(charge(card.card_id, 600))
    const second = new SimulatedRail({ store: new FileRailStore(join(dir, 'rail.json')) })
    const { items } = await second.listTransactions({ card_id: card.card_id })
    assert.deepEqual(items.map((t) => t.status), ['FAILED', 'CLEARING'])
    assert.equal(items[0]!.failure_reason, 'LIMIT_EXCEEDED')
    assert.equal(items[1]!.transaction_amount, -600)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('controls come from the policy, not from the charge', () => {
  const controls = controlsFor(SAAS_OFFER, 'monthly')
  assert.deepEqual(controls.allowed_currencies, ['USD'])
  assert.deepEqual(controls.transaction_limits.limits.map((l) => l.interval), ['PER_TRANSACTION', 'MONTHLY'])
})
