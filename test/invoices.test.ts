import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createExecutor, type CardApi } from '../src/approvals/executor.js'
import { ingestInvoice } from '../src/approvals/invoices.js'
import {
  approve,
  fingerprint,
  proposeCard,
  proposeCardUpdate,
  type Action,
  type PolicyContext,
  type Proposal,
} from '../src/approvals/proposals.js'
import { MemoryStore } from '../src/approvals/store.js'
import { cashPosition, OFFERS, SAAS_OFFER } from '../src/demo/company.js'
import { INJECTION, PRICE_INCREASE, type Invoice } from '../src/demo/invoices.js'
import { comparePlans } from '../src/policy/cash.js'
import { cents } from '../src/policy/money.js'

function setup() {
  let n = 0
  const ctx: PolicyContext = {
    position: cashPosition,
    offers: { ...OFFERS },
    now: () => new Date('2026-11-02T12:00:00Z'),
    newId: () => `proposal-${++n}`,
  }
  return { ctx, store: new MemoryStore() }
}

const noCards: CardApi = {
  createCard: async () => assert.fail('must not create a card'),
  getCard: async () => assert.fail('must not read a card'),
  updateCard: async () => assert.fail('must not update a card'),
  listCards: async () => assert.fail('must not list cards'),
}

test('the price-increase invoice keeps the 18% annual discount and carries the injection in its note', () => {
  assert.equal(PRICE_INCREASE.monthlyPrice, cents(690))
  assert.equal(PRICE_INCREASE.annualPrice, Math.round(PRICE_INCREASE.monthlyPrice * 12 * 0.82))
  assert.ok(PRICE_INCREASE.note.includes(INJECTION))
})

test('after the increase the policy still picks monthly, now at $690', () => {
  const offer = { ...SAAS_OFFER, monthlyPrice: PRICE_INCREASE.monthlyPrice, annualPrice: PRICE_INCREASE.annualPrice }
  const result = comparePlans(cashPosition(), offer)
  assert.equal(result.savingsPercent, 18)
  assert.equal(result.monthly.firstBreachWeek, null)
  assert.ok(result.annual.firstBreachWeek !== null)
  assert.equal(result.recommendation.kind === 'buy' && result.recommendation.plan, 'monthly')
})

test('an arriving invoice updates the offer from its structured fields only', () => {
  const { ctx } = setup()
  const result = ingestInvoice(ctx, 'framewise', PRICE_INCREASE)
  assert.equal(result.kind, 'updated')
  assert.deepEqual(ctx.offers.framewise, { ...SAAS_OFFER, monthlyPrice: cents(690), annualPrice: cents(6_789.6) })
  assert.equal(ingestInvoice(ctx, 'framewise', PRICE_INCREASE).kind, 'unchanged')
})

test('an invoice that changes the vendor, merchant category or currency is a new purchase, not an update', () => {
  const cases: [Partial<Invoice>, string][] = [
    [{ vendor: 'Framewise Billing Ltd.' }, 'vendor_mismatch'],
    [{ merchantCategoryCode: '6051' }, 'merchant_category_mismatch'],
    [{ currency: 'EUR' as 'USD' }, 'currency_mismatch'],
  ]
  for (const [change, reason] of cases) {
    const { ctx } = setup()
    assert.deepEqual(ingestInvoice(ctx, 'framewise', { ...PRICE_INCREASE, ...change }), { kind: 'refused', reason })
    assert.deepEqual(ctx.offers.framewise, SAAS_OFFER)
  }
  assert.deepEqual(ingestInvoice(setup().ctx, 'nope', PRICE_INCREASE), { kind: 'refused', reason: 'unknown_offer' })
})

test('an approval given before the invoice arrived goes stale instead of running at the old terms', async () => {
  const { ctx, store } = setup()
  const { proposal } = (await proposeCard(store, ctx, 'framewise')) as { proposal: Proposal }
  await approve(store, ctx, proposal.id, proposal.fingerprint)
  ingestInvoice(ctx, 'framewise', PRICE_INCREASE)
  const executor = createExecutor({ store, cards: noCards, ctx, cardholderId: 'holder-1', createdBy: 'Ana Souza' })
  assert.equal((await executor.execute(proposal.id)).status, 'stale')
})

test('the injected instruction gets the attacker nothing', async () => {
  const { ctx, store } = setup()
  ingestInvoice(ctx, 'framewise', PRICE_INCREASE)

  // The model's only way to act is proposing by id. Whatever it "decided" after reading the note,
  // the terms come from the policy: monthly at $690, limits equal to the price, same vendor and category.
  const { proposal } = (await proposeCardUpdate(store, ctx, 'card-1', 'framewise')) as { proposal: Proposal }
  assert.deepEqual(proposal.action, {
    kind: 'update_card',
    cardId: 'card-1',
    offerId: 'framewise',
    terms: {
      vendor: 'Framewise Inc.',
      product: 'Framewise Team',
      plan: 'monthly',
      amount: cents(690),
      currency: 'USD',
      merchantCategoryCode: '5734',
      revisitOn: '2027-01-31',
    },
  })
  assert.ok(!JSON.stringify(proposal).includes('pre-approved'))

  // What the note asks for: annual at $6,789.60, or a $10,000 limit. Neither can be approved, because the
  // approval must match the fingerprint of the terms the policy produced.
  const action = proposal.action as Extract<Action, { kind: 'update_card' }>
  const demands: Action[] = [
    { ...action, terms: { ...action.terms, plan: 'annual', amount: cents(6_789.6) } },
    { ...action, terms: { ...action.terms, amount: cents(10_000) } },
  ]
  for (const demand of demands) {
    await assert.rejects(approve(store, ctx, proposal.id, fingerprint(demand)), { code: 'fingerprint_mismatch' })
  }
  assert.equal((await store.get(proposal.id))!.status, 'pending')
})
