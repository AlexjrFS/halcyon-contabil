// Anomaly flags on supplier invoices. Plain rules, no model: the agent only explains what these return.
import { cents, daysBetween, formatUSD, type Cents } from '../policy/money.js'
import type { Bill } from './types.js'

export type AnomalyCode =
  | 'duplicate_invoice'
  | 'amount_spike'
  | 'new_vendor'
  | 'payment_details_changed'
  | 'instructions_in_note'
  | 'foreign_currency'
  | 'needs_second_approval'

export type Severity = 'high' | 'medium' | 'low'

export interface Anomaly {
  billId: string
  code: AnomalyCode
  severity: Severity
  detail: string
}

// An invoice this many times the vendor's usual amount is flagged; three times is high severity
export const SPIKE_FACTOR = 1.5
export const SPIKE_HIGH_FACTOR = 3
// Same vendor and amount again within this many days of the earlier invoice looks like a resubmission
export const DUPLICATE_WINDOW_DAYS = 14
// A first invoice at or above this deserves a look before it is paid
export const NEW_VENDOR_REVIEW_FROM: Cents = cents(2_000)
// Company rule: payments from this amount need a second person
export const SECOND_APPROVAL_FROM: Cents = cents(5_000)

// Text aimed at an AI or at the payer's process rather than describing the invoice
const INSTRUCTION_PATTERNS = [
  /\b(ignore|disregard|override|bypass)\b[^.]{0,60}\b(polic|rule|instruction|approval|limit|check)/i,
  /\bpre-?approved\b/i,
  /\bdo not (mention|tell|inform|flag)\b/i,
  /\b(ai|assistant|agent|model)\b[^.]{0,40}\b(processing|reading|reviewing)\b/i,
  /\bpay (immediately|now|today)\b/i,
]

const norm = (value: string) => value.trim().toLowerCase()

export const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

export function detectAnomalies(bills: Bill[]): Anomaly[] {
  const ordered = [...bills].sort((a, b) =>
    a.issueDate === b.issueDate ? (a.id < b.id ? -1 : 1) : a.issueDate < b.issueDate ? -1 : 1,
  )
  const found: Anomaly[] = []

  ordered.forEach((bill, index) => {
    const add = (code: AnomalyCode, severity: Severity, detail: string) =>
      found.push({ billId: bill.id, code, severity, detail })
    const earlier = ordered.slice(0, index).filter((b) => norm(b.vendor) === norm(bill.vendor))

    const twin = earlier.find(
      (b) =>
        norm(b.invoiceNumber) === norm(bill.invoiceNumber) ||
        (b.amount === bill.amount && daysBetween(b.issueDate, bill.issueDate) <= DUPLICATE_WINDOW_DAYS),
    )
    if (twin) {
      add(
        'duplicate_invoice',
        'high',
        `Looks like a repeat of ${twin.invoiceNumber} (${formatUSD(twin.amount)}, issued ${twin.issueDate}).`,
      )
    }

    const usual = earlier.filter((b) => b !== twin)
    if (usual.length >= 2) {
      const average = Math.round(usual.reduce((sum, b) => sum + b.amount, 0) / usual.length)
      if (bill.amount > average * SPIKE_FACTOR) {
        const ratio = bill.amount / average
        add(
          'amount_spike',
          ratio >= SPIKE_HIGH_FACTOR ? 'high' : 'medium',
          `${formatUSD(bill.amount)} is ${ratio.toFixed(1)}x this vendor's usual ${formatUSD(average)}.`,
        )
      }
    }

    if (earlier.length === 0) {
      add(
        'new_vendor',
        bill.amount >= NEW_VENDOR_REVIEW_FROM ? 'medium' : 'low',
        `First invoice from ${bill.vendor}.`,
      )
    }

    if (bill.bankDetailsChanged) {
      add('payment_details_changed', 'high', 'The supplier changed its bank details with this invoice. Confirm by phone before paying.')
    }

    if (INSTRUCTION_PATTERNS.some((pattern) => pattern.test(bill.note))) {
      add('instructions_in_note', 'high', 'The supplier note contains instructions about how this invoice should be handled. It was not followed.')
    }

    if (bill.currency !== 'USD') {
      add('foreign_currency', 'medium', `Billed in ${bill.currency}, not USD.`)
    }

    if (bill.amount >= SECOND_APPROVAL_FROM) {
      add('needs_second_approval', 'low', `Payments of ${formatUSD(SECOND_APPROVAL_FROM)} or more need a second approver.`)
    }
  })

  return found.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.billId < b.billId ? -1 : a.billId > b.billId ? 1 : 0),
  )
}
