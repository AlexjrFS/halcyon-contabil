import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AS_OF, cashPosition, SAAS_OFFER } from '../src/demo/company.js'
import { cardRequest, cardUpdate, controlsFor } from '../src/policy/card.js'
import { comparePlans, planCharges, projectWeeks } from '../src/policy/cash.js'
import { addMonths, cents, toMajor } from '../src/policy/money.js'

test('demo scenario: annual saves 18% but breaks the reserve in week 7, so monthly wins', () => {
  const result = comparePlans(cashPosition(), SAAS_OFFER)
  assert.equal(result.savingsPercent, 18)
  assert.equal(result.savingsPerYear, cents(1_296))
  assert.equal(result.annual.firstBreachWeek, 7)
  assert.equal(result.monthly.firstBreachWeek, null)
  assert.deepEqual(result.recommendation, {
    kind: 'buy',
    plan: 'monthly',
    reason: 'annual_breaks_reserve',
    revisitOn: '2027-01-31',
  })
})

test('the annual breach is the quarterly tax payment in week 7', () => {
  const weeks = comparePlans(cashPosition(), SAAS_OFFER).annual.weeks
  const week7 = weeks[6]!
  assert.equal(week7.start, '2026-12-14')
  assert.equal(week7.lowest, cents(7_096))
  assert.ok(weeks.slice(0, 6).every((w) => !w.breach))
})

test('annual wins when it keeps the reserve', () => {
  const position = { ...cashPosition(), balance: cents(30_000) }
  const result = comparePlans(position, SAAS_OFFER)
  assert.deepEqual(result.recommendation, {
    kind: 'buy',
    plan: 'annual',
    reason: 'annual_is_cheaper_and_keeps_reserve',
    revisitOn: null,
  })
})

test('escalates to a person when neither plan keeps the reserve', () => {
  const position = { ...cashPosition(), balance: cents(9_000) }
  assert.deepEqual(comparePlans(position, SAAS_OFFER).recommendation, {
    kind: 'escalate',
    reason: 'both_plans_break_reserve',
  })
})

test('projection catches a dip inside a week, not only the closing balance', () => {
  const position = {
    currency: 'USD' as const,
    asOf: '2026-11-02',
    balance: cents(1_000),
    reserveFloor: cents(500),
    flows: [
      { date: '2026-11-03', amount: cents(-800), label: 'out' },
      { date: '2026-11-04', amount: cents(800), label: 'in' },
    ],
  }
  const [week1] = projectWeeks(position, [], 1)
  assert.equal(week1!.closing, cents(1_000))
  assert.equal(week1!.lowest, cents(200))
  assert.equal(week1!.breach, true)
})

test('same-day flows count the outflow first', () => {
  const position = {
    currency: 'USD' as const,
    asOf: '2026-11-02',
    balance: cents(100),
    reserveFloor: 0,
    flows: [
      { date: '2026-11-02', amount: cents(500), label: 'in' },
      { date: '2026-11-02', amount: cents(-300), label: 'out' },
    ],
  }
  assert.equal(projectWeeks(position, [], 1)[0]!.lowest, cents(-200))
})

test('monthly charges repeat on the same day inside the horizon', () => {
  assert.deepEqual(
    planCharges(SAAS_OFFER, 'monthly').map((c) => c.date),
    ['2026-11-02', '2026-12-02', '2027-01-02'],
  )
  assert.equal(planCharges(SAAS_OFFER, 'annual').length, 1)
  assert.equal(addMonths('2027-01-31', 1), '2027-02-28')
  assert.equal(AS_OF, SAAS_OFFER.startDate)
})

test('monthly decision becomes a card that only clears the monthly price, in USD, at the vendor category', () => {
  const controls = controlsFor(SAAS_OFFER, 'monthly')
  assert.deepEqual(controls, {
    allowed_transaction_count: 'MULTIPLE',
    transaction_limits: {
      currency: 'USD',
      limits: [
        { amount: 600, interval: 'PER_TRANSACTION' },
        { amount: 600, interval: 'MONTHLY' },
      ],
    },
    allowed_currencies: ['USD'],
    allowed_merchant_categories: ['5734'],
  })
})

test('annual decision is a single charge capped for all time', () => {
  const controls = controlsFor(SAAS_OFFER, 'annual')
  assert.equal(controls.allowed_transaction_count, 'SINGLE')
  assert.deepEqual(controls.transaction_limits.limits, [
    { amount: 5_904, interval: 'PER_TRANSACTION' },
    { amount: 5_904, interval: 'ALL_TIME' },
  ])
})

test('card request reuses the decision id as request_id and records the revisit date', () => {
  const request = cardRequest(
    { id: 'decision-1', plan: 'monthly', offer: SAAS_OFFER, revisitOn: '2027-01-31' },
    'holder-1',
    'Ana Souza',
  )
  assert.equal(request.request_id, 'decision-1')
  assert.equal(request.form_factor, 'VIRTUAL')
  assert.equal(request.metadata?.revisit_on, '2027-01-31')
  assert.ok(Object.keys(request.metadata ?? {}).every((k) => k.length <= 20))
})

test('card update resends every control, including empty cash limits', () => {
  const update = cardUpdate({ ...SAAS_OFFER, monthlyPrice: cents(690) }, 'monthly')
  assert.deepEqual(update.authorization_controls?.transaction_limits.cash_withdrawal_limits, [])
  assert.deepEqual(update.authorization_controls?.allowed_merchant_categories, ['5734'])
  assert.equal(update.authorization_controls?.transaction_limits.limits[0]?.amount, 690)
  assert.equal('allowed_transaction_count' in (update.authorization_controls ?? {}), false)
})

test('toMajor refuses fractional cents', () => {
  assert.equal(toMajor(cents(12.34)), 12.34)
  assert.throws(() => toMajor(1.5))
})
