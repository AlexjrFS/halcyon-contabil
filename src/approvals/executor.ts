// Runs approved proposals against the payment rail. Only code reaches this: the model can propose, never execute.
// Idempotent: the proposal id is the request_id, a second call returns the stored result, and a retry after a
// crash finds the card that was already created instead of creating another one.
import { RailError, type RailApi } from '../rail/types.js'
import { cardRequest, cardUpdate, freezeCard } from '../policy/card.js'
import {
  fingerprint,
  ProposalError,
  termsFor,
  type PolicyContext,
  type Proposal,
  type ProposalStore,
} from './proposals.js'

export type CardApi = Pick<RailApi, 'createCard' | 'getCard' | 'updateCard' | 'listCards'>

export interface ExecutorDeps {
  store: ProposalStore
  cards: CardApi
  ctx: PolicyContext
  // A function when the cardholder is created lazily (on the first card)
  cardholderId: string | (() => Promise<string>)
  createdBy: string
}

// A rail answers a reused request_id with an error, not the original card. Adapters map their provider's
// version of that error to this code
const isReusedRequestId = (error: unknown) => error instanceof RailError && error.code === 'duplicate_request_id'

export function createExecutor(deps: ExecutorDeps) {
  const { store, cards, ctx } = deps
  // Two clicks on "approve" share one run
  // Per process only. If two runs ever reached createCard with the same request_id, the rail rejects the second
  // and findCardByDecision returns the first card. Don't "fix" this
  const inFlight = new Map<string, Promise<Proposal>>()
  const holder = async () => (typeof deps.cardholderId === 'string' ? deps.cardholderId : deps.cardholderId())

  async function findCardByDecision(decisionId: string): Promise<string | undefined> {
    for (let page = 0; ; page++) {
      const list = await cards.listCards({ cardholder_id: await holder(), page_num: page, page_size: 50 })
      for (const item of list.items) {
        const card = await cards.getCard(item.card_id)
        if (card.metadata?.decision_id === decisionId) return card.card_id
      }
      if (!list.has_more) return undefined
    }
  }

  async function perform(proposal: Proposal): Promise<string> {
    const { action } = proposal
    if (action.kind === 'freeze_card') {
      await cards.updateCard(action.cardId, freezeCard())
      return action.cardId
    }
    // The staleness check already confirmed the offer still yields these terms
    const offer = ctx.offers[action.offerId]!
    if (action.kind === 'update_card') {
      await cards.updateCard(action.cardId, cardUpdate(offer, action.terms.plan))
      return action.cardId
    }
    const decision = { id: proposal.id, plan: action.terms.plan, offer, revisitOn: action.terms.revisitOn }
    try {
      return (await cards.createCard(cardRequest(decision, await holder(), deps.createdBy))).card_id
    } catch (error) {
      if (!isReusedRequestId(error)) throw error
      const existing = await findCardByDecision(proposal.id)
      if (!existing) throw error
      return existing
    }
  }

  async function run(id: string): Promise<Proposal> {
    const proposal = await store.get(id)
    if (!proposal) throw new ProposalError('not_found', `No proposal ${id}`)
    if (proposal.status === 'executed') return proposal
    // 'executing' at this point means an earlier run stopped mid-call: retry with the same request_id
    if (!['approved', 'failed', 'executing'].includes(proposal.status)) {
      throw new ProposalError('not_approved', `Proposal ${id} is ${proposal.status}`)
    }

    const { action } = proposal
    if (action.kind !== 'freeze_card') {
      const fresh = termsFor(ctx, action.offerId)
      if (fresh.kind === 'escalate' || fingerprint({ ...action, terms: fresh.terms }) !== proposal.fingerprint) {
        proposal.status = 'stale'
        await store.save(proposal)
        return proposal
      }
    }

    proposal.status = 'executing'
    proposal.attempts++
    delete proposal.error
    await store.save(proposal)
    try {
      proposal.result = { cardId: await perform(proposal) }
      proposal.status = 'executed'
    } catch (error) {
      proposal.status = 'failed'
      proposal.error = {
        code: error instanceof RailError ? error.code : 'error',
        message: error instanceof Error ? error.message : String(error),
      }
    }
    await store.save(proposal)
    return proposal
  }

  return {
    execute(id: string): Promise<Proposal> {
      const running = inFlight.get(id)
      if (running) return running
      const next = run(id).finally(() => inFlight.delete(id))
      inFlight.set(id, next)
      return next
    },
  }
}
