// Matches supplier invoices to payments on the bank and card statement. Exact amounts first, then repeats,
// then near misses. Whatever is left over is reported, not guessed at.
import { addDays, daysBetween, type Cents } from '../policy/money.js'
import type { Bill, StatementLine } from './types.js'

export type PaymentStatus = 'paid' | 'duplicate_payment' | 'amount_mismatch' | 'unpaid'

export interface BillMatch {
  billId: string
  status: PaymentStatus
  lineIds: string[]
  // Total paid against this invoice
  paid: Cents
  // paid minus the invoice amount: positive = overpaid
  difference: Cents
}

export interface Reconciliation {
  matches: BillMatch[]
  // Payments with no invoice behind them
  unmatchedLines: StatementLine[]
}

// A payment can land a little after the due date
export const LATE_PAYMENT_WINDOW_DAYS = 30

const norm = (value: string) => value.trim().toLowerCase()
const byDateThenId = (a: { date: string; id: string }, b: { date: string; id: string }) =>
  a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? -1 : 1

export function reconcile(bills: Bill[], statement: StatementLine[]): Reconciliation {
  const used = new Set<string>()
  const inWindow = (bill: Bill, line: StatementLine) =>
    norm(line.vendor) === norm(bill.vendor) &&
    line.date >= bill.issueDate &&
    line.date <= addDays(bill.dueDate, LATE_PAYMENT_WINDOW_DAYS)
  const free = (bill: Bill) =>
    statement.filter((line) => !used.has(line.id) && inWindow(bill, line)).sort(byDateThenId)

  const ordered = [...bills].sort((a, b) =>
    a.dueDate === b.dueDate ? (a.id < b.id ? -1 : 1) : a.dueDate < b.dueDate ? -1 : 1,
  )
  const matches = new Map<string, BillMatch>()

  // 1. The same amount, the earliest payment first
  for (const bill of ordered) {
    const line = free(bill).find((l) => l.amount === bill.amount)
    if (line) {
      used.add(line.id)
      matches.set(bill.id, { billId: bill.id, status: 'paid', lineIds: [line.id], paid: line.amount, difference: 0 })
    }
  }

  // 2. The same amount again for an invoice already paid: paid twice. The repeat belongs to the invoice whose
  // payment is closest in time
  const byId = new Map(statement.map((line) => [line.id, line]))
  for (const line of statement.filter((l) => !used.has(l.id)).sort(byDateThenId)) {
    const target = ordered
      .filter((bill) => matches.has(bill.id) && bill.amount === line.amount && inWindow(bill, line))
      .map((bill) => ({ bill, gap: Math.abs(daysBetween(byId.get(matches.get(bill.id)!.lineIds[0]!)!.date, line.date)) }))
      .sort((a, b) => a.gap - b.gap)[0]
    if (!target) continue
    const match = matches.get(target.bill.id)!
    used.add(line.id)
    match.status = 'duplicate_payment'
    match.lineIds.push(line.id)
    match.paid += line.amount
    match.difference = match.paid - target.bill.amount
  }

  // 3. A payment to the same supplier in the right period, but another amount
  for (const bill of ordered) {
    if (matches.has(bill.id)) continue
    const line = free(bill)[0]
    if (line) {
      used.add(line.id)
      matches.set(bill.id, {
        billId: bill.id,
        status: 'amount_mismatch',
        lineIds: [line.id],
        paid: line.amount,
        difference: line.amount - bill.amount,
      })
    }
  }

  for (const bill of ordered) {
    if (!matches.has(bill.id)) matches.set(bill.id, { billId: bill.id, status: 'unpaid', lineIds: [], paid: 0, difference: -bill.amount })
  }

  return {
    matches: ordered.map((bill) => matches.get(bill.id)!),
    unmatchedLines: statement.filter((line) => !used.has(line.id)).sort(byDateThenId),
  }
}
