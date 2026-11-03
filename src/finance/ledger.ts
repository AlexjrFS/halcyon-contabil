// The finance picture in one place: payables with their flags and payment status, payments nobody asked for,
// and client invoices to chase. The API and the agent's read tools both return this, so they always agree.
import { daysBetween, type Cents } from '../policy/money.js'
import { detectAnomalies, type Anomaly } from './anomalies.js'
import { reviewReceivables, type ReceivableStatus, type ReminderRecord } from './followups.js'
import { reconcile, type BillMatch } from './reconcile.js'
import type { Bill, LedgerData, StatementLine } from './types.js'

export type DueStatus = 'settled' | 'overdue' | 'due_soon' | 'upcoming'

export interface PayableView {
  bill: Bill
  payment: BillMatch
  due: DueStatus
  daysOverdue: number
  flags: Anomaly[]
}

export interface LedgerView {
  asOf: string
  payables: PayableView[]
  unmatchedLines: StatementLine[]
  receivables: ReceivableStatus[]
  reminders: ReminderRecord[]
  totals: {
    unpaidPayables: Cents
    overduePayables: Cents
    flaggedBills: number
    unmatchedPayments: number
    overdueReceivables: Cents
    remindersToSend: number
  }
}

const DUE_SOON_DAYS = 7

export function buildLedgerView(data: LedgerData, reminders: ReminderRecord[], asOf: string): LedgerView {
  const { matches, unmatchedLines } = reconcile(data.bills, data.statement)
  const flags = detectAnomalies(data.bills)

  const payables = data.bills
    .map((bill): PayableView => {
      const payment = matches.find((m) => m.billId === bill.id)!
      const open = payment.status === 'unpaid'
      const daysOverdue = open ? Math.max(0, daysBetween(bill.dueDate, asOf)) : 0
      const due: DueStatus = !open
        ? 'settled'
        : daysOverdue > 0
          ? 'overdue'
          : daysBetween(asOf, bill.dueDate) <= DUE_SOON_DAYS
            ? 'due_soon'
            : 'upcoming'
      return { bill, payment, due, daysOverdue, flags: flags.filter((f) => f.billId === bill.id) }
    })
    .sort((a, b) => (a.bill.dueDate === b.bill.dueDate ? (a.bill.id < b.bill.id ? -1 : 1) : a.bill.dueDate < b.bill.dueDate ? 1 : -1))

  const receivables = reviewReceivables(data.receivables, reminders, asOf)
  const sum = (items: PayableView[]) => items.reduce((total, p) => total + p.bill.amount, 0)

  return {
    asOf,
    payables,
    unmatchedLines,
    receivables,
    reminders,
    totals: {
      unpaidPayables: sum(payables.filter((p) => p.payment.status === 'unpaid')),
      overduePayables: sum(payables.filter((p) => p.due === 'overdue')),
      flaggedBills: payables.filter((p) => p.flags.some((f) => f.severity !== 'low')).length,
      unmatchedPayments: unmatchedLines.length,
      overdueReceivables: receivables
        .filter((r) => r.daysOverdue > 0 && r.stage !== 'paid')
        .reduce((total, r) => total + r.receivable.amount, 0),
      remindersToSend: receivables.filter((r) => r.eligible).length,
    },
  }
}
