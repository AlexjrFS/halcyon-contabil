// Proposals: what the agent may ask for and the founder may approve. Terms are always computed here from the
// offer and the cash policy; callers (including the model) pass only ids. An approval is bound to a fingerprint
// of the exact terms shown, so nothing can change between "the founder saw it" and "the code ran it".
import { createHash, randomUUID } from 'node:crypto'
import type { RefusalReason, ReminderDraft, ReminderOutcome, ReminderStage } from '../finance/followups.js'
import { chargeFor } from '../policy/card.js'
import { comparePlans, type CashPosition, type PlanComparison, type Plan, type SubscriptionOffer } from '../policy/cash.js'
import type { Cents } from '../policy/money.js'

// Long enough to read the confirmation card, short enough that the cash picture behind it is still current
export const PROPOSAL_TTL_MS = 15 * 60_000

// What the founder approves: amount, currency, merchant category and merchant, plus the plan behind them
export interface Terms {
  vendor: string
  product: string
  plan: Plan
  amount: Cents
  currency: string
  merchantCategoryCode: string
  revisitOn: string | null
}

export type Action =
  | { kind: 'issue_card'; offerId: string; terms: Terms }
  | { kind: 'update_card'; cardId: string; offerId: string; terms: Terms }
  | { kind: 'freeze_card'; cardId: string; reason: string }
  // The exact email the founder read; nothing else can be sent under this approval
  | { kind: 'send_reminder'; receivableId: string; stage: ReminderStage; to: string; subject: string; body: string }

export type ProposalStatus =
  | 'pending'
  | 'approved'
  | 'executing'
  | 'executed'
  | 'failed'
  | 'rejected'
  | 'expired'
  // The policy no longer recommends these terms (price or cash changed after approval): propose again
  | 'stale'

export interface Proposal {
  // Also the rail's request_id of the operation it approves
  id: string
  action: Action
  fingerprint: string
  status: ProposalStatus
  createdAt: string
  expiresAt: string
  approvedAt?: string
  attempts: number
  result?: { cardId?: string; reminderId?: string }
  error?: { code: string; message: string }
}

export interface ProposalStore {
  get(id: string): Promise<Proposal | undefined>
  save(proposal: Proposal): Promise<void>
  list(): Promise<Proposal[]>
  // Demo reset between takes
  clear(): Promise<void>
}

export interface PolicyContext {
  position: () => CashPosition
  offers: Record<string, SubscriptionOffer>
  // Reminder wording and eligibility for a client invoice, from the books (set when follow-ups are available)
  reminderFor?: (receivableId: string) => ReminderOutcome
  now?: () => Date
  newId?: () => string
}

export class ProposalError extends Error {
  constructor(
    readonly code: 'unknown_offer' | 'not_found' | 'not_pending' | 'expired' | 'fingerprint_mismatch' | 'not_approved',
    message: string,
  ) {
    super(message)
    this.name = 'ProposalError'
  }
}

// Sorted keys, so the same terms always hash the same
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export const fingerprint = (action: Action): string => createHash('sha256').update(canonical(action)).digest('hex')

export type TermsResult =
  | { kind: 'terms'; terms: Terms; comparison: PlanComparison }
  | { kind: 'escalate'; reason: string; comparison: PlanComparison }

// The single place where terms come from: offer + cash policy
export function termsFor(ctx: PolicyContext, offerId: string): TermsResult {
  const offer = ctx.offers[offerId]
  if (!offer) throw new ProposalError('unknown_offer', `No offer with id ${offerId}`)
  const comparison = comparePlans(ctx.position(), offer)
  const rec = comparison.recommendation
  if (rec.kind === 'escalate') return { kind: 'escalate', reason: rec.reason, comparison }
  return {
    kind: 'terms',
    comparison,
    terms: {
      vendor: offer.vendor,
      product: offer.product,
      plan: rec.plan,
      amount: chargeFor(offer, rec.plan),
      currency: offer.currency,
      merchantCategoryCode: offer.merchantCategoryCode,
      revisitOn: rec.revisitOn,
    },
  }
}

export type ProposeResult =
  | { kind: 'proposal'; proposal: Proposal; comparison: PlanComparison }
  | { kind: 'escalate'; reason: string; comparison: PlanComparison }

function newProposal(ctx: PolicyContext, action: Action): Proposal {
  const now = (ctx.now ?? (() => new Date()))()
  return {
    id: (ctx.newId ?? randomUUID)(),
    action,
    fingerprint: fingerprint(action),
    status: 'pending',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MS).toISOString(),
    attempts: 0,
  }
}

async function proposeFromPolicy(
  store: ProposalStore,
  ctx: PolicyContext,
  offerId: string,
  build: (terms: Terms) => Action,
  requirePlan?: Plan,
): Promise<ProposeResult> {
  const result = termsFor(ctx, offerId)
  if (result.kind === 'escalate') return result
  // A card's transaction count (one charge vs repeating) is fixed at issue, so a plan switch needs a new card
  if (requirePlan && result.terms.plan !== requirePlan) {
    return { kind: 'escalate', reason: 'plan_change_needs_new_card', comparison: result.comparison }
  }
  const proposal = newProposal(ctx, build(result.terms))
  await store.save(proposal)
  return { kind: 'proposal', proposal, comparison: result.comparison }
}

export const proposeCard = (store: ProposalStore, ctx: PolicyContext, offerId: string) =>
  proposeFromPolicy(store, ctx, offerId, (terms) => ({ kind: 'issue_card', offerId, terms }))

// New terms from the vendor (e.g. a price increase) need a new approval before the card accepts them
// `currentPlan`: the plan the card was issued for, when known
export const proposeCardUpdate = (
  store: ProposalStore,
  ctx: PolicyContext,
  cardId: string,
  offerId: string,
  currentPlan?: Plan,
) => proposeFromPolicy(store, ctx, offerId, (terms) => ({ kind: 'update_card', cardId, offerId, terms }), currentPlan)

export const reminderAction = (draft: ReminderDraft): Action => ({
  kind: 'send_reminder',
  receivableId: draft.receivableId,
  stage: draft.stage,
  to: draft.to,
  subject: draft.subject,
  body: draft.body,
})

export type ReminderProposal = { kind: 'proposal'; proposal: Proposal } | { kind: 'refused'; reason: RefusalReason }

// The wording comes from the books and the collection stage; the caller passes only the invoice id
export async function proposeReminder(store: ProposalStore, ctx: PolicyContext, receivableId: string): Promise<ReminderProposal> {
  const outcome = ctx.reminderFor?.(receivableId) ?? ({ kind: 'refused', reason: 'unknown_receivable' } as const)
  if (outcome.kind === 'refused') return outcome
  const proposal = newProposal(ctx, reminderAction(outcome.draft))
  await store.save(proposal)
  return { kind: 'proposal', proposal }
}

export async function proposeFreeze(store: ProposalStore, ctx: PolicyContext, cardId: string, reason: string) {
  const proposal = newProposal(ctx, { kind: 'freeze_card', cardId, reason })
  await store.save(proposal)
  return proposal
}

async function pendingProposal(store: ProposalStore, ctx: PolicyContext, id: string): Promise<Proposal> {
  const proposal = await store.get(id)
  if (!proposal) throw new ProposalError('not_found', `No proposal ${id}`)
  if (proposal.status !== 'pending') throw new ProposalError('not_pending', `Proposal ${id} is ${proposal.status}`)
  const now = (ctx.now ?? (() => new Date()))()
  if (now.getTime() > Date.parse(proposal.expiresAt)) {
    proposal.status = 'expired'
    await store.save(proposal)
    throw new ProposalError('expired', `Proposal ${id} expired at ${proposal.expiresAt}`)
  }
  return proposal
}

// `shownFingerprint` is what the confirmation card displayed; a mismatch means the founder approved something else
export async function approve(store: ProposalStore, ctx: PolicyContext, id: string, shownFingerprint: string) {
  const proposal = await pendingProposal(store, ctx, id)
  if (shownFingerprint !== proposal.fingerprint) {
    throw new ProposalError('fingerprint_mismatch', `Proposal ${id} does not match the approved terms`)
  }
  proposal.status = 'approved'
  proposal.approvedAt = (ctx.now ?? (() => new Date()))().toISOString()
  await store.save(proposal)
  return proposal
}

export async function reject(store: ProposalStore, ctx: PolicyContext, id: string) {
  const proposal = await pendingProposal(store, ctx, id)
  proposal.status = 'rejected'
  await store.save(proposal)
  return proposal
}
