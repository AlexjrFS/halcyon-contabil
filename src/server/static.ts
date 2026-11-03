// Serves the web app (the Expo web export, or any static files) from a folder, next to the API.
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

// First path segments that belong to the API; everything else is the web app
export const API_PREFIXES = ['health', 'chat', 'state', 'proposals', 'cards', 'invoices', 'charges', 'demo', 'ledger']

export const isApiPath = (pathname: string) => API_PREFIXES.includes(pathname.split('/').filter(Boolean)[0] ?? '')

// A file under `root`, or index.html for unknown paths (single-page app). Never leaves `root`.
export async function serveStatic(root: string, pathname: string): Promise<Response> {
  const clean = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '')
  const target = join(root, clean || 'index.html')
  if (target !== root && !target.startsWith(root + sep)) return new Response('Not found', { status: 404 })
  for (const file of [target, join(root, 'index.html')]) {
    try {
      const body = await readFile(file)
      const type = TYPES[extname(file)] ?? 'application/octet-stream'
      return new Response(body, { headers: { 'content-type': type, 'cache-control': ['.html', '.js', '.css'].includes(extname(file)) ? 'no-cache' : 'public, max-age=3600' } })
    } catch {}
  }
  return new Response('Not found', { status: 404 })
}
