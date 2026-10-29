// Shapes returned by the Halcyon-contabil API (src/server/app.ts in the repo root). Amounts are integer cents.

export interface Terms {
  vendor: string
  product: string
  plan: 'annual' | 'monthly'
  amount: number
  currency: string
  merchantCategoryCode: string
  revisitOn: string | null
}

export type Action =
  | { kind: 'issue_card'; offerId: string; terms: Terms }
  | { kind: 'update_card'; cardId: string; offerId: string; terms: Terms }
  | { kind: 'freeze_card'; cardId: string; reason: string }

export type ProposalStatus = 'pending' | 'approved' | 'executing' | 'executed' | 'failed' | 'rejected' | 'expired' | 'stale'

export interface Proposal {
  id: string
  action: Action
  fingerprint: string
  status: ProposalStatus
  createdAt: string
  expiresAt: string
  result?: { cardId: string }
  error?: { code: string; message: string }
}

export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'proposal'; proposal: Proposal }
  | { type: 'end' }
  | { type: 'error'; message: string }

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface Offer {
  offer_id: string
  vendor: string
  product: string
  monthly: string
  annual: string
}

export interface DemoState {
  cardholderId?: string
  cards: Record<string, { cardId: string; plan: string; proposalId: string }>
  invoices: string[]
  offers: Offer[]
}

export interface Limit {
  amount: number
  interval: string
}

export interface CardView {
  cardId: string
  plan: string
  card: {
    card_id: string
    card_status: string
    authorization_controls?: {
      transaction_limits: { currency?: string; limits: Limit[] }
      allowed_currencies?: string[]
      allowed_merchant_categories?: string[]
    }
    metadata?: Record<string, string>
  }
  // What is left in each interval, from the rail (MONTHLY is cumulative)
  limits: { currency: string; limits: (Limit & { remaining: number })[] }
  // Authorizations on this card as the rail recorded them; amounts in major units, negative = money out
  transactions: {
    transaction_id: string
    status: string
    transaction_amount: number
    transaction_currency: string
    transaction_date: string
    failure_reason?: string
  }[]
}

export type ChargeKind = 'monthly' | 'annual' | 'other_currency' | 'other_category'

export interface ChargeResult {
  kind: ChargeKind
  charge: { amount: number; currency?: string; merchantCategoryCode?: string; display: string }
  result: { process_result: 'APPROVED' | 'DECLINED'; failure_reason?: string }
}
