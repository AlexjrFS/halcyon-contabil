import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRateLimiter } from '../src/server/limits.js'
import { createHandler } from '../src/server/app.js'

test('per-address limit per minute, and it frees up as the window moves', () => {
  let t = 0
  const limit = createRateLimiter({ perMinute: 3, chatPerHour: 100, chatPerHourGlobal: 100 }, () => t)
  assert.equal(limit('GET', '/state', '1.1.1.1'), 0)
  assert.equal(limit('GET', '/state', '1.1.1.1'), 0)
  assert.equal(limit('GET', '/state', '1.1.1.1'), 0)
  assert.equal(limit('GET', '/state', '1.1.1.1'), 60)
  // Someone else is not affected, and health is never limited
  assert.equal(limit('GET', '/state', '2.2.2.2'), 0)
  assert.equal(limit('GET', '/health', '1.1.1.1'), 0)
  t = 61_000
  assert.equal(limit('GET', '/state', '1.1.1.1'), 0)
})

test('chat has an hourly limit per address and a global one', () => {
  let t = 0
  const limit = createRateLimiter({ perMinute: 1000, chatPerHour: 2, chatPerHourGlobal: 3 }, () => t)
  assert.equal(limit('POST', '/chat', 'a'), 0)
  assert.equal(limit('POST', '/chat', 'a'), 0)
  assert.ok(limit('POST', '/chat', 'a') > 0)
  assert.equal(limit('POST', '/chat', 'b'), 0)
  // Three model calls in the hour across everyone: the fourth is refused even for a new address
  assert.ok(limit('POST', '/chat', 'c') > 0)
  // Other routes do not count against the chat ceiling
  assert.equal(limit('GET', '/ledger', 'c'), 0)
  t = 3_600_001
  assert.equal(limit('POST', '/chat', 'c'), 0)
})

test('the handler answers 429 with Retry-After', async () => {
  const handle = createHandler(async () => {
    throw new Error('not reached')
  }, { limits: { perMinute: 1, chatPerHour: 1, chatPerHourGlobal: 1 }, clock: () => 0 })
  const ask = () => handle(new Request('http://x/state', { headers: { 'x-client-ip': '9.9.9.9' } }))
  await ask().catch(() => {})
  const res = await ask()
  assert.equal(res.status, 429)
  assert.equal(res.headers.get('retry-after'), '60')
  assert.equal((await res.json() as { error: string }).error, 'rate_limited')
})
