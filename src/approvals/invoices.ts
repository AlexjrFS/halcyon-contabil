// Turns a supplier invoice into new offer terms. Code calls this when an invoice arrives; the model never does.
// Only the structured fields are read. A different vendor, merchant category or currency is a new purchase,
// not a price change, so it is refused here and never reaches a proposal.
import type { Invoice } from '../demo/invoices.js'
import type { SubscriptionOffer } from '../policy/cash.js'
import type { PolicyContext } from './proposals.js'

export type IngestResult =
  | { kind: 'updated'; offerId: string; before: SubscriptionOffer; after: SubscriptionOffer }
  | { kind: 'unchanged'; offerId: string }
  | { kind: 'refused'; reason: 'unknown_offer' | 'vendor_mismatch' | 'merchant_category_mismatch' | 'currency_mismatch' }

export function ingestInvoice(ctx: PolicyContext, offerId: string, invoice: Invoice): IngestResult {
  const before = ctx.offers[offerId]
  if (!before) return { kind: 'refused', reason: 'unknown_offer' }
  if (invoice.vendor !== before.vendor) return { kind: 'refused', reason: 'vendor_mismatch' }
  if (invoice.merchantCategoryCode !== before.merchantCategoryCode) {
    return { kind: 'refused', reason: 'merchant_category_mismatch' }
  }
  if (invoice.currency !== before.currency) return { kind: 'refused', reason: 'currency_mismatch' }
  if (invoice.monthlyPrice === before.monthlyPrice && invoice.annualPrice === before.annualPrice) {
    return { kind: 'unchanged', offerId }
  }
  const after: SubscriptionOffer = { ...before, monthlyPrice: invoice.monthlyPrice, annualPrice: invoice.annualPrice }
  ctx.offers[offerId] = after
  return { kind: 'updated', offerId, before, after }
}
