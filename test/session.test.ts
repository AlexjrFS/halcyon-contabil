import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Proposal } from '../src/approvals/proposals.js'
import { JsonFileStore } from '../src/approvals/store.js'
import { FileStateStore } from '../src/app/state.js'
import { openSession, type SessionApi } from '../src/app/session.js'
import { fakeApi } from './fakes.js'
import { PRICE_INCREASE } from '../src/demo/invoices.js'
import { cents } from '../src/policy/money.js'

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'halcyon-contabil-session-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const open = (dir: string, api: SessionApi) =>
  openSession({
    api,
    store: new JsonFileStore(join(dir, 'proposals.json')),
    stateStore: new FileStateStore(join(dir, 'state.json')),
    sleep: async () => {},
  })

async function proposeVia(session: Awaited<ReturnType<typeof open>>, tool: string, input: Record<string, unknown>) {
  const proposals: Proposal[] = []
  const t = session.tools((p) => proposals.push(p)).find((x) => x.name === tool)!
  const result = JSON.parse((await t.run(input as never)) as string)
  return { result, proposal: proposals[0] }
}

test('the cardholder is created on the first card, once, using pass_review when needed', async () => {
  await withDir(async (dir) => {
    const { api, calls } = fakeApi('PENDING')
    const first = await open(dir, api)
    assert.equal(calls.holders, 0)
    const { proposal } = await proposeVia(first, 'propose_card', { offer_id: 'framewise' })
    await first.approve(proposal!.id, proposal!.fingerprint)
    assert.equal(calls.holders, 1)
    assert.equal(calls.reviews, 1)
    await open(dir, api)
    assert.equal(calls.holders, 1)
  })
})

test('approving issues the card, records it, and the agent then sees it', async () => {
  await withDir(async (dir) => {
    const { api } = fakeApi()
    const session = await open(dir, api)
    assert.match(session.context(), /No cards have been issued yet/)

    const { proposal } = await proposeVia(session, 'propose_card', { offer_id: 'framewise' })
    const executed = await session.approve(proposal!.id, proposal!.fingerprint)
    assert.equal(executed.status, 'executed')
    assert.deepEqual(session.state().cards.framewise, { cardId: 'card-1', plan: 'monthly', proposalId: proposal!.id })
    assert.match(session.context(), /card-1, monthly plan/)

    const again = await proposeVia(session, 'propose_card', { offer_id: 'framewise' })
    assert.match(again.result.error, /already exists/)
    assert.equal(again.proposal, undefined)
  })
})

test('a restart keeps the card, the cardholder and the prices from received invoices', async () => {
  await withDir(async (dir) => {
    const { api, calls } = fakeApi()
    const first = await open(dir, api)
    const { proposal } = await proposeVia(first, 'propose_card', { offer_id: 'framewise' })
    await first.approve(proposal!.id, proposal!.fingerprint)
    assert.equal((await first.receiveInvoice(PRICE_INCREASE.id)).kind, 'updated')
    assert.match(first.context(), /Supplier invoice received: "framewise-2026-12" from Framewise Inc\./)

    const second = await open(dir, api)
    assert.equal(calls.holders, 1)
    assert.equal(second.ctx.offers.framewise!.monthlyPrice, cents(690))
    const update = await proposeVia(second, 'propose_card_update', { card_id: 'card-1', offer_id: 'framewise' })
    assert.equal(update.result.terms.charge, '$690.00')
    assert.equal((await second.approve(update.proposal!.id, update.proposal!.fingerprint)).status, 'executed')
    assert.equal(calls.updates, 1)
  })
})

test('an update must target the card issued for that offer', async () => {
  await withDir(async (dir) => {
    const { api } = fakeApi()
    const session = await open(dir, api)
    const { proposal } = await proposeVia(session, 'propose_card', { offer_id: 'framewise' })
    await session.approve(proposal!.id, proposal!.fingerprint)
    const wrong = await proposeVia(session, 'propose_card_update', { card_id: 'card-999', offer_id: 'framewise' })
    assert.match(wrong.result.error, /not the card issued/)
    assert.equal(wrong.proposal, undefined)
  })
})

test('a simulated charge uses the card, the offer currency and category, in major units', async () => {
  await withDir(async (dir) => {
    const { api, calls } = fakeApi()
    const session = await open(dir, api)
    assert.throws(() => session.simulateCharge('framewise', { amount: cents(600) }), /No card/)
    const { proposal } = await proposeVia(session, 'propose_card', { offer_id: 'framewise' })
    await session.approve(proposal!.id, proposal!.fingerprint)
    await session.simulateCharge('framewise', { amount: cents(5_904) })
    assert.deepEqual(calls.simulations[0], {
      card_id: 'card-1',
      transaction_amount: 5904,
      transaction_currency: 'USD',
      merchant_category_code: '5734',
      merchant_info: 'Framewise Inc.',
      single_phase: true,
    })
  })
})

test('reset forgets proposals, cards and invoices but keeps the cardholder', async () => {
  await withDir(async (dir) => {
    const { api, calls } = fakeApi()
    const session = await open(dir, api)
    const { proposal } = await proposeVia(session, 'propose_card', { offer_id: 'framewise' })
    await session.approve(proposal!.id, proposal!.fingerprint)
    await session.receiveInvoice(PRICE_INCREASE.id)
    await session.reset()
    assert.deepEqual(session.state(), { cardholderId: 'holder-1', cards: {}, invoices: [], reminders: [] })
    assert.equal(session.ctx.offers.framewise!.monthlyPrice, cents(600))
    assert.deepEqual(await session.store.list(), [])
    await open(dir, api)
    assert.equal(calls.holders, 1)
  })
})
