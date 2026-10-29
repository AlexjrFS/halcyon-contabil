// End-to-end check of the whole decision path with the built-in rail, no network and no model:
// policy decision → proposal → approval bound to a fingerprint → card issued → charges accepted or declined
// → price increase invoice → update proposal → freeze. Run with `npm run smoke`.
import { openSession } from '../src/app/session.js'
import { MemoryStore } from '../src/approvals/store.js'
import { proposeCard, proposeCardUpdate, proposeFreeze } from '../src/approvals/proposals.js'
import { MemoryStateStore } from '../src/app/state.js'
import { PRICE_INCREASE } from '../src/demo/invoices.js'
import { SimulatedRail } from '../src/rail/simulated.js'

const step = (text: string) => console.log(`\n▶ ${text}`)
const session = await openSession({ api: new SimulatedRail(), store: new MemoryStore(), stateStore: new MemoryStateStore() })
const { ctx, store } = session
let failures = 0
const expect = (label: string, actual: unknown, wanted: unknown) => {
  const ok = actual === wanted
  if (!ok) failures++
  console.log(`  ${ok ? '✓' : '✗'} ${label}: ${String(actual)}${ok ? '' : ` (wanted ${String(wanted)})`}`)
}

step('Policy decision and card')
const first = await proposeCard(store, ctx, 'framewise')
if (first.kind !== 'proposal') throw new Error('expected a proposal')
const executed = await session.approve(first.proposal.id, first.proposal.fingerprint)
expect('card issued', executed.status, 'executed')

step('Charges through the rail')
for (const [kind, wanted] of [
  ['monthly', 'APPROVED'],
  ['other_currency', 'CURRENCY_NOT_ALLOWED'],
  ['other_category', 'MERCHANT_CATEGORY_NOT_ALLOWED'],
  ['annual', 'LIMIT_EXCEEDED'],
] as const) {
  const offer = ctx.offers.framewise!
  const charge =
    kind === 'monthly' ? { amount: offer.monthlyPrice }
    : kind === 'annual' ? { amount: offer.annualPrice }
    : kind === 'other_currency' ? { amount: offer.monthlyPrice, currency: 'EUR' }
    : { amount: offer.monthlyPrice, merchantCategoryCode: '5812' }
  const result = await session.simulateCharge('framewise', charge)
  expect(kind, result.failure_reason ?? result.process_result, wanted)
}

step('Price increase: the card refuses until a new approval')
await session.receiveInvoice(PRICE_INCREASE.id)
const update = await proposeCardUpdate(store, ctx, executed.result!.cardId, 'framewise', 'monthly')
if (update.kind !== 'proposal') throw new Error('expected an update proposal')
await session.approve(update.proposal.id, update.proposal.fingerprint)
const card = await session.card('framewise')
// $690 per charge, and $90 left of this month's $690 after the $600 already charged
expect('limits after the update', card?.limits.limits.map((l) => l.remaining).join(','), '690,90')

step('Freeze')
const freeze = await proposeFreeze(store, ctx, executed.result!.cardId, 'suspicious invoice')
await session.approve(freeze.id, freeze.fingerprint)
const frozen = await session.simulateCharge('framewise', { amount: 100 })
expect('charge on a frozen card', frozen.failure_reason, 'CARD_NOT_ACTIVE')

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
