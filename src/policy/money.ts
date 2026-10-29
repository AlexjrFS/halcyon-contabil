// Money is integer cents everywhere in the app. The rail takes major units, so convert only at that boundary.
export type Cents = number

export const cents = (major: number): Cents => Math.round(major * 100)

export const toMajor = (value: Cents): number => {
  if (!Number.isInteger(value)) throw new Error(`Not an integer amount of cents: ${value}`)
  return value / 100
}

export const formatUSD = (value: Cents): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value / 100)

// Dates are plain YYYY-MM-DD strings (UTC) so projections never shift with the server timezone
export const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export const addMonths = (date: string, months: number): string => {
  const d = new Date(`${date}T00:00:00Z`)
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + months)
  // Clamp to the month's last day (Jan 31 + 1 month = Feb 28/29)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, last))
  return d.toISOString().slice(0, 10)
}
