import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { RailError, type Card, type CreateCardInput, type UpdateCardInput } from '../src/rail/types.js'
import { createExecutor, type CardApi } from '../src/approvals/executor.js'
import {
  approve,
  fingerprint,
  PROPOSAL_TTL_MS,
  proposeCard,
  proposeCardUpdate,
  proposeFreeze,
  reject,
  type Action,
  type PolicyContext,
  type Proposal,
} from '../src/approvals/proposals.js'
import { JsonFileStore, MemoryStore } from '../src/approvals/store.js'
import { cashPosition, OFFERS, SAAS_OFFER } from '../src/demo/company.js'
import { cardRequest } from '../src/policy/card.js'
import { cents } from '../src/policy/money.js'

const T0 = new Date('2026-11-02T12:00:00Z')

function setup(overrides: Partial<PolicyContext> = {}) {
  let n = 0
  let now = T0
  const ctx: PolicyContext = {
    position: cashPosition,
    offers: { ...OFFERS },
    now: () => now,
    newId: () => `proposal-${++n}`,
    ...overrides,
  }
  return { ctx, store: new MemoryStore(), advance: (ms: number) => void (now = new Date(now.getTime() + ms)) }
}

// Fake card API: records calls; `fail` lets a test make the next calls throw
function fakeCards() {
  const created: CreateCardInput[] = []
  const updated: { id: string; input: UpdateCardInput }[] = []
  const cards = new Map<string, Card>()
  const fail: { create?: unknown } = {}
  const api: CardApi = {
    async createCard(input) {
      if (fail.create) throw fail.create
      created.push(input)
      const card: Card = {
        card_id: `card-${created.length}`,
        card_status: 'ACTIVE',
        cardholder_id: input.cardholder_id,
        metadata: input.metadata,
      }
      cards.set(card.card_id, card)
      return card
    },
    async getCard(id) {
      return cards.get(id)!
    },
    async updateCard(id, input) {
      updated.push({ id, input })
      return cards.get(id)!
    },
    async listCards() {
      // Like the real API: list items carry no metadata
      return { items: [...cards.values()].map(({ metadata: _, ...c }) => c), has_more: false }
    },
  }
  return { api, created, updated, cards, fail }
}

async function approvedCardProposal() {
  const env = setup()
  const result = await proposeCard(env.store, env.ctx, 'framewise')
  assert.equal(result.kind, 'proposal')
  const proposal = (result as { proposal: Proposal }).proposal
  await approve(env.store, env.ctx, proposal.id, proposal.fingerprint)
  const fake = fakeCards()
  const executor = createExecutor({ store: env.store, cards: fake.api, ctx: env.ctx, cardholderId: 'holder-1', createdBy: 'Ana Souza' })
  return { ...env, proposal, fake, executor }
}

test('a card proposal takes its terms from the policy, not from the caller', async () => {
  const { store, ctx } = setup()
  const result = await proposeCard(store, ctx, 'framewise')
  assert.equal(result.kind, 'proposal')
  const { proposal } = result as { proposal: Proposal }
  assert.deepEqual(proposal.action, {
    kind: 'issue_card',
    offerId: 'framewise',
    terms: {
      vendor: 'Framewise Inc.',
      product: 'Framewise Team',
      plan: 'monthly',
      amount: cents(600),
      currency: 'USD',
      merchantCategoryCode: '5734',
      revisitOn: '2027-01-31',
    },
  })
  assert.equal(proposal.status, 'pending')
  assert.equal(proposal.expiresAt, new Date(T0.getTime() + PROPOSAL_TTL_MS).toISOString())
  assert.deepEqual(await store.get(proposal.id), proposal)
})

test('when both plans break the reserve there is nothing to approve', async () => {
  const { store, ctx } = setup({ position: () => ({ ...cashPosition(), balance: cents(9_000) }) })
  const result = await proposeCard(store, ctx, 'framewise')
  assert.equal(result.kind, 'escalate')
  assert.deepEqual(await store.list(), [])
})

test('unknown offers are refused', async () => {
  const { store, ctx } = setup()
  await assert.rejects(proposeCard(store, ctx, 'nope'), { code: 'unknown_offer' })
})

test('the fingerprint covers amount, currency, merchant category and merchant', () => {
  const action: Action = {
    kind: 'issue_card',
    offerId: 'framewise',
    terms: {
      vendor: 'Framewise Inc.',
      product: 'Framewise Team',
      plan: 'monthly',
      amount: cents(600),
      currency: 'USD',
      merchantCategoryCode: '5734',
      revisitOn: null,
    },
  }
  const base = fingerprint(action)
  const reordered = { terms: { ...action.terms }, offerId: action.offerId, kind: action.kind } as Action
  assert.equal(fingerprint(reordered), base)
  for (const change of [{ amount: cents(601) }, { currency: 'EUR' }, { merchantCategoryCode: '5812' }, { vendor: 'Other Inc.' }]) {
    assert.notEqual(fingerprint({ ...action, terms: { ...action.terms, ...change } }), base, JSON.stringify(change))
  }
})

test('approval must match the terms that were shown', async () => {
  const { store, ctx } = setup()
  const { proposal } = (await proposeCard(store, ctx, 'framewise')) as { proposal: Proposal }
  await assert.rejects(approve(store, ctx, proposal.id, 'something-else'), { code: 'fingerprint_mismatch' })
  assert.equal((await store.get(proposal.id))!.status, 'pending')
  const approved = await approve(store, ctx, proposal.id, proposal.fingerprint)
  assert.equal(approved.status, 'approved')
  await assert.rejects(approve(store, ctx, proposal.id, proposal.fingerprint), { code: 'not_pending' })
})

test('an expired proposal cannot be approved', async () => {
  const { store, ctx, advance } = setup()
  const { proposal } = (await proposeCard(store, ctx, 'framewise')) as { proposal: Proposal }
  advance(PROPOSAL_TTL_MS + 1)
  await assert.rejects(approve(store, ctx, proposal.id, proposal.fingerprint), { code: 'expired' })
  assert.equal((await store.get(proposal.id))!.status, 'expired')
})

test('a pending or rejected proposal never reaches the rail', async () => {
  const { store, ctx } = setup()
  const { proposal } = (await proposeCard(store, ctx, 'framewise')) as { proposal: Proposal }
  const fake = fakeCards()
  const executor = createExecutor({ store, cards: fake.api, ctx, cardholderId: 'holder-1', createdBy: 'Ana Souza' })
  await assert.rejects(executor.execute(proposal.id), { code: 'not_approved' })
  await reject(store, ctx, proposal.id)
  await assert.rejects(executor.execute(proposal.id), { code: 'not_approved' })
  assert.equal(fake.created.length, 0)
})

test('executing creates one card with the proposal id as request_id, and repeats are free', async () => {
  const { proposal, fake, executor } = await approvedCardProposal()
  const [a, b] = await Promise.all([executor.execute(proposal.id), executor.execute(proposal.id)])
  const again = await executor.execute(proposal.id)
  assert.equal(fake.created.length, 1)
  const request = fake.created[0]!
  assert.equal(request.request_id, proposal.id)
  assert.equal(request.metadata?.decision_id, proposal.id)
  assert.deepEqual(request.authorization_controls.transaction_limits.limits, [
    { amount: 600, interval: 'PER_TRANSACTION' },
    { amount: 600, interval: 'MONTHLY' },
  ])
  for (const p of [a, b, again]) {
    assert.equal(p.status, 'executed')
    assert.deepEqual(p.result, { cardId: 'card-1' })
  }
})

test('if the offer changes after approval the proposal goes stale instead of running', async () => {
  const { proposal, fake, executor, ctx, store } = await approvedCardProposal()
  ctx.offers.framewise = { ...SAAS_OFFER, monthlyPrice: cents(690) }
  const result = await executor.execute(proposal.id)
  assert.equal(result.status, 'stale')
  assert.equal(fake.created.length, 0)
  await assert.rejects(executor.execute(proposal.id), { code: 'not_approved' })
  assert.equal((await store.get(proposal.id))!.status, 'stale')
})

test('a failed run can be retried and keeps its request_id', async () => {
  const { proposal, fake, executor } = await approvedCardProposal()
  fake.fail.create = new RailError(503, 'service_unavailable', 'try later')
  const failed = await executor.execute(proposal.id)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error?.code, 'service_unavailable')

  delete fake.fail.create
  const retried = await executor.execute(proposal.id)
  assert.equal(retried.status, 'executed')
  assert.equal(retried.attempts, 2)
  assert.equal(retried.error, undefined)
  assert.equal(fake.created[0]!.request_id, proposal.id)
})

test('a retry after the card was already created finds it instead of creating another', async () => {
  const { proposal, fake, executor, store } = await approvedCardProposal()
  // The first call reached the rail but the process stopped before saving the result
  await fake.api.createCard(cardRequest({ id: proposal.id, plan: 'monthly', offer: SAAS_OFFER, revisitOn: null }, 'holder-1', 'Ana Souza'))
  await store.save({ ...(await store.get(proposal.id))!, status: 'executing' })
  fake.fail.create = new RailError(400, 'duplicate_request_id', 'This request_id was already used')
  const result = await executor.execute(proposal.id)
  assert.equal(result.status, 'executed')
  assert.deepEqual(result.result, { cardId: 'card-1' })
  assert.equal(fake.created.length, 1)
})

test('a price increase needs its own approval, then resends the full controls', async () => {
  const env = setup()
  env.ctx.offers.framewise = { ...SAAS_OFFER, monthlyPrice: cents(690) }
  const result = await proposeCardUpdate(env.store, env.ctx, 'card-1', 'framewise')
  const { proposal } = result as { proposal: Proposal }
  assert.equal(proposal.action.kind, 'update_card')
  assert.equal((proposal.action as { terms: { amount: number } }).terms.amount, cents(690))

  const fake = fakeCards()
  const executor = createExecutor({ store: env.store, cards: fake.api, ctx: env.ctx, cardholderId: 'holder-1', createdBy: 'Ana Souza' })
  await assert.rejects(executor.execute(proposal.id), { code: 'not_approved' })
  await approve(env.store, env.ctx, proposal.id, proposal.fingerprint)
  await executor.execute(proposal.id)
  assert.equal(fake.updated.length, 1)
  assert.deepEqual(fake.updated[0], {
    id: 'card-1',
    input: {
      authorization_controls: {
        transaction_limits: {
          currency: 'USD',
          limits: [
            { amount: 690, interval: 'PER_TRANSACTION' },
            { amount: 690, interval: 'MONTHLY' },
          ],
          cash_withdrawal_limits: [],
        },
        allowed_currencies: ['USD'],
        allowed_merchant_categories: ['5734'],
      },
    },
  })
})

test('freezing a card is a proposal too', async () => {
  const env = setup()
  const proposal = await proposeFreeze(env.store, env.ctx, 'card-1', 'Suspicious invoice')
  await approve(env.store, env.ctx, proposal.id, proposal.fingerprint)
  const fake = fakeCards()
  const executor = createExecutor({ store: env.store, cards: fake.api, ctx: env.ctx, cardholderId: 'holder-1', createdBy: 'Ana Souza' })
  await executor.execute(proposal.id)
  assert.deepEqual(fake.updated, [{ id: 'card-1', input: { card_status: 'INACTIVE' } }])
})

test('the JSON store keeps proposals across instances and serializes writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'halcyon-contabil-'))
  try {
    const path = join(dir, 'nested', 'proposals.json')
    const first = new JsonFileStore(path)
    const { ctx } = setup()
    const results = await Promise.all([1, 2, 3].map(() => proposeCard(first, ctx, 'framewise')))
    const ids = results.map((r) => (r as { proposal: Proposal }).proposal.id)
    const second = new JsonFileStore(path)
    assert.deepEqual((await second.list()).map((p) => p.id).sort(), [...ids].sort())
    assert.equal((await second.get(ids[0]!))?.status, 'pending')
    assert.equal(await second.get('missing'), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an update that would switch the plan needs a new card, not an update', async () => {
  const env = setup()
  const result = await proposeCardUpdate(env.store, env.ctx, 'card-1', 'framewise', 'annual')
  assert.equal(result.kind, 'escalate')
  assert.equal((result as { reason: string }).reason, 'plan_change_needs_new_card')
  assert.deepEqual(await env.store.list(), [])
})
