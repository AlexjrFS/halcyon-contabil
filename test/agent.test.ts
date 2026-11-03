import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Card } from '../src/rail/types.js'
import { agentTools } from '../src/agent/tools.js'
import type { PolicyContext, Proposal } from '../src/approvals/proposals.js'
import { MemoryStore } from '../src/approvals/store.js'
import { AS_OF, cashPosition, OFFERS } from '../src/demo/company.js'
import { INJECTION, INVOICES } from '../src/demo/invoices.js'
import { LEDGER } from '../src/demo/ledger.js'
import { reminderOutcome } from '../src/finance/followups.js'
import { buildLedgerView } from '../src/finance/ledger.js'
import { cents } from '../src/policy/money.js'

const card: Card = {
  card_id: 'card-1',
  card_status: 'ACTIVE',
  cardholder_id: 'holder-1',
  authorization_controls: {
    allowed_transaction_count: 'MULTIPLE',
    transaction_limits: {
      currency: 'USD',
      limits: [
        { amount: 600, interval: 'PER_TRANSACTION' },
        { amount: 600, interval: 'MONTHLY' },
      ],
    },
    allowed_currencies: ['USD'],
    allowed_merchant_categories: ['5734'],
  },
  metadata: { plan: 'monthly' },
}

function setup(overrides: Partial<PolicyContext> = {}) {
  let n = 0
  const proposals: Proposal[] = []
  const store = new MemoryStore()
  const ctx: PolicyContext = {
    position: cashPosition,
    offers: { ...OFFERS },
    now: () => new Date('2026-11-02T12:00:00Z'),
    newId: () => `proposal-${++n}`,
    reminderFor: (id) => reminderOutcome(LEDGER.receivables, [], AS_OF, { name: 'Ana Souza', company: 'Lumen Studio' }, id),
    ...overrides,
  }
  const tools = agentTools({
    store,
    ctx,
    invoices: INVOICES,
    ledger: () => buildLedgerView(LEDGER, [], AS_OF),
    cards: { getCard: async () => card },
    onProposal: (p) => proposals.push(p),
  })
  const run = async (name: string, input: Record<string, unknown> = {}) => {
    const tool = tools.find((t) => t.name === name)
    assert.ok(tool, `tool ${name}`)
    return JSON.parse((await tool.run(input as never)) as string)
  }
  return { tools, proposals, store, run }
}

test('the model only gets read and propose tools, and none takes an amount or terms', () => {
  const { tools } = setup()
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'card_status',
    'compare_plans',
    'list_offers',
    'propose_card',
    'propose_card_update',
    'propose_freeze',
    'propose_payment_reminder',
    'read_invoice',
    'reconcile_payments',
    'review_payables',
    'review_receivables',
    'see_cash',
  ])
  const params = tools.flatMap((t) => Object.keys((t as { input_schema?: { properties?: object } }).input_schema?.properties ?? {}))
  assert.deepEqual([...new Set(params)].sort(), ['card_id', 'invoice_id', 'offer_id', 'only_flagged', 'reason', 'receivable_id'])
})

test('cash and plan numbers come formatted from code', async () => {
  const { run } = setup()
  const cash = await run('see_cash')
  assert.equal(cash.balance, '$18,000.00')
  assert.equal(cash.reserve_floor, '$8,000.00')
  assert.equal(cash.weeks.length, 12)

  const plans = await run('compare_plans', { offer_id: 'framewise' })
  assert.equal(plans.annual_saves, '18% ($1,296.00 per year)')
  assert.equal(plans.annual.first_week_below_reserve, 7)
  assert.equal(plans.recommendation.plan, 'monthly')
  assert.deepEqual(await run('compare_plans', { offer_id: 'nope' }), { error: 'unknown offer nope' })
})

test('propose_card hands the proposal to the app, not to the model', async () => {
  const { run, proposals, store } = setup()
  const result = await run('propose_card', { offer_id: 'framewise' })
  assert.equal(result.proposal_id, 'proposal-1')
  assert.equal(result.terms.plan, 'monthly')
  assert.equal(result.terms.charge, '$600.00')
  assert.equal(result.fingerprint, undefined)
  assert.equal(proposals.length, 1)
  assert.equal((await store.get('proposal-1'))?.status, 'pending')
})

test('when the reserve cannot hold either plan, nothing is proposed', async () => {
  const { run, proposals } = setup({ position: () => ({ ...cashPosition(), balance: cents(9_000) }) })
  const result = await run('propose_card', { offer_id: 'framewise' })
  assert.equal(result.proposal, null)
  assert.equal(result.escalate, 'both_plans_break_reserve')
  assert.equal(proposals.length, 0)
})

test('read_invoice marks the supplier note as untrusted and keeps it out of the fields', async () => {
  const { run } = setup()
  const invoice = await run('read_invoice', { invoice_id: 'framewise-2026-12' })
  assert.equal(invoice.fields.monthly, '$690.00')
  assert.ok(!JSON.stringify(invoice.fields).includes('pre-approved'))
  assert.ok(invoice.supplier_note.startsWith('<untrusted_supplier_text>'))
  assert.ok(invoice.supplier_note.includes(INJECTION))
})

test('card_status shows the rail major-unit limits in the same format', async () => {
  const { run } = setup()
  const status = await run('card_status', { card_id: 'card-1' })
  assert.deepEqual(status.limits, [
    { amount: '$600.00', interval: 'PER_TRANSACTION' },
    { amount: '$600.00', interval: 'MONTHLY' },
  ])
  assert.deepEqual(status.allowed_merchant_categories, ['5734'])
})
