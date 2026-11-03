// Records the finance agent works on. Money is integer cents, dates are YYYY-MM-DD, like everywhere else.
import type { Cents } from '../policy/money.js'

// A supplier invoice the company has to pay (accounts payable)
export interface Bill {
  id: string
  vendor: string
  invoiceNumber: string
  amount: Cents
  currency: string
  issueDate: string
  dueDate: string
  description: string
  // The supplier says its bank details changed with this invoice
  bankDetailsChanged?: boolean
  // Free text from the supplier. Untrusted: shown to the model wrapped, never parsed for terms
  note: string
}

// A payment that left the bank account or the cards (positive = money out)
export interface StatementLine {
  id: string
  date: string
  vendor: string
  description: string
  amount: Cents
  source: 'bank' | 'card'
}

// An invoice the company issued to a client (accounts receivable)
export interface ClientInvoice {
  id: string
  client: string
  contactEmail: string
  invoiceNumber: string
  amount: Cents
  issueDate: string
  dueDate: string
  description: string
  paidOn?: string
}

export interface LedgerData {
  bills: Bill[]
  statement: StatementLine[]
  receivables: ClientInvoice[]
}
