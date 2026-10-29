// Chat loop: the SDK tool runner calls the model, runs the tools it asks for and repeats until the final
// answer. Events stream to the UI,
// and proposals reach the UI out of band, as confirmation cards the founder approves.
import Anthropic from '@anthropic-ai/sdk'
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { z } from 'zod'
import type { Proposal } from '../approvals/proposals.js'
import { SYSTEM_PROMPT } from './prompt.js'

// Haiku 5.5 matched Opus 5.5 on the demo scenes (plan explanation, proposal, injected invoice) at a fraction
// of the cost and latency: the model only explains numbers the tools computed. ANTHROPIC_MODEL overrides it
export const DEFAULT_MODEL = 'claude-haiku-5-5'
// Models that accept the server-side refusal fallback; Haiku has none
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])

export const ChatMessages = z
  .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().min(1).max(4000) }))
  .min(1)
  .max(40)
  .refine((m) => m.at(-1)?.role === 'user', 'The last message must be from the user')

export type ChatMessage = z.infer<typeof ChatMessages>[number]

export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string }
  // The UI shows a confirmation card with the terms and the fingerprint to approve
  | { type: 'proposal'; proposal: Proposal }
  | { type: 'end' }
  | { type: 'error'; message: string }

export async function* converse(
  messages: ChatMessage[],
  // Built with a callback that pushes into `queue`: see agentTools(..., onProposal)
  tools: BetaRunnableTool<any>[],
  queue: Proposal[],
  // `context`: conversationContext(...) — date and cards already issued
  options: { client?: Anthropic; context: string; signal?: AbortSignal },
): AsyncGenerator<ChatEvent> {
  const client = options.client ?? new Anthropic()
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL
  const drain = () => queue.splice(0).map((proposal): ChatEvent => ({ type: 'proposal', proposal }))

  const runner = client.beta.messages.toolRunner(
    {
      model,
      max_tokens: 16000,
      max_iterations: 8,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      // Tools, prompt and history are reused across the loop's turns
      cache_control: { type: 'ephemeral' },
      system: [
        { type: 'text', text: SYSTEM_PROMPT },
        { type: 'text', text: options.context },
      ],
      tools,
      messages: messages.map((m) => ({ role: m.role, content: m.text })),
      stream: true,
      // A false-positive refusal is retried server-side on another model, where the model supports it
      ...(FALLBACK_MODELS.has(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    },
    { signal: options.signal },
  )

  let last: Anthropic.Beta.BetaMessage | null = null
  for await (const stream of runner) {
    // Tools run between turns of the loop
    yield* drain()
    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        yield { type: 'tool', name: event.content_block.name }
      } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text }
      }
    }
    last = await stream.finalMessage()
    if (last.stop_reason === 'refusal') {
      yield* drain()
      yield { type: 'error', message: 'The model declined to answer. Try rephrasing.' }
      return
    }
  }

  yield* drain()
  if (last?.stop_reason === 'max_tokens') {
    yield { type: 'error', message: 'The answer was too long and got cut off.' }
  } else if (last?.stop_reason === 'tool_use') {
    yield { type: 'error', message: 'This needed too many tool calls. Try a narrower question.' }
  } else {
    yield { type: 'end' }
  }
}
