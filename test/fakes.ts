// Shared test doubles. Not a test file: the runner only picks up *.test.ts
import type { Card, CardholderStatus, SimulateAuthorizationInput } from '../src/rail/types.js'
import type { SessionApi } from '../src/app/session.js'

export function fakeApi(cardholderStatus: CardholderStatus = 'READY') {
  const cards = new Map<string, Card>()
  const calls = { holders: 0, reviews: 0, creates: 0, updates: 0, simulations: [] as SimulateAuthorizationInput[] }
  let status = cardholderStatus
  const api: SessionApi = {
    async createIndividualCardholder() {
      calls.holders++
      return { cardholder_id: `holder-${calls.holders}`, status: 'PENDING', email: 'x@example.com' }
    },
    async getCardholder(id) {
      return { cardholder_id: id, status, email: 'x@example.com' }
    },
    async passCardholderReview() {
      calls.reviews++
      status = 'READY'
    },
    async createCard(input) {
      calls.creates++
      const card: Card = {
        card_id: `card-${calls.creates}`,
        card_status: 'ACTIVE',
        cardholder_id: input.cardholder_id,
        authorization_controls: input.authorization_controls,
        metadata: input.metadata,
      }
      cards.set(card.card_id, card)
      return card
    },
    async getCard(id) {
      return cards.get(id)!
    },
    async getCardLimits(id) {
      const limits = cards.get(id)!.authorization_controls!.transaction_limits.limits
      return { currency: 'USD', limits: limits.map((l) => ({ ...l, remaining: l.amount })) }
    },
    async listTransactions() {
      return { items: [] }
    },
    async updateCard(id) {
      calls.updates++
      return cards.get(id)!
    },
    async listCards() {
      return { items: [...cards.values()], has_more: false }
    },
    async simulateAuthorization(input) {
      calls.simulations.push(input)
      return {
        card_transaction_id: 't',
        card_transaction_lifecycle_id: 'l',
        card_id: input.card_id,
        process_result: 'APPROVED',
        type: 'CLEARING',
        transaction_amount: input.transaction_amount,
        transaction_currency: input.transaction_currency,
      }
    },
  }
  return { api, calls }
}
