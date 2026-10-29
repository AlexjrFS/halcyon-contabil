// Display only: amounts are computed by the API, the app just formats integer cents
export const formatCents = (cents: number, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)

// The rail's limits come in major units
export const formatMajor = (amount: number, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount)

export const MERCHANT_CATEGORIES: Record<string, string> = {
  '5734': 'Computer software stores',
  '5812': 'Restaurants',
}

export const describeCategory = (code: string) => (MERCHANT_CATEGORIES[code] ? `${code} · ${MERCHANT_CATEGORIES[code]}` : code)
