// The same agent loop over an OpenAI-compatible chat endpoint: Vultr Serverless Inference. The tools are the
// ones in tools.ts, unchanged: read tools and propose-by-id tools. The model still has no tool that moves money.
// Non-streaming on purpose: fewer moving parts against an endpoint we only know from its docs.
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import type { Proposal } from '../approvals/proposals.js'
import { SYSTEM_PROMPT } from './prompt.js'
import type { ChatEvent, ChatMessage } from './chat.js'

export const VULTR_BASE_URL = 'https://api.vultrinference.com/v1'
// The model named in Vultr's own tool-calling guide. The catalog changes: VULTR_MODEL overrides it
export const DEFAULT_VULTR_MODEL = 'glm-5.3'

const MAX_ITERATIONS = 8
const REQUEST_TIMEOUT_MS = 60_000

interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}
type WireMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface VultrOptions {
  context: string
  signal?: AbortSignal
  // Injected by tests
  fetch?: typeof fetch
  apiKey?: string
  baseUrl?: string
  model?: string
}

const toolContent = (out: unknown): string => {
  if (typeof out === 'string') return out
  if (Array.isArray(out)) return out.map((b) => (b && typeof b === 'object' && 'text' in b ? String(b.text) : JSON.stringify(b))).join('\n')
  return JSON.stringify(out)
}

function wireTools(tools: BetaRunnableTool<any>[]) {
  return (tools as unknown as { name: string; description?: string; input_schema?: Record<string, unknown> }[]).map((t) => {
    const { $schema: _ignored, ...parameters } = t.input_schema ?? { type: 'object', properties: {} }
    return { type: 'function' as const, function: { name: t.name, description: t.description ?? '', parameters } }
  })
}

async function callModel(body: object, o: Required<Pick<VultrOptions, 'apiKey' | 'baseUrl'>> & { fetch: typeof fetch; signal?: AbortSignal }) {
  const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(o.signal ? [o.signal] : [])]
  const response = await o.fetch(`${o.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.any(signals),
  })
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200)
    if (response.status === 401 || response.status === 403) throw new Error('Vultr Inference rejected the API key (check VULTR_INFERENCE_API_KEY).')
    if (response.status === 404) throw new Error(`Vultr Inference does not know this model (check VULTR_MODEL). ${detail}`.trim())
    if (response.status === 429) throw new Error('Vultr Inference is rate limiting this key. Try again in a minute.')
    throw new Error(`Vultr Inference error ${response.status}. ${detail}`.trim())
  }
  return (await response.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string }[]
  }
}

export async function* converseVultr(
  messages: ChatMessage[],
  tools: BetaRunnableTool<any>[],
  queue: Proposal[],
  options: VultrOptions,
): AsyncGenerator<ChatEvent> {
  const apiKey = options.apiKey ?? process.env.VULTR_INFERENCE_API_KEY
  if (!apiKey) {
    yield { type: 'error', message: 'VULTR_INFERENCE_API_KEY is not set.' }
    return
  }
  const settings = {
    apiKey,
    baseUrl: options.baseUrl ?? (process.env.VULTR_INFERENCE_URL || VULTR_BASE_URL),
    fetch: options.fetch ?? fetch,
    signal: options.signal,
  }
  const model = options.model ?? (process.env.VULTR_MODEL || DEFAULT_VULTR_MODEL)
  const byName = new Map(tools.map((t) => [t.name, t]))
  const wired = wireTools(tools)
  const drain = () => queue.splice(0).map((proposal): ChatEvent => ({ type: 'proposal', proposal }))

  const wire: WireMessage[] = [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n${options.context}` },
    ...messages.map((m): WireMessage => ({ role: m.role, content: m.text })),
  ]

  for (let turn = 0; turn < MAX_ITERATIONS; turn++) {
    const result = await callModel({ model, messages: wire, tools: wired, tool_choice: 'auto', temperature: 0.2, max_tokens: 4000 }, settings)
    const choice = result.choices?.[0]
    const message = choice?.message
    if (!message) {
      yield* drain()
      yield { type: 'error', message: 'Vultr Inference returned no answer.' }
      return
    }

    const calls = message.tool_calls ?? []
    if (calls.length === 0) {
      yield* drain()
      if (message.content) yield { type: 'text', text: message.content }
      if (choice?.finish_reason === 'length') yield { type: 'error', message: 'The answer was too long and got cut off.' }
      else yield { type: 'end' }
      return
    }

    wire.push({ role: 'assistant', content: message.content ?? null, tool_calls: calls })
    for (const call of calls) {
      yield { type: 'tool', name: call.function.name }
      let content: string
      const tool = byName.get(call.function.name)
      if (!tool) {
        content = `Error: there is no tool called ${call.function.name}.`
      } else {
        try {
          const raw = call.function.arguments?.trim() ? JSON.parse(call.function.arguments) : {}
          content = toolContent(await tool.run(tool.parse(raw)))
        } catch (error) {
          content = `Error: ${error instanceof Error ? error.message : String(error)}`
        }
      }
      wire.push({ role: 'tool', tool_call_id: call.id, content })
    }
    yield* drain()
  }

  yield* drain()
  yield { type: 'error', message: 'This needed too many tool calls. Try a narrower question.' }
}
