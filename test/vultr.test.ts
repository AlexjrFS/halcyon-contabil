import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activeModel, activeProvider } from '../src/agent/chat.js'
import { agentTools } from '../src/agent/tools.js'
import { converseVultr, DEFAULT_VULTR_MODEL } from '../src/agent/vultr.js'
import type { PolicyContext, Proposal } from '../src/approvals/proposals.js'
import { MemoryStore } from '../src/approvals/store.js'
import { AS_OF, cashPosition, OFFERS } from '../src/demo/company.js'
import { INVOICES } from '../src/demo/invoices.js'
import { LEDGER } from '../src/demo/ledger.js'
import { reminderOutcome } from '../src/finance/followups.js'
import { buildLedgerView } from '../src/finance/ledger.js'
import type { ChatEvent } from '../src/agent/chat.js'

function setup() {
  let n = 0
  const queue: Proposal[] = []
  const ctx: PolicyContext = {
    position: cashPosition,
    offers: { ...OFFERS },
    now: () => new Date('2026-11-02T12:00:00Z'),
    newId: () => `proposal-${++n}`,
    reminderFor: (id) => reminderOutcome(LEDGER.receivables, [], AS_OF, { name: 'Ana Souza', company: 'Lumen Studio' }, id),
  }
  const tools = agentTools({
    store: new MemoryStore(),
    ctx,
    invoices: INVOICES,
    ledger: () => buildLedgerView(LEDGER, [], AS_OF),
    cards: { getCard: async () => undefined as never },
    onProposal: (p) => queue.push(p),
  })
  return { tools, queue }
}

type Wire = { role: string; content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }
const call = (id: string, name: string, args: string) => ({ id, type: 'function', function: { name, arguments: args } })
const reply = (message: object, finish_reason = 'stop') => new Response(JSON.stringify({ choices: [{ message, finish_reason }] }), { status: 200 })

// A scripted OpenAI-compatible endpoint: each request gets the next response and is recorded
function endpoint(...responses: (Response | (() => Response))[]) {
  const requests: { url: string; headers: Headers; body: { model: string; messages: Wire[]; tools: { type: string; function: { name: string; parameters: Record<string, unknown> } }[]; tool_choice: string } }[] = []
  const fakeFetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) })
    const next = responses.shift()
    assert.ok(next, 'unexpected extra request')
    return typeof next === 'function' ? next() : next
  }) as unknown as typeof fetch
  return { fakeFetch, requests }
}

async function collect(events: AsyncGenerator<ChatEvent>) {
  const out: ChatEvent[] = []
  for await (const e of events) out.push(e)
  return out
}

const opts = (fakeFetch: typeof fetch) => ({ context: 'Today is 2026-11-02.', apiKey: 'test-key', fetch: fakeFetch })

test('the loop sends the same tools in the OpenAI format and runs the ones the model asks for', async () => {
  const { tools, queue } = setup()
  const { fakeFetch, requests } = endpoint(
    reply({ content: null, tool_calls: [call('c1', 'review_payables', '{"only_flagged": true}')] }, 'tool_calls'),
    reply({ content: 'Four bills need a look before you pay them.' }),
  )
  const events = await collect(converseVultr([{ role: 'user', text: 'What should I check?' }], tools, queue, opts(fakeFetch)))

  assert.deepEqual(events.map((e) => e.type), ['tool', 'text', 'end'])
  assert.deepEqual(events[0], { type: 'tool', name: 'review_payables' })
  assert.deepEqual(events[1], { type: 'text', text: 'Four bills need a look before you pay them.' })

  const first = requests[0]!
  const second = requests[1]!
  assert.equal(first.url, 'https://api.vultrinference.com/v1/chat/completions')
  assert.equal(first.headers.get('authorization'), 'Bearer test-key')
  assert.equal(first.body.model, DEFAULT_VULTR_MODEL)
  assert.equal(first.body.tool_choice, 'auto')
  assert.equal(first.body.messages[0]!.role, 'system')
  assert.match(first.body.messages[0]!.content ?? '', /Code decides, you explain/)
  assert.match(first.body.messages[0]!.content ?? '', /Today is 2026-11-02/)
  // Same surface as with Claude: nothing that takes an amount, and no approve or execute tool
  const names = first.body.tools.map((t) => t.function.name).sort()
  assert.deepEqual(names, tools.map((t) => t.name).sort())
  assert.ok(first.body.tools.every((t) => t.type === 'function' && t.function.parameters.type === 'object'))
  assert.ok(first.body.tools.every((t) => !('$schema' in t.function.parameters)))

  // The tool result went back as a tool message, and the supplier note is still wrapped as untrusted text
  const toolMessage = second.body.messages.find((m) => m.role === 'tool')
  assert.equal(toolMessage?.tool_call_id, 'c1')
  assert.match(toolMessage?.content ?? '', /<untrusted_supplier_text>/)
  assert.ok(second.body.messages.some((m) => m.role === 'assistant' && m.tool_calls?.[0]?.id === 'c1'))
})

test('a propose tool reaches the UI as a proposal, and the model gets an id, not an approval', async () => {
  const { tools, queue } = setup()
  const receivableId = LEDGER.receivables[0]!.id
  const { fakeFetch, requests } = endpoint(
    reply({ content: null, tool_calls: [call('c1', 'propose_payment_reminder', JSON.stringify({ receivable_id: receivableId }))] }, 'tool_calls'),
    reply({ content: 'I drafted a reminder. You need to approve it.' }),
  )
  const events = await collect(converseVultr([{ role: 'user', text: 'Chase Birch' }], tools, queue, opts(fakeFetch)))
  const kinds = events.map((e) => e.type)
  assert.ok(kinds.includes('proposal'), `events: ${kinds.join(',')}`)
  assert.equal(kinds.at(-1), 'end')
  assert.equal(queue.length, 0, 'the queue is drained into events')
  const toolMessage = requests[1]!.body.messages.find((m) => m.role === 'tool')
  assert.doesNotMatch(toolMessage?.content ?? '', /fingerprint/)
})

test('bad tool arguments and unknown tools come back to the model as errors, not as crashes', async () => {
  const { tools, queue } = setup()
  const { fakeFetch, requests } = endpoint(
    reply({ content: null, tool_calls: [call('a', 'review_payables', '{not json'), call('b', 'pay_bill', '{}'), call('c', 'propose_payment_reminder', '{"receivable_id": 42}')] }, 'tool_calls'),
    reply({ content: 'Sorry, I could not do that.' }),
  )
  const events = await collect(converseVultr([{ role: 'user', text: 'hi' }], tools, queue, opts(fakeFetch)))
  assert.equal(events.at(-1)?.type, 'end')
  const results = requests[1]!.body.messages.filter((m) => m.role === 'tool').map((m) => m.content ?? '')
  assert.equal(results.length, 3)
  assert.ok(results.every((r) => r.startsWith('Error:')), results.join(' | '))
  assert.match(results[1] ?? '', /no tool called pay_bill/)
})

test('a model that never stops calling tools is cut off after 8 turns', async () => {
  const { tools, queue } = setup()
  const loop = () => reply({ content: null, tool_calls: [call('x', 'see_cash', '{}')] }, 'tool_calls')
  const { fakeFetch, requests } = endpoint(...Array.from({ length: 8 }, () => loop))
  const events = await collect(converseVultr([{ role: 'user', text: 'loop' }], tools, queue, opts(fakeFetch)))
  assert.equal(requests.length, 8)
  assert.equal(events.at(-1)?.type, 'error')
})

test('provider errors become readable messages and never echo the key', async () => {
  const { tools, queue } = setup()
  const run = async (status: number) => {
    const { fakeFetch } = endpoint(new Response('{"error":"nope"}', { status }))
    return collect(converseVultr([{ role: 'user', text: 'hi' }], tools, queue, opts(fakeFetch)))
  }
  await assert.rejects(run(401), /rejected the API key/)
  await assert.rejects(run(404), /does not know this model/)
  await assert.rejects(run(429), /rate limiting/)
  const noKey = await collect(converseVultr([{ role: 'user', text: 'hi' }], tools, queue, { context: '', fetch: endpoint().fakeFetch, apiKey: '' }))
  assert.equal(noKey[0]?.type, 'error')
})

test('the provider is picked from the environment', () => {
  assert.equal(activeProvider({}), 'anthropic')
  assert.equal(activeProvider({ ANTHROPIC_API_KEY: 'a' }), 'anthropic')
  assert.equal(activeProvider({ VULTR_INFERENCE_API_KEY: 'v' }), 'vultr')
  assert.equal(activeProvider({ VULTR_INFERENCE_API_KEY: 'v', ANTHROPIC_API_KEY: 'a' }), 'anthropic')
  assert.equal(activeProvider({ VULTR_INFERENCE_API_KEY: 'v', ANTHROPIC_API_KEY: 'a', LLM_PROVIDER: 'vultr' }), 'vultr')
  assert.equal(activeModel({ LLM_PROVIDER: 'vultr', VULTR_MODEL: 'my-model' }), 'my-model')
  assert.equal(activeModel({ LLM_PROVIDER: 'vultr' }), DEFAULT_VULTR_MODEL)
  assert.equal(activeModel({}), 'claude-haiku-5-5')
})
