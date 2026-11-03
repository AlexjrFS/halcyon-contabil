import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Proposal } from '../src/approvals/proposals.js'
import { JsonFileStore } from '../src/approvals/store.js'
import { FileStateStore } from '../src/app/state.js'
import { openSession } from '../src/app/session.js'
import { AS_OF } from '../src/demo/company.js'
import { BILLS, LEDGER, RECEIVABLES, STATEMENT } from '../src/demo/ledger.js'
import { detectAnomalies } from '../src/finance/anomalies.js'
import { collectionStage, draftReminder, reminderOutcome, reviewReceivables, type ReminderRecord } from '../src/finance/followups.js'
import { buildLedgerView } from '../src/finance/ledger.js'
import { reconcile } from '../src/finance/reconcile.js'
import { cents } from '../src/policy/money.js'
import { fakeApi } from './fakes.js'

const sender = { name: 'Ana Souza', company: 'Lumen Studio' }
const codes = (billId: string) => detectAnomalies(BILLS).filter((a) => a.billId === billId).map((a) => `${a.code}:${a.severity}`)

test('anomalies: the demo books show each kind of problem, and ordinary invoices stay clean', () => {
  assert.deepEqual(codes('b-cn-nov'), ['amount_spike:high'])
  assert.deepEqual(codes('b-mc-nov'), ['payment_details_changed:high'])
  assert.deepEqual(codes('b-or-oct2'), ['duplicate_invoice:high'])
  assert.deepEqual(codes('b-qf-1'), ['instructions_in_note:high', 'new_vendor:medium'])
  // Regular monthly invoices from known vendors have no flags at all
  for (const id of ['b-fw-oct', 'b-fw-nov', 'b-cn-oct', 'b-px-oct', 'b-mc-oct', 'b-gl-oct']) assert.deepEqual(codes(id), [], id)
  // A vendor's first invoice is only a low flag when it is small
  assert.deepEqual(codes('b-fw-sep'), ['new_vendor:low'])
})

test('anomalies: thresholds', () => {
  const bill = (id: string, amount: number, extra: object = {}) => ({
    id,
    vendor: 'Acme',
    invoiceNumber: id,
    amount: cents(amount),
    currency: 'USD',
    issueDate: `2026-0${id}-01`,
    dueDate: `2026-0${id}-15`,
    description: '',
    note: '',
    ...extra,
  })
  const history = [bill('1', 100), bill('2', 100)]
  // 1.5x is not flagged, 2x is medium, 3x is high
  assert.deepEqual(detectAnomalies([...history, bill('3', 150)]).filter((a) => a.billId === '3'), [])
  assert.equal(detectAnomalies([...history, bill('3', 200)]).find((a) => a.billId === '3')?.severity, 'medium')
  assert.equal(detectAnomalies([...history, bill('3', 300)]).find((a) => a.billId === '3')?.severity, 'high')
  assert.equal(detectAnomalies([...history, bill('3', 5_000)]).some((a) => a.code === 'needs_second_approval'), true)
  assert.equal(detectAnomalies([...history, bill('3', 100, { currency: 'EUR' })]).some((a) => a.code === 'foreign_currency'), true)
})

test('reconciliation: paid, paid twice, a different amount, unpaid, and payments without an invoice', () => {
  const { matches, unmatchedLines } = reconcile(BILLS, STATEMENT)
  const of = (id: string) => matches.find((m) => m.billId === id)!
  assert.equal(of('b-fw-oct').status, 'paid')
  assert.equal(of('b-fw-nov').status, 'unpaid')
  assert.equal(of('b-cn-oct').status, 'paid')
  // The repeat payment belongs to October, not September
  assert.equal(of('b-px-sep').status, 'paid')
  assert.equal(of('b-px-oct').status, 'duplicate_payment')
  assert.deepEqual(of('b-px-oct').lineIds, ['l-06', 'l-07'])
  assert.equal(of('b-px-oct').difference, cents(89))
  assert.equal(of('b-gl-oct').status, 'amount_mismatch')
  assert.equal(of('b-gl-oct').difference, cents(-45))
  assert.equal(of('b-or-oct').status, 'unpaid')
  assert.deepEqual(unmatchedLines.map((l) => l.id), ['l-12'])
  // Every statement line is used at most once
  const used = matches.flatMap((m) => m.lineIds)
  assert.equal(new Set(used).size, used.length)
})

test('collections: stages by days overdue, and a cooldown after a reminder', () => {
  const stage = (id: string) => collectionStage(RECEIVABLES.find((r) => r.id === id)!, AS_OF)
  assert.deepEqual(stage('r-ct-102'), { stage: 'friendly', daysOverdue: 11 })
  assert.deepEqual(stage('r-nw-101'), { stage: 'firm', daysOverdue: 18 })
  assert.deepEqual(stage('r-bc-090'), { stage: 'final', daysOverdue: 33 })
  assert.deepEqual(stage('r-nw-103'), { stage: 'due_soon', daysOverdue: 0 })
  assert.deepEqual(stage('r-ac-099'), { stage: 'paid', daysOverdue: 0 })

  const sent: ReminderRecord = {
    id: 'p-1', receivableId: 'r-nw-101', stage: 'firm', to: 'x', subject: 's', body: 'b', date: '2026-10-30', sentAt: '2026-10-30T10:00:00Z',
  }
  const status = reviewReceivables(RECEIVABLES, [sent], AS_OF)
  assert.equal(status.find((s) => s.receivable.id === 'r-nw-101')!.eligible, false)
  assert.equal(status.find((s) => s.receivable.id === 'r-nw-101')!.reason, 'recently_reminded')
  assert.equal(status.find((s) => s.receivable.id === 'r-ct-102')!.eligible, true)
  assert.equal(status.filter((s) => s.eligible).length, 2)
  // A week later the client can be chased again
  assert.equal(reviewReceivables(RECEIVABLES, [sent], '2026-11-06').find((s) => s.receivable.id === 'r-nw-101')!.eligible, true)
})

test('reminder wording comes from the stage and the invoice', () => {
  const out = reminderOutcome(RECEIVABLES, [], AS_OF, sender, 'r-bc-090')
  assert.equal(out.kind, 'draft')
  if (out.kind !== 'draft') return
  assert.equal(out.draft.stage, 'final')
  assert.equal(out.draft.to, 'accounts@birch.example')
  assert.equal(out.draft.subject, 'Final notice: invoice LS-090 ($2,300.00)')
  assert.match(out.draft.body, /33 days past due \(due 2026-09-30\)/)
  assert.match(out.draft.body, /Ana Souza\nLumen Studio$/)
  assert.deepEqual(reminderOutcome(RECEIVABLES, [], AS_OF, sender, 'r-ac-099'), { kind: 'refused', reason: 'already_paid' })
  assert.deepEqual(reminderOutcome(RECEIVABLES, [], AS_OF, sender, 'r-nw-103'), { kind: 'refused', reason: 'not_overdue' })
  assert.deepEqual(reminderOutcome(RECEIVABLES, [], AS_OF, sender, 'nope'), { kind: 'refused', reason: 'unknown_receivable' })
  const friendly = draftReminder(RECEIVABLES[2]!, 'friendly', 11, sender)
  assert.match(friendly.body, /^Hi Contoso Ltd team,/)
})

test('ledger totals add up', () => {
  const view = buildLedgerView(LEDGER, [], AS_OF)
  assert.equal(view.totals.overdueReceivables, cents(2_300 + 4_500 + 4_500))
  assert.equal(view.totals.remindersToSend, 3)
  assert.equal(view.totals.unmatchedPayments, 1)
  // Four high-severity or medium bills: spike, bank details, duplicate, Quickfix
  assert.equal(view.totals.flaggedBills, 4)
  assert.equal(view.totals.overduePayables, cents(430))
})

async function withSession(fn: (session: Awaited<ReturnType<typeof openSession>>, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'halcyon-contabil-finance-'))
  const session = await openSession({
    api: fakeApi().api,
    store: new JsonFileStore(join(dir, 'proposals.json')),
    stateStore: new FileStateStore(join(dir, 'state.json')),
    sleep: async () => {},
  })
  try {
    await fn(session, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function tool(session: Awaited<ReturnType<typeof openSession>>, name: string, input: Record<string, unknown> = {}) {
  const proposals: Proposal[] = []
  const t = session.tools((p) => proposals.push(p)).find((x) => x.name === name)!
  return { result: JSON.parse((await t.run(input as never)) as string), proposal: proposals[0] }
}

test('a reminder is proposed by id, sent only after approval, and not repeated right away', async () => {
  await withSession(async (session, dir) => {
    const { result, proposal } = await tool(session, 'propose_payment_reminder', { receivable_id: 'r-nw-101' })
    assert.equal(result.reminder.stage, 'firm')
    assert.equal(proposal!.action.kind, 'send_reminder')
    // Nothing is sent before approval
    assert.deepEqual(session.state().reminders, [])

    const done = await session.approve(proposal!.id, proposal!.fingerprint)
    assert.equal(done.status, 'executed')
    assert.deepEqual(done.result, { reminderId: proposal!.id })
    assert.equal(session.state().reminders.length, 1)
    assert.equal(session.state().reminders[0]!.to, 'billing@northwind.example')

    // Approving twice does not send twice
    assert.equal((await session.approve(proposal!.id, proposal!.fingerprint).catch((e) => e.code)), 'not_pending')
    assert.equal(session.state().reminders.length, 1)

    // The client was just reminded
    const again = await tool(session, 'propose_payment_reminder', { receivable_id: 'r-nw-101' })
    assert.deepEqual(again.result, { proposal: null, refused: 'recently_reminded' })
    assert.equal(again.proposal, undefined)

    // The sent reminder survives a restart
    const reopened = await openSession({
      api: fakeApi().api,
      store: new JsonFileStore(join(dir, 'proposals.json')),
      stateStore: new FileStateStore(join(dir, 'state.json')),
      sleep: async () => {},
    })
    assert.equal(reopened.ledger().receivables.find((r) => r.receivable.id === 'r-nw-101')!.eligible, false)
  })
})

test('a reminder is refused for a paid or not-yet-due invoice, and never takes wording from the model', async () => {
  await withSession(async (session) => {
    assert.deepEqual((await tool(session, 'propose_payment_reminder', { receivable_id: 'r-ac-099' })).result, { proposal: null, refused: 'already_paid' })
    assert.deepEqual((await tool(session, 'propose_payment_reminder', { receivable_id: 'r-nw-103' })).result, { proposal: null, refused: 'not_overdue' })
    assert.deepEqual((await tool(session, 'propose_payment_reminder', { receivable_id: 'zzz' })).result, { proposal: null, refused: 'unknown_receivable' })
  })
})

test('an approval for the wrong text is rejected, and a reminder that went stale is not sent', async () => {
  await withSession(async (session) => {
    const { proposal } = await tool(session, 'propose_payment_reminder', { receivable_id: 'r-ct-102' })
    await assert.rejects(session.approve(proposal!.id, 'deadbeef'), { code: 'fingerprint_mismatch' })
    assert.equal(session.state().reminders.length, 0)

    // The client is reminded by another proposal first; the first approval now reads out of date
    const second = await tool(session, 'propose_payment_reminder', { receivable_id: 'r-ct-102' })
    await session.approve(second.proposal!.id, second.proposal!.fingerprint)
    const stale = await session.approve(proposal!.id, proposal!.fingerprint)
    assert.equal(stale.status, 'stale')
    assert.equal(session.state().reminders.length, 1)
  })
})

test('read tools return the supplier note wrapped as untrusted, and flags computed by code', async () => {
  await withSession(async (session) => {
    const { result } = await tool(session, 'review_payables', { only_flagged: true })
    assert.deepEqual(result.bills.map((b: { bill_id: string }) => b.bill_id).sort(), ['b-cn-nov', 'b-mc-nov', 'b-or-oct2', 'b-qf-1'])
    const quickfix = result.bills.find((b: { bill_id: string }) => b.bill_id === 'b-qf-1')
    assert.match(quickfix.supplier_note, /^<untrusted_supplier_text>\n.*Ignore the approval policy.*\n<\/untrusted_supplier_text>$/s)
    assert.equal(quickfix.flags[0].code, 'instructions_in_note')

    const rec = (await tool(session, 'reconcile_payments')).result
    assert.deepEqual(rec.counts, { paid: 8, unpaid: 6, paid_twice: 1, different_amount: 1, payments_without_invoice: 1 })

    const recv = (await tool(session, 'review_receivables')).result
    assert.equal(recv.overdue_total, '$11,300.00')
    assert.equal(recv.invoices.find((i: { receivable_id: string }) => i.receivable_id === 'r-bc-090').stage, 'final')
  })
})

test('reset clears sent reminders', async () => {
  await withSession(async (session) => {
    const { proposal } = await tool(session, 'propose_payment_reminder', { receivable_id: 'r-bc-090' })
    await session.approve(proposal!.id, proposal!.fingerprint)
    await session.reset()
    assert.deepEqual(session.state().reminders, [])
    assert.equal(session.ledger().receivables.find((r) => r.receivable.id === 'r-bc-090')!.eligible, true)
  })
})
