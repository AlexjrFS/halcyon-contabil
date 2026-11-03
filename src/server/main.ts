// npm run server: the API and the web app on one port, with state under DATA_DIR (a Docker volume on the VM).
// Binds 0.0.0.0 so a reverse proxy (or a phone on the same Wi-Fi) can reach it.
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { JsonFileStore } from '../approvals/store.js'
import { FileStateStore } from '../app/state.js'
import { openSession } from '../app/session.js'
import { FileRailStore, SimulatedRail } from '../rail/simulated.js'
import { createHandler, toNodeListener } from './app.js'
import { DEFAULT_LIMITS } from './limits.js'
import { isApiPath, serveStatic } from './static.js'

const port = Number(process.env.PORT ?? 3000)
const dataDir = process.env.DATA_DIR ?? 'data'
const publicDir = resolve(process.env.PUBLIC_DIR ?? 'public')

const rail = new SimulatedRail({ store: new FileRailStore(`${dataDir}/rail.json`) })
const session = await openSession({
  api: rail,
  store: new JsonFileStore(`${dataDir}/proposals.json`),
  stateStore: new FileStateStore(`${dataDir}/state.json`),
})
const num = (name: string, fallback: number) => {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}
// RATE_LIMIT=off turns the limits off (local use only)
const limits =
  process.env.RATE_LIMIT === 'off'
    ? undefined
    : {
        perMinute: num('RATE_PER_MINUTE', DEFAULT_LIMITS.perMinute),
        chatPerHour: num('CHAT_PER_HOUR_IP', DEFAULT_LIMITS.chatPerHour),
        chatPerHourGlobal: num('CHAT_PER_HOUR_GLOBAL', DEFAULT_LIMITS.chatPerHourGlobal),
      }
const api = createHandler(async () => session, { token: process.env.DEMO_TOKEN || undefined, limits })

const handler = (request: Request) => {
  const { pathname } = new URL(request.url)
  if (request.method === 'GET' && !isApiPath(pathname)) return serveStatic(publicDir, pathname)
  return api(request)
}

const server = createServer(toNodeListener(handler)).listen(port, '0.0.0.0', () => {
  console.log(`Halcyon-contabil on http://localhost:${port}${process.env.DEMO_TOKEN ? ' (demo token required for the API)' : ''}`)
})

// As PID 1 in the container, Node ignores SIGTERM unless it has a handler; without one `docker stop` ends in SIGKILL.
// Stop taking connections, let in-flight requests finish, and leave before Docker's 10 s grace period runs out.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    server.closeIdleConnections()
    setTimeout(() => process.exit(0), 5_000).unref()
  })
}
