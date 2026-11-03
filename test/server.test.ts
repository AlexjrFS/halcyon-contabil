import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ChatEvent } from '../src/agent/chat.js'
import { RailError } from '../src/rail/types.js'
import { JsonFileStore } from '../src/approvals/store.js'
import { FileStateStore } from '../src/app/state.js'
import { openSession } from '../src/app/session.js'
import { createServer } from 'node:http'
import { createHandler, toNodeListener, type Converse } from '../src/server/app.js'
import { fakeApi } from './fakes.js'

// Stands in for the model: says something, calls propose_card, then hands over the proposals
const fakeChat: Converse = async function* (_messages, tools, queue) {
  yield { type: 'text', text: 'Monthly fits the reserve. ' }
  yield { type: 'tool', name: 'propose_card' }
  await tools.find((t) => t.name === 'propose_card')!.run({ offer_id: 'framewise' } as never)
  for (const proposal of queue.splice(0)) yield { type: 'proposal', proposal }
  yield { type: 'end' }
}

type Call = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any; text: string }>

async function withServer(fn: (call: Call, fake: ReturnType<typeof fakeApi>) => Promise<void>, token?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'halcyon-contabil-server-'))
  const fake = fakeApi()
  const session = await openSession({
    api: fake.api,
    store: new JsonFileStore(join(dir, 'proposals.json')),
    stateStore: new FileStateStore(join(dir, 'state.json')),
    sleep: async () => {},
  })
  const server = createServer(toNodeListener(createHandler(async () => session, { chat: fakeChat, token }))).listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call: Call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {}
    return { status: res.status, body: parsed, text }
  }
  try {
    await fn(call, fake)
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
}

const chatEvents = (text: string) => text.trim().split('\n').map((line) => JSON.parse(line) as ChatEvent)

test('chat streams events as NDJSON, including the proposal card', async () => {
  await withServer(async (call) => {
    const res = await call('POST', '/chat', { messages: [{ role: 'user', text: 'Annual or monthly?' }] })
    assert.equal(res.status, 200)
    const events = chatEvents(res.text)
    assert.deepEqual(events.map((e) => e.type), ['text', 'tool', 'proposal', 'end'])
    const proposal = (events[2] as Extract<ChatEvent, { type: 'proposal' }>).proposal
    assert.equal(proposal.status, 'pending')

    const bad = await call('POST', '/chat', { messages: [{ role: 'assistant', text: 'hi' }] })
    assert.equal(bad.status, 400)
  })
})

test('approve needs the fingerprint that was shown, then issues the card', async () => {
  await withServer(async (call, fake) => {
    const events = chatEvents((await call('POST', '/chat', { messages: [{ role: 'user', text: 'Buy it' }] })).text)
    const { proposal } = events.find((e) => e.type === 'proposal') as Extract<ChatEvent, { type: 'proposal' }>

    assert.equal((await call('POST', `/proposals/${proposal.id}/approve`, {})).status, 400)
    const wrong = await call('POST', `/proposals/${proposal.id}/approve`, { fingerprint: 'nope' })
    assert.equal(wrong.status, 409)
    assert.equal(wrong.body.error, 'fingerprint_mismatch')
    assert.equal(fake.calls.creates, 0)

    const ok = await call('POST', `/proposals/${proposal.id}/approve`, { fingerprint: proposal.fingerprint })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.status, 'executed')
    assert.equal(ok.body.display.charge, '$600.00')
    const card = (await call('GET', '/cards/framewise')).body
    assert.equal(card.cardId, 'card-1')
    assert.deepEqual(card.limits.limits[1], { amount: 600, interval: 'MONTHLY', remaining: 600 })
    assert.deepEqual(card.transactions, [])
    assert.equal((await call('GET', '/proposals')).body.length, 1)
    assert.equal((await call('POST', `/proposals/${proposal.id}/approve`, { fingerprint: proposal.fingerprint })).status, 409)
  })
})

test('an approval pending when the invoice arrives goes stale', async () => {
  await withServer(async (call, fake) => {
    const events = chatEvents((await call('POST', '/chat', { messages: [{ role: 'user', text: 'Buy it' }] })).text)
    const { proposal } = events.find((e) => e.type === 'proposal') as Extract<ChatEvent, { type: 'proposal' }>
    assert.equal((await call('POST', '/invoices/framewise-2026-12/receive')).body.kind, 'updated')
    const res = await call('POST', `/proposals/${proposal.id}/approve`, { fingerprint: proposal.fingerprint })
    assert.equal(res.body.status, 'stale')
    assert.equal(fake.calls.creates, 0)
    assert.equal((await call('GET', '/state')).body.offers[0].monthly, '$690.00')
  })
})

test('charges are named scenarios priced by the offer, and rail errors pass through', async () => {
  await withServer(async (call, fake) => {
    assert.equal((await call('POST', '/charges', { offer_id: 'framewise', kind: 'annual' })).status, 404)
    const events = chatEvents((await call('POST', '/chat', { messages: [{ role: 'user', text: 'Buy it' }] })).text)
    const { proposal } = events.find((e) => e.type === 'proposal') as Extract<ChatEvent, { type: 'proposal' }>
    await call('POST', `/proposals/${proposal.id}/approve`, { fingerprint: proposal.fingerprint })

    const annual = await call('POST', '/charges', { offer_id: 'framewise', kind: 'annual' })
    assert.equal(annual.status, 200)
    assert.equal(annual.body.charge.display, '$5,904.00')
    assert.equal(fake.calls.simulations[0]!.transaction_amount, 5904)
    assert.equal((await call('POST', '/charges', { offer_id: 'framewise', kind: 'free_money', amount: 1 })).status, 400)

    fake.api.simulateAuthorization = async () => {
      throw new RailError(400, 'bad_request', 'failed to process transaction')
    }
    const failed = await call('POST', '/charges', { offer_id: 'framewise', kind: 'monthly' })
    assert.equal(failed.status, 502)
    assert.equal(failed.body.error, 'bad_request')
  })
})

test('reset clears the take; CORS preflight and unknown routes behave', async () => {
  await withServer(async (call) => {
    await call('POST', '/chat', { messages: [{ role: 'user', text: 'Buy it' }] })
    const reset = await call('POST', '/demo/reset')
    assert.deepEqual(reset.body.cards, {})
    assert.deepEqual((await call('GET', '/proposals')).body, [])
    assert.equal((await call('OPTIONS', '/chat')).status, 204)
    assert.equal((await call('GET', '/nope')).status, 404)
  })
})

test('with a demo token, everything but /health needs it', async () => {
  await withServer(async (call) => {
    const health = await call('GET', '/health')
    assert.equal(health.status, 200)
    assert.equal(health.body.model, 'claude-haiku-5-5')
    assert.equal((await call('GET', '/state')).status, 401)
    assert.equal((await call('GET', '/state', undefined, { authorization: 'Bearer wrong' })).status, 401)
    assert.equal((await call('GET', '/state', undefined, { authorization: 'Bearer s3cret' })).status, 200)
  }, 's3cret')
})

test('GET /ledger returns the books computed by code', async () => {
  await withServer(async (call) => {
    const res = await call('GET', '/ledger')
    assert.equal(res.status, 200)
    assert.equal(res.body.asOf, '2026-11-02')
    assert.equal(res.body.payables.length, 16)
    assert.equal(res.body.totals.flaggedBills, 4)
    assert.equal(res.body.receivables.filter((r: { eligible: boolean }) => r.eligible).length, 3)
  })
})

test('GET /ledger needs the demo token when one is set', async () => {
  await withServer(async (call) => {
    assert.equal((await call('GET', '/ledger')).status, 401)
    assert.equal((await call('GET', '/ledger', undefined, { authorization: 'Bearer secret' })).status, 200)
  }, 'secret')
})
