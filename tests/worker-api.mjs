import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Miniflare, Response } from 'miniflare'

const bundleUrl = new URL('../.cloudflare/output/v0/workers/default/bundle/index.js', import.meta.url)
const assetsUrl = new URL('../.cloudflare/output/v0/workers/default/assets', import.meta.url)

async function loadBundle() {
  const bundlePath = fileURLToPath(bundleUrl)
  const assetsPath = fileURLToPath(assetsUrl)
  try {
    await access(bundlePath)
    await access(assetsPath)
  } catch {
    throw new Error(`Missing Worker build artifacts under .cloudflare/output. Run "npm run build" before "npm run test:worker".`)
  }
  return { bundle: await readFile(bundlePath, 'utf8'), assetsPath }
}

async function createWorker({ analytics = false, outbound }) {
  const { bundle, assetsPath } = await loadBundle()
  const mf = new Miniflare({
    logRequests: false,
    workers: [{
      config: {
        name: 'home-nav',
        compatibilityDate: '2026-10-27',
        compatibilityFlags: ['nodejs_compat'],
        assets: {
          directory: assetsPath,
          hasUserWorker: true,
          notFoundHandling: 'single-page-application',
          runWorkerFirst: ['/api/*'],
        },
        manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: bundle } } },
        env: {
          ASSETS: { type: 'assets' },
          DASHBOARD_STORE: { type: 'durable-object', worker: 'home-nav', exportName: 'DashboardStore' },
          ADMIN_PASSWORD: { type: 'text', value: 'initial-fixture-password' },
          SESSION_SECRET: { type: 'text', value: 'test-only-session-key' },
          TURNSTILE_SECRET: { type: 'text', value: 'test-only-turnstile-key' },
          TURNSTILE_SITE_KEY: { type: 'text', value: 'test-only-site-key' },
          ...(analytics
            ? {
                CF_ANALYTICS_TOKEN: { type: 'text', value: 'analytics-secret-token' },
                CF_ANALYTICS_ACCOUNT_ID: { type: 'text', value: 'a'.repeat(32) },
              }
            : {}),
        },
        exports: { DashboardStore: { type: 'durable-object', storage: 'sqlite' } },
      },
      dev: { outboundService: { type: 'fetcher', handler: outbound } },
    }],
  })
  return mf
}

function makeCaller(mf, defaultOrigin = 'https://home-nav.test') {
  return (path, { origin = defaultOrigin, cookie, method = 'GET', data, rawBody, contentType, ip } = {}) => {
    const headers = {}
    if (origin !== null) headers.Origin = origin
    if (cookie) headers.Cookie = cookie
    if (ip) headers['CF-Connecting-IP'] = ip
    const body = rawBody !== undefined ? rawBody : (data !== undefined ? JSON.stringify(data) : undefined)
    if (contentType !== undefined) {
      if (contentType !== null) headers['Content-Type'] = contentType
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }
    return mf.dispatchFetch(defaultOrigin + path, { method, headers, body })
  }
}

async function signIn(call, ip = '203.0.113.10') {
  const res = await call('/api/login', {
    method: 'POST',
    ip,
    data: { password: 'initial-fixture-password', token: 'verified' },
  })
  assert.equal(res.status, 200)
  return res.headers.get('set-cookie').split(';')[0]
}

test('Worker serves SPA assets, enforces security headers, CSRF Origin checks, bootstrap and logout', async () => {
  const mf = await createWorker({
    outbound: async request => {
      assert.equal(new URL(request.url).hostname, 'challenges.cloudflare.com')
      return Response.json({ success: true, hostname: 'home-nav.test', action: 'login' })
    },
  })
  const call = makeCaller(mf)

  try {
    // 非 /api/* 路由交由 ASSETS 返回 SPA 入口
    const page = await mf.dispatchFetch('https://home-nav.test/')
    assert.equal(page.status, 200)
    assert.match(await page.text(), /<!doctype html>/i)

    // 全局安全响应头与 bootstrap 未登录态
    const bootGuest = await call('/api/bootstrap')
    assert.equal(bootGuest.status, 200)
    assert.equal(bootGuest.headers.get('X-Content-Type-Options'), 'nosniff')
    assert.equal(bootGuest.headers.get('Referrer-Policy'), 'no-referrer')
    assert.equal(bootGuest.headers.get('X-Frame-Options'), 'DENY')
    assert.match(bootGuest.headers.get('Content-Security-Policy') || '', /default-src 'self'/)
    assert.deepEqual(await bootGuest.json(), { authenticated: false, sitekey: 'test-only-site-key' })

    // GET 请求允许跨源或无 Origin
    assert.equal((await call('/api/bootstrap', { origin: 'https://evil.example' })).status, 200)

    // 非 GET/HEAD 请求缺少或跨源 Origin 被 403 拦截
    for (const badOrigin of [null, 'https://evil.example']) {
      const blocked = await call('/api/login', {
        method: 'POST',
        origin: badOrigin,
        data: { password: 'initial-fixture-password', token: 'verified' },
      })
      assert.equal(blocked.status, 403)
      assert.equal((await blocked.json()).error, '请求来源无效')
    }

    // 登录后 bootstrap 变为 true，logout 清除 Cookie 后恢复 false
    const cookie = await signIn(call)
    assert.equal((await (await call('/api/bootstrap', { cookie })).json()).authenticated, true)

    const loggedOut = await call('/api/logout', { method: 'POST', cookie, rawBody: '{}' })
    assert.equal(loggedOut.status, 200)
    const clearedCookie = loggedOut.headers.get('set-cookie') || ''
    assert.match(clearedCookie, /__Host-home-nav=/)
    assert.match(clearedCookie, /Max-Age=0/)
    assert.equal((await call('/api/dashboard', { cookie })).status, 200) // JWT 无状态，浏览器丢弃 Cookie 后未携带即退出
    assert.equal((await (await call('/api/bootstrap')).json()).authenticated, false)

    // 未知 API 路由返回 404
    const missing = await call('/api/unknown-endpoint', { cookie })
    assert.equal(missing.status, 404)
  } finally {
    await mf.dispose()
  }
})

test('Login enforces Turnstile hostname/action checks, local bypass, validation and rate limiting', async () => {
  const turnstileCalls = []
  const mf = await createWorker({
    outbound: async request => {
      const payload = await request.json()
      turnstileCalls.push(payload)
      if (payload.response === 'bad-host') return Response.json({ success: true, hostname: 'other.example', action: 'login' })
      if (payload.response === 'bad-action') return Response.json({ success: true, hostname: 'home-nav.test', action: 'signup' })
      return Response.json({ success: true, hostname: 'other.example', action: 'other' })
    },
  })
  const callRemote = makeCaller(mf, 'https://home-nav.test')
  const callLocal = makeCaller(mf, 'http://localhost')

  try {
    // 参数类型与长度校验
    assert.equal((await callRemote('/api/login', { method: 'POST', data: { password: 123, token: 'ok' } })).status, 400)
    assert.equal((await callRemote('/api/login', { method: 'POST', data: { password: 'x'.repeat(257), token: 'ok' } })).status, 400)
    assert.equal((await callRemote('/api/login', { method: 'POST', data: { password: 'ok', token: 'x'.repeat(2049) } })).status, 400)

    // 非本地域名严格校验 hostname 与 action
    assert.equal((await callRemote('/api/login', {
      method: 'POST', ip: '198.51.100.1', data: { password: 'initial-fixture-password', token: 'bad-host' },
    })).status, 403)
    assert.equal((await callRemote('/api/login', {
      method: 'POST', ip: '198.51.100.1', data: { password: 'initial-fixture-password', token: 'bad-action' },
    })).status, 403)

    // 本地域名不传 remoteip 且跳过 hostname/action 校验
    const localLogin = await callLocal('/api/login', {
      method: 'POST', ip: '198.51.100.2', data: { password: 'initial-fixture-password', token: 'any' },
    })
    assert.equal(localLogin.status, 200)
    assert.equal(turnstileCalls.at(-1).remoteip, undefined)

    // 同一 IP 连续尝试：前 10 次允许进入密码校验，第 11 次返回 429
    for (let i = 0; i < 10; i++) {
      const attempt = await callRemote('/api/login', {
        method: 'POST', ip: '198.51.100.99', data: { password: 'wrong', token: 'bad-host' },
      })
      assert.equal(attempt.status, 403)
    }
    const throttled = await callRemote('/api/login', {
      method: 'POST', ip: '198.51.100.99', data: { password: 'initial-fixture-password', token: 'verified' },
    })
    assert.equal(throttled.status, 429)
    assert.equal((await throttled.json()).error, '尝试过多，请稍后再试')

    // 其他 IP 不受影响
    const otherIp = await callLocal('/api/login', {
      method: 'POST', ip: '198.51.100.100', data: { password: 'initial-fixture-password', token: 'any' },
    })
    assert.equal(otherIp.status, 200)
  } finally {
    await mf.dispose()
  }
})

test('Request body streaming limits, input validation and error sanitization work as expected', async () => {
  const mf = await createWorker({
    outbound: async () => Response.json({ success: true, hostname: 'home-nav.test', action: 'login' }),
  })
  const call = makeCaller(mf)

  try {
    const cookie = await signIn(call)

    // Content-Type 缺失或非 JSON
    const badCt = await call('/api/login', { method: 'POST', contentType: 'text/plain', rawBody: '{}' })
    assert.equal(badCt.status, 400)
    assert.equal((await badCt.json()).error, '请求格式无效')

    // 空请求体 / 非法 JSON
    const emptyBody = await call('/api/login', { method: 'POST', contentType: 'application/json' })
    assert.equal(emptyBody.status, 400)
    const badJson = await call('/api/login', { method: 'POST', contentType: 'application/json', rawBody: '{invalid' })
    assert.equal(badJson.status, 400)

    // 超过各接口流式大小限制
    const bigLogin = await call('/api/login', {
      method: 'POST',
      rawBody: JSON.stringify({ password: 'a'.repeat(6001), token: 't' }),
    })
    assert.equal(bigLogin.status, 400)
    assert.equal((await bigLogin.json()).error, '请求过大')

    const bigMeta = await call('/api/metadata', {
      method: 'POST', cookie, rawBody: JSON.stringify({ url: 'https://example.com/' + 'a'.repeat(3001) }),
    })
    assert.equal(bigMeta.status, 400)
    assert.equal((await bigMeta.json()).error, '请求过大')

    const bigPassword = await call('/api/password', {
      method: 'POST', cookie, rawBody: JSON.stringify({ current: 'a'.repeat(2001), password: 'valid-new-password' }),
    })
    assert.equal(bigPassword.status, 400)
    assert.equal((await bigPassword.json()).error, '请求过大')

    const bigDashboard = await call('/api/dashboard', {
      method: 'PUT', cookie, rawBody: '{"dashboard":' + '"a"'.padEnd(1500001, 'a') + '}',
    })
    assert.equal(bigDashboard.status, 400)
    assert.equal((await bigDashboard.json()).error, '请求过大')

    // PUT /api/dashboard 非法版本号与非法结构
    assert.equal((await call('/api/dashboard', {
      method: 'PUT', cookie, data: { dashboard: { version: 1, sections: [{ id: 'websites', type: 'websites', x: 0, y: 0, w: 12, h: 1, sites: [] }] }, revision: -1 },
    })).status, 400)
    assert.equal((await call('/api/dashboard', {
      method: 'PUT', cookie, data: { dashboard: { version: 2, sections: [] }, revision: 0 },
    })).status, 400)

    // POST /api/password 长度校验与当前密码校验
    assert.equal((await call('/api/password', {
      method: 'POST', cookie, data: { current: 'initial-fixture-password', password: 'short' },
    })).status, 400)
    assert.equal((await call('/api/password', {
      method: 'POST', cookie, data: { current: 'wrong-password', password: 'valid-new-password' },
    })).status, 400)
  } finally {
    await mf.dispose()
  }
})

test('Unexpected upstream errors return sanitized 500 without leaking internals', async () => {
  const mf = await createWorker({
    outbound: async () => {
      throw new Error('SECRET_INTERNAL_STACK_DETAIL')
    },
  })
  const call = makeCaller(mf)
  try {
    const res = await call('/api/login', {
      method: 'POST',
      data: { password: 'initial-fixture-password', token: 'verified' },
    })
    assert.equal(res.status, 500)
    const body = await res.json()
    assert.equal(body.error, '暂时无法处理，请重试')
    assert.equal(JSON.stringify(body).includes('SECRET_INTERNAL_STACK_DETAIL'), false)
  } finally {
    await mf.dispose()
  }
})

test('Metadata endpoint extracts public titles/icons, enforces 128KB cap and blocks local/private targets', async () => {
  const outboundHosts = []
  const mf = await createWorker({
    outbound: async request => {
      const url = new URL(request.url)
      if (url.hostname === 'challenges.cloudflare.com') {
        return Response.json({ success: true, hostname: 'home-nav.test', action: 'login' })
      }
      outboundHosts.push(url.href)
      if (url.hostname === 'docs.example.com') {
        return new Response(
          '<html><head><title>  ' + 'A'.repeat(100) + '  </title><link rel="shortcut icon" href="/assets/app.png"></head></html>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        )
      }
      if (url.hostname === 'insecure-icon.example.com') {
        return new Response(
          '<html><head><title>Site</title><link rel="icon" href="http://cdn.example.com/bad.ico"></head></html>',
          { headers: { 'Content-Type': 'text/html' } },
        )
      }
      if (url.hostname === 'huge.example.com') {
        // 超过 128KB：title 在末尾，超出 131072 字节后应被流式截断忽略
        const head = '<html><head><link rel="icon" href="https://huge.example.com/logo.svg">'
        const padding = 'x'.repeat(140000)
        const tail = '<title>Should Not Be Reached</title></head></html>'
        return new Response(head + padding + tail, { headers: { 'Content-Type': 'text/html' } })
      }
      if (url.hostname === 'down.example.com') {
        throw new Error('network error')
      }
      return new Response('plain text', { status: 200, headers: { 'Content-Type': 'text/plain' } })
    },
  })
  const call = makeCaller(mf)

  try {
    const cookie = await signIn(call)

    // 内网与非 HTTPS/非 443 端口不发出出站请求
    for (const target of [
      'http://example.com/',
      'https://localhost/',
      'https://nas.local/',
      'https://service.internal/',
      'https://router.home/',
      'https://box.lan/',
      'https://192.168.1.10/',
      'https://example.com:8443/',
    ]) {
      const res = await call('/api/metadata', { method: 'POST', cookie, data: { url: target } })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.local, true)
      assert.equal(body.icon, '')
    }
    assert.equal(outboundHosts.length, 0)

    // 公网站点提取 title（截断到 80 字符）与解析相对路径图标
    const docsRes = await (await call('/api/metadata', {
      method: 'POST', cookie, data: { url: 'https://docs.example.com/guide' },
    })).json()
    assert.equal(docsRes.name, 'A'.repeat(80))
    assert.equal(docsRes.icon, 'https://docs.example.com/assets/app.png')

    // 非 HTTPS 图标回退至 origin/favicon.ico
    const insecureIcon = await (await call('/api/metadata', {
      method: 'POST', cookie, data: { url: 'https://insecure-icon.example.com/' },
    })).json()
    assert.equal(insecureIcon.name, 'Site')
    assert.equal(insecureIcon.icon, 'https://insecure-icon.example.com/favicon.ico')

    // 超过 128KB 的 HTML 流被截断，不会解析尾部 title
    const hugeRes = await (await call('/api/metadata', {
      method: 'POST', cookie, data: { url: 'https://huge.example.com/' },
    })).json()
    assert.equal(hugeRes.name, 'huge.example.com')
    assert.equal(hugeRes.icon, 'https://huge.example.com/logo.svg')

    // 网络失败与非 HTML 响应优雅回退默认值
    const downRes = await (await call('/api/metadata', {
      method: 'POST', cookie, data: { url: 'https://down.example.com/' },
    })).json()
    assert.deepEqual(downRes, { name: 'down.example.com', icon: 'https://down.example.com/favicon.ico' })
  } finally {
    await mf.dispose()
  }
})

test('GET /api/account-usage integrates Worker cache, GraphQL query and refresh throttling', async () => {
  let graphqlCalls = 0
  const mf = await createWorker({
    analytics: true,
    outbound: async request => {
      const url = new URL(request.url)
      if (url.hostname === 'challenges.cloudflare.com') {
        return Response.json({ success: true, hostname: 'home-nav.test', action: 'login' })
      }
      assert.equal(url.href, 'https://api.cloudflare.com/client/v4/graphql')
      assert.equal(request.headers.get('Authorization'), 'Bearer analytics-secret-token')
      graphqlCalls++
      return Response.json({
        data: {
          viewer: {
            accounts: [{
              workers: [{ sum: { requests: 1234, cpuTimeUs: 5000 } }],
              doRequests: [{ sum: { requests: 88 } }],
              doUsage: [{ sum: { duration: 100, rowsRead: 200, rowsWritten: 50 } }],
              d1: [{ sum: { rowsRead: 10, rowsWritten: 2 } }],
              workflows: [{ sum: { stepCount: 3, cpuTime: 4 } }],
              workflowStarts: [{ count: 1 }],
              d1Storage: [{ max: { databaseSizeBytes: 1024 } }],
              doStorage: [{ max: { storedBytes: 2048 } }],
            }],
          },
        },
      })
    },
  })
  const call = makeCaller(mf)

  try {
    const cookie = await signIn(call)
    const first = await call('/api/account-usage', { cookie })
    assert.equal(first.status, 200)
    const firstData = await first.json()
    assert.equal(firstData.status, 'ok')
    assert.equal(firstData.metrics.length, 14)
    assert.equal(firstData.metrics.find(m => m.id === 'workers-requests').value, 1234)
    assert.equal(graphqlCalls, 1)

    // 紧接着请求（包括 ?refresh=1 在 60s RETRY 内）命中缓存，不再打到 GraphQL
    const second = await (await call('/api/account-usage?refresh=1', { cookie })).json()
    assert.equal(second.fetchedAt, firstData.fetchedAt)
    assert.equal(graphqlCalls, 1)
  } finally {
    await mf.dispose()
  }
})
