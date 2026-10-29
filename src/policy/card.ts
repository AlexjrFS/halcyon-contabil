// Turns an approved purchase decision into card controls. The card, not the prompt, is what blocks
// an authorization that falls outside the decision.
import type { AuthorizationControls, CreateCardInput, UpdateCardInput } from '../rail/types.js'
import type { Plan, SubscriptionOffer } from './cash.js'
import { toMajor, type Cents } from './money.js'

export interface PurchaseDecision {
  // Stable id of the approved proposal; reused as the rail's request_id so retries are idempotent
  id: string
  plan: Plan
  offer: SubscriptionOffer
  revisitOn: string | null
}

export const chargeFor = (offer: SubscriptionOffer, plan: Plan): Cents =>
  plan === 'annual' ? offer.annualPrice : offer.monthlyPrice

export function controlsFor(offer: SubscriptionOffer, plan: Plan): AuthorizationControls {
  const amount = toMajor(chargeFor(offer, plan))
  return {
    // Annual is one charge; monthly repeats
    allowed_transaction_count: plan === 'annual' ? 'SINGLE' : 'MULTIPLE',
    transaction_limits: {
      currency: offer.currency,
      // PER_TRANSACTION is not cumulative, so cap the total too. Limits are inclusive: the exact price clears.
      limits: [
        { amount, interval: 'PER_TRANSACTION' },
        { amount, interval: plan === 'annual' ? 'ALL_TIME' : 'MONTHLY' },
      ],
    },
    allowed_currencies: [offer.currency],
    allowed_merchant_categories: [offer.merchantCategoryCode],
  }
}

export function cardRequest(decision: PurchaseDecision, cardholderId: string, createdBy: string): CreateCardInput {
  const { offer, plan } = decision
  return {
    request_id: decision.id,
    cardholder_id: cardholderId,
    created_by: createdBy,
    form_factor: 'VIRTUAL',
    is_personalized: false,
    // No program.type: the rail's default applies
    program: { purpose: 'COMMERCIAL' },
    purpose: 'SUBSCRIPTIONS',
    nick_name: `${offer.product} ${plan}`.slice(0, 32),
    authorization_controls: controlsFor(offer, plan),
    // Metadata: up to 20 keys, key names up to 20 chars, values up to 150 chars
    metadata: {
      decision_id: decision.id,
      plan,
      vendor: offer.vendor.slice(0, 150),
      ...(decision.revisitOn ? { revisit_on: decision.revisitOn } : {}),
    },
  }
}

// Update requests must resend every control: omitted merchant categories reset to []
export function cardUpdate(offer: SubscriptionOffer, plan: Plan): UpdateCardInput {
  const { allowed_transaction_count: _, ...controls } = controlsFor(offer, plan)
  return {
    authorization_controls: {
      ...controls,
      transaction_limits: { ...controls.transaction_limits, cash_withdrawal_limits: [] },
    },
  }
}

export const freezeCard = (): UpdateCardInput => ({ card_status: 'INACTIVE' })
