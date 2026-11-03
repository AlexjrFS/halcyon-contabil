// HTTP API for the app, as a fetch-style handler (Request → Response), served from node:http by toNodeListener. The app never sends amounts: charges are named scenarios and
// approvals echo the fingerprint they showed.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { RailError } from '../rail/types.js'
import { activeModel, activeProvider, ChatMessages, converse, type ChatEvent } from '../agent/chat.js'
import { ProposalError, type Proposal } from '../approvals/proposals.js'
import type { Session } from '../app/session.js'
import { formatUSD, type Cents } from '../policy/money.js'
import { createRateLimiter, type RateLimits } from './limits.js'

export type Converse = typeof converse

export interface AppOptions {
  chat?: Converse
  // When set, every route but /health needs `Authorization: Bearer <token>`
  token?: string
  // Public-demo limits; none when unset
  limits?: RateLimits
  clock?: () => number
}

const MAX_BODY = 64 * 1024

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

// Demo charges the card screen can trigger. Amounts come from the offer, never from the request
export const CHARGES = {
  monthly: (o) => ({ amount: o.monthlyPrice }),
  annual: (o) => ({ amount: o.annualPrice }),
  other_currency: (o) => ({ amount: o.monthlyPrice, currency: 'EUR' }),
  other_category: (o) => ({ amount: o.monthlyPrice, merchantCategoryCode: '5812' }),
} satisfies Record<
  string,
  (offer: { monthlyPrice: Cents; annualPrice: Cents }) => { amount: Cents; currency?: string; merchantCategoryCode?: string }
>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } })

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text()
  if (text.length > MAX_BODY) throw new HttpError(413, 'too_large', 'Request body too large')
  if (!text) return {}
  try {
    const body = JSON.parse(text)
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>
  } catch {}
  throw new HttpError(400, 'invalid_json', 'Body must be a JSON object')
}

const describeProposal = (p: Proposal) => ({
  ...p,
  display: 'terms' in p.action ? { charge: formatUSD(p.action.terms.amount) } : null,
})

export function createHandler(getSession: () => Promise<Session>, options: AppOptions = {}) {
  const chat = options.chat ?? converse
  const limiter = options.limits ? createRateLimiter(options.limits, options.clock) : undefined

  async function handleChat(request: Request, session: Session): Promise<Response> {
    const parsed = ChatMessages.safeParse((await readJson(request)).messages)
    if (!parsed.success) throw new HttpError(400, 'invalid_messages', parsed.error.issues[0]?.message ?? 'Invalid messages')
    const abort = new AbortController()
    request.signal.addEventListener('abort', () => abort.abort())
    const queue: Proposal[] = []
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (event: ChatEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        try {
          const events = chat(parsed.data, session.tools((p) => queue.push(p)), queue, {
            context: session.context(),
            signal: abort.signal,
          })
          for await (const event of events) write(event)
        } catch (error) {
          if (!abort.signal.aborted) write({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        }
        controller.close()
      },
      cancel() {
        abort.abort()
      },
    })
    return new Response(body, {
      headers: { ...CORS, 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' },
    })
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(Boolean)
    const method = request.method
    const is = (m: string, ...path: string[]) =>
      method === m && parts.length === path.length && path.every((p, i) => p === '*' || p === parts[i])

    if (is('GET', 'health')) return json(200, { ok: true, provider: activeProvider(), model: activeModel() })
    if (options.token && request.headers.get('authorization') !== `Bearer ${options.token}`) {
      throw new HttpError(401, 'unauthorized', 'Missing or wrong demo token')
    }

    const session = await getSession()
    if (is('POST', 'chat')) return handleChat(request, session)

    if (is('GET', 'state')) {
      const offers = Object.entries(session.ctx.offers).map(([id, o]) => ({
        offer_id: id,
        vendor: o.vendor,
        product: o.product,
        monthly: formatUSD(o.monthlyPrice),
        annual: formatUSD(o.annualPrice),
      }))
      return json(200, { ...session.state(), offers })
    }

    if (is('GET', 'ledger')) return json(200, session.ledger())

    if (is('GET', 'proposals')) {
      const all = (await session.store.list()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return json(200, all.map(describeProposal))
    }
    if (is('POST', 'proposals', '*', 'approve')) {
      const { fingerprint } = await readJson(request)
      if (typeof fingerprint !== 'string') throw new HttpError(400, 'missing_fingerprint', 'fingerprint is required')
      return json(200, describeProposal(await session.approve(parts[1]!, fingerprint)))
    }
    if (is('POST', 'proposals', '*', 'reject')) return json(200, describeProposal(await session.reject(parts[1]!)))

    if (is('GET', 'cards', '*')) {
      const card = await session.card(parts[1]!)
      if (!card) throw new HttpError(404, 'no_card', `No card issued for ${parts[1]}`)
      return json(200, card)
    }
    if (is('POST', 'invoices', '*', 'receive')) return json(200, await session.receiveInvoice(parts[1]!))

    if (is('POST', 'charges')) {
      const { offer_id, kind } = await readJson(request)
      const offer = typeof offer_id === 'string' ? session.ctx.offers[offer_id] : undefined
      const build = typeof kind === 'string' ? CHARGES[kind as keyof typeof CHARGES] : undefined
      if (!offer || !build) {
        throw new HttpError(400, 'invalid_charge', `offer_id and kind (${Object.keys(CHARGES).join(', ')}) are required`)
      }
      if (!session.state().cards[offer_id as string]) throw new HttpError(404, 'no_card', `No card issued for ${offer_id}`)
      const charge = build(offer)
      const result = await session.simulateCharge(offer_id as string, charge)
      return json(200, { kind, charge: { ...charge, display: formatUSD(charge.amount) }, result })
    }

    if (is('POST', 'demo', 'reset')) {
      await session.reset()
      return json(200, session.state())
    }

    throw new HttpError(404, 'not_found', `${method} ${url.pathname}`)
  }

  return async function handle(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
    if (limiter) {
      const wait = limiter(request.method, new URL(request.url).pathname, request.headers.get('x-client-ip') ?? 'unknown')
      if (wait) {
        const res = json(429, { error: 'rate_limited', message: `Too many requests. Try again in ${wait} s.`, retry_after: wait })
        res.headers.set('retry-after', String(wait))
        return res
      }
    }
    try {
      return await route(request)
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { error: error.code, message: error.message })
      if (error instanceof ProposalError) {
        return json(error.code === 'not_found' ? 404 : 409, { error: error.code, message: error.message })
      }
      // The rail said no: pass its code through
      if (error instanceof RailError) {
        return json(502, { error: error.code, message: error.message, details: error.details })
      }
      console.error(error)
      return json(500, { error: 'internal', message: 'Something went wrong' })
    }
  }
}

const clientIp = (req: IncomingMessage) =>
  String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown'

// Serve the fetch handler from node:http, streaming the body as it is produced
export function toNodeListener(handle: (request: Request) => Promise<Response>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const abort = new AbortController()
    res.on('close', () => abort.abort())
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
    const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, {
      method: req.method,
      // The address the limits count: what the reverse proxy saw, else the socket. Set here, never taken from the client
      headers: { ...(req.headers as Record<string, string>), 'x-client-ip': clientIp(req) },
      body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
      signal: abort.signal,
      // @ts-expect-error Node needs this for a streamed request body; not in the DOM typings
      duplex: 'half',
    })
    const response = await handle(request)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (response.body) for await (const chunk of response.body) res.write(chunk)
    res.end()
  }
}
