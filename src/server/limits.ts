// Limits for the public demo, so nobody can run up the model bill or flood the VM. In memory, per process.
// Per IP for everything, plus a per-IP and a global ceiling on /chat: the global one is the real spending cap,
// because an address header is easy to fake when the server is reached directly.
export interface RateLimits {
  // Any API request from one address
  perMinute: number
  // Model calls (POST /chat) from one address, and from everyone together
  chatPerHour: number
  chatPerHourGlobal: number
}

export const DEFAULT_LIMITS: RateLimits = { perMinute: 90, chatPerHour: 40, chatPerHourGlobal: 200 }

const MINUTE = 60_000
const HOUR = 60 * MINUTE

function slidingWindow(windowMs: number, max: number) {
  const hits = new Map<string, number[]>()
  // Seconds until the next request is allowed, or 0 when this one is
  return (key: string, now: number): number => {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs)
    if (recent.length >= max) {
      hits.set(key, recent)
      return Math.max(1, Math.ceil((recent[0]! + windowMs - now) / 1000))
    }
    recent.push(now)
    hits.set(key, recent)
    if (hits.size > 5_000) for (const [k, v] of hits) if (v.every((t) => now - t >= windowMs)) hits.delete(k)
    return 0
  }
}

export function createRateLimiter(limits: RateLimits, clock: () => number = Date.now) {
  const perMinute = slidingWindow(MINUTE, limits.perMinute)
  const chatPerHour = slidingWindow(HOUR, limits.chatPerHour)
  const chatGlobal = slidingWindow(HOUR, limits.chatPerHourGlobal)
  // Returns seconds to wait, or 0 to let the request through
  return (method: string, pathname: string, ip: string): number => {
    if (method === 'OPTIONS' || pathname === '/health') return 0
    const now = clock()
    const wait = perMinute(ip, now)
    if (wait) return wait
    if (method === 'POST' && pathname === '/chat') return chatPerHour(ip, now) || chatGlobal('all', now)
    return 0
  }
}
