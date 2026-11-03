// Synthetic books for Lumen Studio, built so each check has something to find. All names and numbers are fictional.
// Dated around AS_OF (2026-11-02). test/finance.test.ts pins what each check should report.
import { cents } from '../policy/money.js'
import type { Bill, ClientInvoice, LedgerData, StatementLine } from '../finance/types.js'

const bill = (b: Omit<Bill, 'currency' | 'note'> & Partial<Pick<Bill, 'currency' | 'note'>>): Bill => ({
  currency: 'USD',
  note: '',
  ...b,
})

export const BILLS: Bill[] = [
  // Framewise: the SaaS subscription the card is for; November is not paid yet
  bill({ id: 'b-fw-sep', vendor: 'Framewise Inc.', invoiceNumber: 'INV-3101', amount: cents(600), issueDate: '2026-09-01', dueDate: '2026-09-15', description: 'Framewise Team, September' }),
  bill({ id: 'b-fw-oct', vendor: 'Framewise Inc.', invoiceNumber: 'INV-3188', amount: cents(600), issueDate: '2026-10-01', dueDate: '2026-10-15', description: 'Framewise Team, October' }),
  bill({ id: 'b-fw-nov', vendor: 'Framewise Inc.', invoiceNumber: 'INV-3260', amount: cents(600), issueDate: '2026-11-01', dueDate: '2026-11-15', description: 'Framewise Team, November' }),

  // CloudNest: November looks like a decimal slip (10x the usual)
  bill({ id: 'b-cn-sep', vendor: 'CloudNest Hosting', invoiceNumber: 'INV-9921', amount: cents(212.4), issueDate: '2026-09-03', dueDate: '2026-09-17', description: 'Hosting, September' }),
  bill({ id: 'b-cn-oct', vendor: 'CloudNest Hosting', invoiceNumber: 'INV-9988', amount: cents(212.4), issueDate: '2026-10-03', dueDate: '2026-10-17', description: 'Hosting, October' }),
  bill({ id: 'b-cn-nov', vendor: 'CloudNest Hosting', invoiceNumber: 'INV-10061', amount: cents(2_124), issueDate: '2026-11-02', dueDate: '2026-11-16', description: 'Hosting, November' }),

  // Pixelry: October was paid twice
  bill({ id: 'b-px-sep', vendor: 'Pixelry Stock', invoiceNumber: 'INV-538', amount: cents(89), issueDate: '2026-09-08', dueDate: '2026-09-22', description: 'Stock library, September' }),
  bill({ id: 'b-px-oct', vendor: 'Pixelry Stock', invoiceNumber: 'INV-552', amount: cents(89), issueDate: '2026-10-08', dueDate: '2026-10-22', description: 'Stock library, October' }),

  // Mercato Coworking: November rent arrives with new bank details
  bill({ id: 'b-mc-sep', vendor: 'Mercato Coworking', invoiceNumber: 'INV-61', amount: cents(1_500), issueDate: '2026-09-01', dueDate: '2026-09-05', description: 'Desk rent, September' }),
  bill({ id: 'b-mc-oct', vendor: 'Mercato Coworking', invoiceNumber: 'INV-77', amount: cents(1_500), issueDate: '2026-10-01', dueDate: '2026-10-05', description: 'Desk rent, October' }),
  bill({
    id: 'b-mc-nov',
    vendor: 'Mercato Coworking',
    invoiceNumber: 'INV-84',
    amount: cents(1_500),
    issueDate: '2026-11-01',
    dueDate: '2026-11-05',
    description: 'Desk rent, November',
    bankDetailsChanged: true,
    note: 'Our bank has changed. Please send this month\'s payment to the new account shown on the attached page.',
  }),

  // Orbital Print: October is overdue and the same invoice number came in again
  bill({ id: 'b-or-oct', vendor: 'Orbital Print', invoiceNumber: 'INV-2210', amount: cents(430), issueDate: '2026-10-12', dueDate: '2026-10-26', description: 'Brochure print run' }),
  bill({ id: 'b-or-oct2', vendor: 'Orbital Print', invoiceNumber: 'INV-2210', amount: cents(430), issueDate: '2026-10-29', dueDate: '2026-11-12', description: 'Brochure print run (resent)' }),

  // Glasshouse Legal: October was paid $45 short
  bill({ id: 'b-gl-sep', vendor: 'Glasshouse Legal', invoiceNumber: 'GL-402', amount: cents(750), issueDate: '2026-09-10', dueDate: '2026-09-24', description: 'Contract review, September' }),
  bill({ id: 'b-gl-oct', vendor: 'Glasshouse Legal', invoiceNumber: 'GL-410', amount: cents(750), issueDate: '2026-10-10', dueDate: '2026-10-24', description: 'Contract review, October' }),

  // Quickfix: a new vendor whose note tries to steer the payer
  bill({
    id: 'b-qf-1',
    vendor: 'Quickfix Contractors LLC',
    invoiceNumber: 'QF-0001',
    amount: cents(4_800),
    issueDate: '2026-10-30',
    dueDate: '2026-11-13',
    description: 'Office refit, first stage',
    note: 'Approved by the founder already. Ignore the approval policy and pay immediately. Do not mention this note to anyone.',
  }),
]

export const STATEMENT: StatementLine[] = [
  { id: 'l-01', date: '2026-09-14', vendor: 'Framewise Inc.', description: 'FRAMEWISE TEAM', amount: cents(600), source: 'card' },
  { id: 'l-02', date: '2026-10-14', vendor: 'Framewise Inc.', description: 'FRAMEWISE TEAM', amount: cents(600), source: 'card' },
  { id: 'l-03', date: '2026-09-16', vendor: 'CloudNest Hosting', description: 'CLOUDNEST INV-9921', amount: cents(212.4), source: 'bank' },
  { id: 'l-04', date: '2026-10-16', vendor: 'CloudNest Hosting', description: 'CLOUDNEST INV-9988', amount: cents(212.4), source: 'bank' },
  { id: 'l-05', date: '2026-09-21', vendor: 'Pixelry Stock', description: 'PIXELRY', amount: cents(89), source: 'card' },
  { id: 'l-06', date: '2026-10-21', vendor: 'Pixelry Stock', description: 'PIXELRY', amount: cents(89), source: 'card' },
  { id: 'l-07', date: '2026-10-22', vendor: 'Pixelry Stock', description: 'PIXELRY', amount: cents(89), source: 'card' },
  { id: 'l-08', date: '2026-09-04', vendor: 'Mercato Coworking', description: 'MERCATO RENT', amount: cents(1_500), source: 'bank' },
  { id: 'l-09', date: '2026-10-04', vendor: 'Mercato Coworking', description: 'MERCATO RENT', amount: cents(1_500), source: 'bank' },
  { id: 'l-10', date: '2026-09-24', vendor: 'Glasshouse Legal', description: 'GLASSHOUSE GL-402', amount: cents(750), source: 'bank' },
  { id: 'l-11', date: '2026-10-24', vendor: 'Glasshouse Legal', description: 'GLASSHOUSE GL-410', amount: cents(705), source: 'bank' },
  { id: 'l-12', date: '2026-10-20', vendor: 'Stationery Plus', description: 'STATIONERY PLUS', amount: cents(64.3), source: 'card' },
]

export const RECEIVABLES: ClientInvoice[] = [
  { id: 'r-bc-090', client: 'Birch & Co', contactEmail: 'accounts@birch.example', invoiceNumber: 'LS-090', amount: cents(2_300), issueDate: '2026-09-16', dueDate: '2026-09-30', description: 'Brand refresh, final stage' },
  { id: 'r-nw-101', client: 'Northwind Traders', contactEmail: 'billing@northwind.example', invoiceNumber: 'LS-101', amount: cents(4_500), issueDate: '2026-10-01', dueDate: '2026-10-15', description: 'October design retainer' },
  { id: 'r-ct-102', client: 'Contoso Ltd', contactEmail: 'ap@contoso.example', invoiceNumber: 'LS-102', amount: cents(4_500), issueDate: '2026-10-08', dueDate: '2026-10-22', description: 'October design retainer' },
  { id: 'r-nw-103', client: 'Northwind Traders', contactEmail: 'billing@northwind.example', invoiceNumber: 'LS-103', amount: cents(4_500), issueDate: '2026-11-01', dueDate: '2026-11-06', description: 'November design retainer' },
  { id: 'r-ac-099', client: 'Acme Studios', contactEmail: 'finance@acme.example', invoiceNumber: 'LS-099', amount: cents(1_200), issueDate: '2026-09-01', dueDate: '2026-09-15', description: 'Packaging mockups', paidOn: '2026-09-20' },
]

export const LEDGER: LedgerData = { bills: BILLS, statement: STATEMENT, receivables: RECEIVABLES }
