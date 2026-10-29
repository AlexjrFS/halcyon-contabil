// Provider-neutral types for the payment rail: the thing that holds cards and decides authorizations.
// The shapes follow common card-issuing APIs, so an adapter for a real provider is a thin mapping.
// Amounts at this boundary are in major units (e.g. dollars); the rest of the app uses integer cents.

export type Interval = 'PER_TRANSACTION' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'ALL_TIME'

export interface Limit {
  amount: number
  interval: Interval
}

export interface AuthorizationControls {
  allowed_transaction_count: 'SINGLE' | 'MULTIPLE'
  transaction_limits: { currency?: string; limits: Limit[]; cash_withdrawal_limits?: Limit[] }
  allowed_currencies?: string[]
  allowed_merchant_categories?: string[]
  active_from?: string
  active_to?: string
}

export type CardStatus = 'PENDING' | 'ACTIVE' | 'INACTIVE' | 'BLOCKED' | 'LOST' | 'STOLEN' | 'CLOSED' | 'FAILED'

export interface Card {
  card_id: string
  card_status: CardStatus
  cardholder_id: string
  nick_name?: string
  authorization_controls?: AuthorizationControls
  metadata?: Record<string, string>
}

export interface CreateCardInput {
  request_id: string
  cardholder_id: string
  created_by: string
  form_factor: 'VIRTUAL'
  is_personalized: boolean
  program: { purpose: 'COMMERCIAL' | 'CONSUMER'; type?: 'PREPAID' | 'DEBIT' | 'CREDIT' | 'DEFERRED_DEBIT' }
  authorization_controls: AuthorizationControls
  purpose?:
    | 'BUSINESS_EXPENSES'
    | 'ONLINE_PURCHASING'
    | 'SUBSCRIPTIONS'
    | 'OTHER'
  nick_name?: string
  note?: string
  metadata?: Record<string, string>
}

// On update, send the full controls object: omitted merchant categories default to [] and
// transaction_limits needs both limits and cash_withdrawal_limits
export interface UpdateCardInput {
  card_status?: 'ACTIVE' | 'INACTIVE' | 'CLOSED'
  authorization_controls?: Omit<AuthorizationControls, 'allowed_transaction_count'> & {
    transaction_limits: { currency?: string; limits: Limit[]; cash_withdrawal_limits: Limit[] }
  }
  nick_name?: string
  metadata?: Record<string, string>
}

export type CardholderStatus = 'INCOMPLETE' | 'PENDING' | 'READY' | 'DISABLED' | 'DELETED'

export interface Cardholder {
  cardholder_id: string
  status: CardholderStatus
  email: string
}

export interface IndividualCardholderInput {
  email: string
  first_name: string
  last_name: string
  date_of_birth: string
  address: { line1: string; city: string; postcode: string; country: string; state?: string }
}

export interface SimulateAuthorizationInput {
  card_id: string
  transaction_amount: number
  transaction_currency: string
  merchant_category_code?: string
  merchant_info?: string
  single_phase?: boolean
}

export interface CardTransactionResult {
  card_transaction_id: string
  card_transaction_lifecycle_id: string
  card_id: string
  process_result: 'APPROVED' | 'DECLINED'
  // Present only when declined (LIMIT_EXCEEDED, CURRENCY_NOT_ALLOWED, MERCHANT_CATEGORY_NOT_ALLOWED, ...)
  failure_reason?: string
  type: 'AUTHORIZATION' | 'CLEARING' | 'REVERSAL_AUTH'
  subtype?: string
  transaction_amount: number
  transaction_currency: string
  merchant?: { category_code?: string; name?: string }
}

export interface CardLimits {
  currency: string
  // remaining: what is left in the current interval (cumulative for MONTHLY / ALL_TIME)
  limits: (Limit & { remaining: number })[]
}

// Amounts in major units; negative = money out. status FAILED carries failure_reason
export interface CardTransactionRecord {
  transaction_id: string
  card_id: string
  transaction_type: string
  status: string
  transaction_amount: number
  transaction_currency: string
  transaction_date: string
  failure_reason?: string
  merchant?: { name?: string; category_code?: string }
}

export interface Page<T> {
  items: T[]
  has_more?: boolean
}

// Everything the session, the executor and the agent's tools need from a rail
export interface RailApi {
  createIndividualCardholder(input: IndividualCardholderInput): Promise<Cardholder>
  getCardholder(id: string): Promise<Cardholder>
  // Fallback for rails whose cardholders need a manual review step
  passCardholderReview(id: string): Promise<unknown>
  createCard(input: CreateCardInput): Promise<Card>
  getCard(id: string): Promise<Card>
  getCardLimits(id: string): Promise<CardLimits>
  listCards(query?: { cardholder_id?: string; card_status?: CardStatus; page_num?: number; page_size?: number }): Promise<Page<Card>>
  updateCard(id: string, input: UpdateCardInput): Promise<Card>
  listTransactions(query?: { card_id?: string; page_num?: number; page_size?: number }): Promise<Page<CardTransactionRecord>>
  // A charge as the card network would send it; returns the decision synchronously
  simulateAuthorization(input: SimulateAuthorizationInput): Promise<CardTransactionResult>
}

// Rails report failures with a stable `code`. 'duplicate_request_id' means the operation already happened.
export class RailError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(`${code}: ${message}`)
    this.name = 'RailError'
  }
}
