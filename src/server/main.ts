// npm run server: the API and the web app on one port, with state under DATA_DIR (a Docker volume on the VM).
// Binds 0.0.0.0 so a reverse proxy (or a phone on the same Wi-Fi) can reach it.
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { JsonFileStore } from '../approvals/store.js'
import { FileStateStore } from '../app/state.js'
import { openSession } from '../app/session.js'
import { FileRailStore, SimulatedRail } from '../rail/simulated.js'
import { createHandler, toNodeListener } from './app.js'
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
const api = createHandler(async () => session, { token: process.env.DEMO_TOKEN || undefined })

const handler = (request: Request) => {
  const { pathname } = new URL(request.url)
  if (request.method === 'GET' && !isApiPath(pathname)) return serveStatic(publicDir, pathname)
  return api(request)
}

createServer(toNodeListener(handler)).listen(port, '0.0.0.0', () => {
  console.log(`Halcyon-contabil on http://localhost:${port}${process.env.DEMO_TOKEN ? ' (demo token required for the API)' : ''}`)
})
