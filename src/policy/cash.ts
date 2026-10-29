// Cash decisions are computed here, never by the model. The agent only explains what these functions return.
import { addDays, addMonths, type Cents } from './money.js'

export interface Flow {
  date: string
  // Positive = money in, negative = money out
  amount: Cents
  label: string
}

export interface CashPosition {
  currency: 'USD'
  asOf: string
  balance: Cents
  // Cash that must stay untouched (taxes, payroll buffer)
  reserveFloor: Cents
  // Known future inflows and outflows after asOf
  flows: Flow[]
}

export interface WeekProjection {
  week: number
  start: string
  end: string
  lowest: Cents
  closing: Cents
  breach: boolean
}

export interface SubscriptionOffer {
  vendor: string
  product: string
  merchantCategoryCode: string
  currency: 'USD'
  monthlyPrice: Cents
  annualPrice: Cents
  startDate: string
}

export type Plan = 'annual' | 'monthly'

export interface PlanResult {
  plan: Plan
  charges: Flow[]
  yearlyCost: Cents
  weeks: WeekProjection[]
  firstBreachWeek: number | null
  lowest: Cents
}

export type Recommendation =
  | { kind: 'buy'; plan: Plan; reason: string; revisitOn: string | null }
  | { kind: 'escalate'; reason: string }

export interface PlanComparison {
  annual: PlanResult
  monthly: PlanResult
  savingsPercent: number
  savingsPerYear: Cents
  recommendation: Recommendation
}

export const HORIZON_WEEKS = 12
// When monthly wins only because annual breaks the reserve, look at annual again after this many days
export const REVISIT_AFTER_DAYS = 90

// Week-by-week projection starting at asOf. "lowest" catches dips inside a week, not just the closing balance.
export function projectWeeks(position: CashPosition, extra: Flow[] = [], weeks = HORIZON_WEEKS): WeekProjection[] {
  const flows = [...position.flows, ...extra]
    .filter((f) => f.date >= position.asOf)
    .sort((a, b) => (a.date === b.date ? a.amount - b.amount : a.date < b.date ? -1 : 1))
  // Same-day ordering puts outflows first: the conservative reading of a day

  let balance = position.balance
  let i = 0
  const result: WeekProjection[] = []
  for (let week = 1; week <= weeks; week++) {
    const start = addDays(position.asOf, (week - 1) * 7)
    const end = addDays(start, 6)
    let lowest = balance
    while (i < flows.length && flows[i]!.date <= end) {
      balance += flows[i]!.amount
      lowest = Math.min(lowest, balance)
      i++
    }
    result.push({ week, start, end, lowest, closing: balance, breach: lowest < position.reserveFloor })
  }
  return result
}

export function planCharges(offer: SubscriptionOffer, plan: Plan, weeks = HORIZON_WEEKS): Flow[] {
  if (plan === 'annual') {
    return [{ date: offer.startDate, amount: -offer.annualPrice, label: `${offer.product} (annual)` }]
  }
  const horizonEnd = addDays(offer.startDate, weeks * 7 - 1)
  const charges: Flow[] = []
  for (let m = 0; ; m++) {
    const date = addMonths(offer.startDate, m)
    if (date > horizonEnd) break
    charges.push({ date, amount: -offer.monthlyPrice, label: `${offer.product} (monthly)` })
  }
  return charges
}

function evaluate(position: CashPosition, offer: SubscriptionOffer, plan: Plan): PlanResult {
  const charges = planCharges(offer, plan)
  const weeks = projectWeeks(position, charges)
  const breach = weeks.find((w) => w.breach)
  return {
    plan,
    charges,
    yearlyCost: plan === 'annual' ? offer.annualPrice : offer.monthlyPrice * 12,
    weeks,
    firstBreachWeek: breach ? breach.week : null,
    lowest: Math.min(...weeks.map((w) => w.lowest)),
  }
}

export function comparePlans(position: CashPosition, offer: SubscriptionOffer): PlanComparison {
  const annual = evaluate(position, offer, 'annual')
  const monthly = evaluate(position, offer, 'monthly')
  const savingsPerYear = monthly.yearlyCost - annual.yearlyCost
  const savingsPercent = Math.round((savingsPerYear / monthly.yearlyCost) * 100)

  let recommendation: Recommendation
  if (annual.firstBreachWeek === null && savingsPerYear > 0) {
    recommendation = { kind: 'buy', plan: 'annual', reason: 'annual_is_cheaper_and_keeps_reserve', revisitOn: null }
  } else if (monthly.firstBreachWeek === null) {
    recommendation = {
      kind: 'buy',
      plan: 'monthly',
      reason: annual.firstBreachWeek === null ? 'monthly_is_cheaper' : 'annual_breaks_reserve',
      revisitOn: annual.firstBreachWeek === null ? null : addDays(position.asOf, REVISIT_AFTER_DAYS),
    }
  } else {
    // Neither plan keeps the reserve: a person decides
    recommendation = { kind: 'escalate', reason: 'both_plans_break_reserve' }
  }

  return { annual, monthly, savingsPercent, savingsPerYear, recommendation }
}
