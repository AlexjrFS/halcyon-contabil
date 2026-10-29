// Calls to the Halcyon-contabil API. The app never sends amounts: it asks the agent, echoes the fingerprint of the
// proposal it showed, and triggers named test charges.
import { fetch } from 'expo/fetch'
import { loadSettings } from '../config/settings'
import type { CardView, ChargeKind, ChargeResult, ChatEvent, ChatMessage, DemoState, Proposal } from './types'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const { apiUrl, token } = await loadSettings()
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await response.json().catch(() => ({}))) as { error?: string; message?: string }
  if (!response.ok) throw new ApiError(response.status, data.error ?? 'error', data.message ?? `HTTP ${response.status}`)
  return data as T
}

export const api = {
  health: () => request<{ ok: boolean; model: string }>('GET', '/health'),
  state: () => request<DemoState>('GET', '/state'),
  approve: (proposal: Proposal) =>
    request<Proposal>('POST', `/proposals/${proposal.id}/approve`, { fingerprint: proposal.fingerprint }),
  reject: (proposal: Proposal) => request<Proposal>('POST', `/proposals/${proposal.id}/reject`),
  card: (offerId: string) => request<CardView>('GET', `/cards/${offerId}`),
  charge: (offerId: string, kind: ChargeKind) => request<ChargeResult>('POST', '/charges', { offer_id: offerId, kind }),
  receiveInvoice: (invoiceId: string) => request<{ kind: string }>('POST', `/invoices/${invoiceId}/receive`),
  reset: () => request<DemoState>('POST', '/demo/reset'),
}

// The chat answer arrives as NDJSON: one event per line, possibly split across chunks
export async function streamChat(
  messages: ChatMessage[],
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { apiUrl, token } = await loadSettings()
  const response = await fetch(`${apiUrl}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ messages }),
    signal,
  })
  if (!response.ok || !response.body) {
    const data = (await response.json().catch(() => ({}))) as { error?: string; message?: string }
    throw new ApiError(response.status, data.error ?? 'error', data.message ?? `HTTP ${response.status}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) onEvent(JSON.parse(line) as ChatEvent)
      newline = buffer.indexOf('\n')
    }
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as ChatEvent)
}
