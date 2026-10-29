import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isApiPath, serveStatic } from '../src/server/static.js'

test('static files are served from the root only, and unknown paths fall back to index.html', async () => {
  const base = await mkdtemp(join(tmpdir(), 'static-'))
  try {
    const root = join(base, 'public')
    await mkdir(root)
    await writeFile(join(root, 'index.html'), '<h1>app</h1>')
    await writeFile(join(root, 'app.js'), 'x')
    await writeFile(join(base, 'secret.txt'), 'nope')
    assert.equal(await (await serveStatic(root, '/')).text(), '<h1>app</h1>')
    const js = await serveStatic(root, '/app.js')
    assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8')
    assert.equal(await (await serveStatic(root, '/some/route')).text(), '<h1>app</h1>')
    for (const attack of ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt']) {
      const response = await serveStatic(root, attack)
      assert.ok(!(await response.text()).includes('nope'), attack)
    }
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('API paths are recognised, the rest belongs to the web app', () => {
  assert.ok(isApiPath('/health') && isApiPath('/proposals/abc/approve') && isApiPath('/chat'))
  assert.ok(!isApiPath('/') && !isApiPath('/card') && !isApiPath('/assets/logo.png'))
})
