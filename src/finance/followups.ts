// Payment follow-ups: which client invoices are late, how firm the next reminder should be, and the reminder text.
// The stage and the wording come from here. The agent proposes a reminder by id; the founder sees the exact
// text and approves before anything is sent.
import { daysBetween, formatUSD } from '../policy/money.js'
import type { ClientInvoice } from './types.js'

export type CollectionStage = 'paid' | 'not_due' | 'due_soon' | 'friendly' | 'firm' | 'final'
export type ReminderStage = 'friendly' | 'firm' | 'final'

// Not chased until it is actually late
export const DUE_SOON_DAYS = 7
export const FIRM_FROM_DAYS_OVERDUE = 15
export const FINAL_FROM_DAYS_OVERDUE = 31
// A client is not reminded again sooner than this
export const REMINDER_COOLDOWN_DAYS = 7

export interface ReminderRecord {
  id: string
  receivableId: string
  stage: ReminderStage
  to: string
  subject: string
  body: string
  // Demo date the reminder went out, and the real timestamp
  date: string
  sentAt: string
}

export interface ReceivableStatus {
  receivable: ClientInvoice
  daysOverdue: number
  stage: CollectionStage
  lastReminder?: { date: string; stage: ReminderStage }
  eligible: boolean
  // Why no reminder can be drafted now
  reason?: RefusalReason
}

export type RefusalReason = 'unknown_receivable' | 'already_paid' | 'not_overdue' | 'recently_reminded'

export interface ReminderDraft {
  receivableId: string
  stage: ReminderStage
  to: string
  subject: string
  body: string
}

export type ReminderOutcome = { kind: 'draft'; draft: ReminderDraft } | { kind: 'refused'; reason: RefusalReason }

export interface Sender {
  name: string
  company: string
}

export function collectionStage(receivable: ClientInvoice, asOf: string): { stage: CollectionStage; daysOverdue: number } {
  if (receivable.paidOn) return { stage: 'paid', daysOverdue: 0 }
  const daysOverdue = daysBetween(receivable.dueDate, asOf)
  if (daysOverdue <= 0) return { stage: -daysOverdue <= DUE_SOON_DAYS ? 'due_soon' : 'not_due', daysOverdue: 0 }
  if (daysOverdue >= FINAL_FROM_DAYS_OVERDUE) return { stage: 'final', daysOverdue }
  if (daysOverdue >= FIRM_FROM_DAYS_OVERDUE) return { stage: 'firm', daysOverdue }
  return { stage: 'friendly', daysOverdue }
}

export function reviewReceivables(receivables: ClientInvoice[], reminders: ReminderRecord[], asOf: string): ReceivableStatus[] {
  return receivables.map((receivable) => {
    const { stage, daysOverdue } = collectionStage(receivable, asOf)
    const last = reminders
      .filter((r) => r.receivableId === receivable.id)
      .sort((a, b) => (a.date < b.date ? 1 : -1))[0]
    const recently = last !== undefined && daysBetween(last.date, asOf) < REMINDER_COOLDOWN_DAYS
    const late = stage === 'friendly' || stage === 'firm' || stage === 'final'
    return {
      receivable,
      daysOverdue,
      stage,
      ...(last ? { lastReminder: { date: last.date, stage: last.stage } } : {}),
      eligible: late && !recently,
      ...(!late ? { reason: stage === 'paid' ? ('already_paid' as const) : ('not_overdue' as const) } : recently ? { reason: 'recently_reminded' as const } : {}),
    }
  })
}

export function draftReminder(receivable: ClientInvoice, stage: ReminderStage, daysOverdue: number, sender: Sender): ReminderDraft {
  const amount = formatUSD(receivable.amount)
  const what = `invoice ${receivable.invoiceNumber} for ${amount} (${receivable.description})`
  const lines: Record<ReminderStage, string> = {
    friendly: `A quick reminder that ${what} was due on ${receivable.dueDate} and we have not received payment yet. If it is already on its way, please ignore this note.`,
    firm: `${what[0]!.toUpperCase()}${what.slice(1)} is now ${daysOverdue} days past due (due ${receivable.dueDate}). Please arrange payment this week, or tell us the date we can expect it.`,
    final: `This is a final notice. ${what[0]!.toUpperCase()}${what.slice(1)} is ${daysOverdue} days past due (due ${receivable.dueDate}). Unless we receive payment, or a confirmed payment date, within 5 business days, we will have to pause new work.`,
  }
  return {
    receivableId: receivable.id,
    stage,
    to: receivable.contactEmail,
    subject:
      stage === 'final'
        ? `Final notice: invoice ${receivable.invoiceNumber} (${amount})`
        : `Payment reminder: invoice ${receivable.invoiceNumber} (${amount})`,
    body: `Hi ${receivable.client} team,\n\n${lines[stage]}\n\nThanks,\n${sender.name}\n${sender.company}`,
  }
}

// The single place a reminder comes from: invoice + date + reminders already sent
export function reminderOutcome(
  receivables: ClientInvoice[],
  reminders: ReminderRecord[],
  asOf: string,
  sender: Sender,
  receivableId: string,
): ReminderOutcome {
  const status = reviewReceivables(receivables, reminders, asOf).find((s) => s.receivable.id === receivableId)
  if (!status) return { kind: 'refused', reason: 'unknown_receivable' }
  if (!status.eligible) return { kind: 'refused', reason: status.reason ?? 'not_overdue' }
  return { kind: 'draft', draft: draftReminder(status.receivable, status.stage as ReminderStage, status.daysOverdue, sender) }
}
