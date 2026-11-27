import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Miniflare, Response } from 'miniflare'

const bundlePath = fileURLToPath(new URL('../.cloudflare/output/v0/workers/default/bundle/index.js', import.meta.url))

test('Home Nav keeps login, revision checks and password changes with SQLite DO storage', async () => {
  try {
    await access(bundlePath)
  } catch {
    throw new Error(`Missing Worker build artifact at ${bundlePath}. Run "npm run build" before "npm run test:worker".`)
  }
  const bundle = await readFile(bundlePath, 'utf8')
  const origin = 'https://home-nav.test'
  const mf = new Miniflare({ logRequests: false, workers: [{
    config: {
      name: 'home-nav',
      compatibilityDate: '2026-10-27',
      compatibilityFlags: ['nodejs_compat'],
      manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: bundle } } },
      env: {
        DASHBOARD_STORE: { type: 'durable-object', worker: 'home-nav', exportName: 'DashboardStore' },
        ADMIN_PASSWORD: { type: 'text', value: 'initial-fixture-password' },
        SESSION_SECRET: { type: 'text', value: 'test-only-session-key' },
        TURNSTILE_SECRET: { type: 'text', value: 'test-only-turnstile-key' },
        TURNSTILE_SITE_KEY: { type: 'text', value: 'test-only-site-key' },
      },
      exports: { DashboardStore: { type: 'durable-object', storage: 'sqlite' } },
    },
    dev: { outboundService: { type: 'fetcher', handler: async request => {
      assert.equal(new URL(request.url).hostname, 'challenges.cloudflare.com')
      const challenge = await request.json()
      return Response.json({ success: challenge.response === 'verified', hostname: 'home-nav.test', action: 'login' })
    } } },
  }] })
  const call = (path, { cookie, method = 'GET', data } = {}) => mf.dispatchFetch(origin + path, {
    method,
    headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) },
    body: data && JSON.stringify(data),
  })
  const login = (password, token = 'verified') => call('/api/login', { method: 'POST', data: { password, token } })
  try {
    assert.equal((await call('/api/dashboard')).status, 401)
    assert.equal((await login('initial-fixture-password', 'rejected')).status, 403)
    const session = await login('initial-fixture-password')
    assert.equal(session.status, 200)
    const cookie = session.headers.get('set-cookie').split(';')[0]
    const initial = await (await call('/api/dashboard', { cookie })).json()
    assert.equal(initial.revision, 0)
    const saved = { dashboard: initial.dashboard, revision: 0 }
    const contenders = await Promise.all(Array.from({ length: 2 }, () =>
      call('/api/dashboard', { cookie, method: 'PUT', data: saved })
    ))
    assert.deepEqual(contenders.map(response => response.status).sort(), [200, 409])
    assert.equal((await (await call('/api/dashboard', { cookie })).json()).revision, 1)
    const changed = await call('/api/password', {
      cookie, method: 'POST',
      data: { current: 'initial-fixture-password', password: 'new-fixture-password' },
    })
    assert.equal(changed.status, 200)
    assert.equal((await call('/api/dashboard', { cookie })).status, 401)
    assert.equal((await login('initial-fixture-password')).status, 401)
    assert.equal((await login('new-fixture-password')).status, 200)
  } finally {
    await mf.dispose()
  }
})
