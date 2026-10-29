// The built-in payment rail: virtual cards with authorization controls, decided in code on the same server.
// It plays the part a card issuer plays: a charge is approved only if it fits the card's currency, merchant
// category, transaction count and limits. Nothing here touches real money, and no vendor is involved.
// A real provider plugs in by implementing RailApi (see types.ts); the rest of the app does not change.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { writeJsonAtomic } from '../approvals/store.js'
import {
  RailError,
  type AuthorizationControls,
  type Card,
  type CardLimits,
  type CardTransactionRecord,
  type CardTransactionResult,
  type Cardholder,
  type IndividualCardholderInput,
  type CreateCardInput,
  type Limit,
  type Page,
  type RailApi,
  type SimulateAuthorizationInput,
  type UpdateCardInput,
} from './types.js'

export interface RailState {
  cardholders: Record<string, Cardholder>
  cards: Record<string, Card & { request_id: string }>
  // Newest last
  transactions: (CardTransactionRecord & { sequence: number })[]
  sequence: number
}

export const emptyRailState = (): RailState => ({ cardholders: {}, cards: {}, transactions: [], sequence: 0 })

export interface RailPersistence {
  load(): Promise<RailState | undefined>
  save(state: RailState): Promise<void>
}

export class FileRailStore implements RailPersistence {
  constructor(readonly path = 'data/rail.json') {}

  async load() {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as RailState
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  save(state: RailState) {
    return writeJsonAtomic(this.path, state)
  }
}

export interface SimulatedRailOptions {
  store?: RailPersistence
  now?: () => Date
  newId?: () => string
}

// Money is compared in cents so a limit of 600.00 and a charge of 600.00 are exactly equal (limits are inclusive)
const toCents = (major: number) => Math.round(major * 100)

const startOf = (interval: Limit['interval'], now: Date): number | null => {
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  switch (interval) {
    case 'DAILY':
      return day
    case 'WEEKLY':
      return now.getTime() - 7 * 24 * 3_600_000
    case 'MONTHLY':
      return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    case 'ALL_TIME':
      return 0
    default:
      return null // PER_TRANSACTION is not cumulative
  }
}

export class SimulatedRail implements RailApi {
  private state?: RailState
  // Operations run one at a time, so two clicks never read the same remaining limit
  private queue: Promise<unknown> = Promise.resolve()
  private readonly store?: RailPersistence
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(options: SimulatedRailOptions = {}) {
    this.store = options.store
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => randomUUID().slice(0, 8))
  }

  private run<T>(change: (state: RailState) => T, persist = true): Promise<T> {
    const next = this.queue.then(async () => {
      this.state ??= (await this.store?.load()) ?? emptyRailState()
      const result = change(this.state)
      if (persist) await this.store?.save(this.state)
      return result
    })
    this.queue = next.catch(() => {})
    return next
  }

  createIndividualCardholder(input: IndividualCardholderInput): Promise<Cardholder> {
    return this.run((s) => {
      const holder: Cardholder = { cardholder_id: `holder_${this.newId()}`, status: 'READY', email: input.email }
      s.cardholders[holder.cardholder_id] = holder
      return structuredClone(holder)
    })
  }

  getCardholder(id: string): Promise<Cardholder> {
    return this.run((s) => {
      const holder = s.cardholders[id]
      if (!holder) throw new RailError(404, 'not_found', `No cardholder ${id}`)
      return structuredClone(holder)
    }, false)
  }

  async passCardholderReview(id: string): Promise<void> {
    await this.run((s) => {
      const holder = s.cardholders[id]
      if (!holder) throw new RailError(404, 'not_found', `No cardholder ${id}`)
      holder.status = 'READY'
    })
  }

  createCard(input: CreateCardInput): Promise<Card> {
    return this.run((s) => {
      if (Object.values(s.cards).some((c) => c.request_id === input.request_id)) {
        throw new RailError(400, 'duplicate_request_id', 'This request_id was already used', { source: 'request_id' })
      }
      const holder = s.cardholders[input.cardholder_id]
      if (!holder || holder.status !== 'READY') throw new RailError(400, 'invalid_argument', 'Cardholder is not ready')
      const card: Card & { request_id: string } = {
        card_id: `card_${this.newId()}`,
        card_status: 'ACTIVE',
        cardholder_id: input.cardholder_id,
        nick_name: input.nick_name,
        authorization_controls: structuredClone(input.authorization_controls),
        metadata: input.metadata && structuredClone(input.metadata),
        request_id: input.request_id,
      }
      s.cards[card.card_id] = card
      return publicCard(card)
    })
  }

  getCard(id: string): Promise<Card> {
    return this.run((s) => publicCard(this.mustCard(s, id)), false)
  }

  listCards(query: { cardholder_id?: string; card_status?: Card['card_status']; page_num?: number; page_size?: number } = {}): Promise<Page<Card>> {
    return this.run((s) => {
      const all = Object.values(s.cards).filter(
        (c) =>
          (!query.cardholder_id || c.cardholder_id === query.cardholder_id) &&
          (!query.card_status || c.card_status === query.card_status),
      )
      const size = query.page_size ?? 50
      const page = query.page_num ?? 0
      return { items: all.slice(page * size, (page + 1) * size).map(publicCard), has_more: all.length > (page + 1) * size }
    }, false)
  }

  // Like most issuers: the update carries the full controls. The transaction count is fixed when the card is issued
  updateCard(id: string, input: UpdateCardInput): Promise<Card> {
    return this.run((s) => {
      const card = this.mustCard(s, id)
      if (input.card_status) card.card_status = input.card_status
      if (input.authorization_controls) {
        const { transaction_limits, ...rest } = input.authorization_controls
        card.authorization_controls = {
          allowed_transaction_count: card.authorization_controls?.allowed_transaction_count ?? 'MULTIPLE',
          ...structuredClone(rest),
          transaction_limits: structuredClone(transaction_limits),
        }
      }
      if (input.nick_name) card.nick_name = input.nick_name
      if (input.metadata) card.metadata = { ...card.metadata, ...input.metadata }
      return publicCard(card)
    })
  }

  getCardLimits(id: string): Promise<CardLimits> {
    return this.run((s) => {
      const card = this.mustCard(s, id)
      const controls = card.authorization_controls
      const limits = controls?.transaction_limits.limits ?? []
      return {
        currency: controls?.transaction_limits.currency ?? 'USD',
        limits: limits.map((limit) => ({ ...limit, remaining: remaining(s, id, limit, this.now()) / 100 })),
      }
    }, false)
  }

  listTransactions(query: { card_id?: string; page_num?: number; page_size?: number } = {}): Promise<Page<CardTransactionRecord>> {
    return this.run((s) => {
      const all = s.transactions.filter((t) => !query.card_id || t.card_id === query.card_id).reverse()
      const size = query.page_size ?? 20
      const page = query.page_num ?? 0
      return {
        items: all.slice(page * size, (page + 1) * size).map(({ sequence: _, ...t }) => structuredClone(t)),
        has_more: all.length > (page + 1) * size,
      }
    }, false)
  }

  simulateAuthorization(input: SimulateAuthorizationInput): Promise<CardTransactionResult> {
    return this.run((s) => {
      const card = this.mustCard(s, input.card_id)
      const failure = decline(s, card, input, this.now())
      const id = `txn_${this.newId()}`
      s.sequence++
      s.transactions.push({
        sequence: s.sequence,
        transaction_id: id,
        card_id: card.card_id,
        transaction_type: 'AUTHORIZATION',
        // Accepted charges settle straight away in this rail
        status: failure ? 'FAILED' : 'CLEARING',
        transaction_amount: -input.transaction_amount,
        transaction_currency: input.transaction_currency,
        transaction_date: this.now().toISOString(),
        ...(failure ? { failure_reason: failure } : {}),
        merchant: { name: input.merchant_info, category_code: input.merchant_category_code },
      })
      return {
        card_transaction_id: id,
        card_transaction_lifecycle_id: id,
        card_id: card.card_id,
        process_result: failure ? 'DECLINED' : 'APPROVED',
        ...(failure ? { failure_reason: failure } : {}),
        type: failure ? 'AUTHORIZATION' : 'CLEARING',
        transaction_amount: input.transaction_amount,
        transaction_currency: input.transaction_currency,
        merchant: { category_code: input.merchant_category_code, name: input.merchant_info },
      }
    })
  }

  private mustCard(s: RailState, id: string) {
    const card = s.cards[id]
    if (!card) throw new RailError(404, 'not_found', `No card ${id}`)
    return card
  }
}

const publicCard = ({ request_id: _, ...card }: Card & { request_id: string }): Card => structuredClone(card)

// What is left in cents in a limit's current interval (inclusive limits)
function remaining(s: RailState, cardId: string, limit: Limit, now: Date): number {
  const since = startOf(limit.interval, now)
  if (since === null) return toCents(limit.amount)
  const used = s.transactions
    .filter((t) => t.card_id === cardId && t.status !== 'FAILED' && Date.parse(t.transaction_date) >= since)
    .reduce((sum, t) => sum - toCents(t.transaction_amount), 0)
  return Math.max(0, toCents(limit.amount) - used)
}

// The first rule a charge breaks, or undefined when it is accepted. Same reason codes issuers use
function decline(s: RailState, card: Card, input: SimulateAuthorizationInput, now: Date): string | undefined {
  const controls: AuthorizationControls | undefined = card.authorization_controls
  if (card.card_status !== 'ACTIVE') return 'CARD_NOT_ACTIVE'
  if (controls?.allowed_currencies?.length && !controls.allowed_currencies.includes(input.transaction_currency)) {
    return 'CURRENCY_NOT_ALLOWED'
  }
  const categories = controls?.allowed_merchant_categories
  if (categories?.length && (!input.merchant_category_code || !categories.includes(input.merchant_category_code))) {
    return 'MERCHANT_CATEGORY_NOT_ALLOWED'
  }
  if (
    controls?.allowed_transaction_count === 'SINGLE' &&
    s.transactions.some((t) => t.card_id === card.card_id && t.status !== 'FAILED')
  ) {
    return 'TRANSACTION_COUNT_EXCEEDED'
  }
  const amount = toCents(input.transaction_amount)
  for (const limit of controls?.transaction_limits.limits ?? []) {
    if (amount > remaining(s, card.card_id, limit, now)) return 'LIMIT_EXCEEDED'
  }
  return undefined
}
