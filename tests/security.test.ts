import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sameSecret, signSession, verifySession, hashPassword } from '../worker/auth.ts'
import { emptyDashboard, validateDashboard, websiteUrl } from '../shared/dashboard.ts'

test('password comparison and derived password checks', async () => {
  assert.equal(await sameSecret('a', 'a'), true)
  assert.equal(await sameSecret('a', 'b'), false)
  assert.equal(await sameSecret('', 'a'), false)
  const hash = await hashPassword('correct password', 'salt')
  assert.notEqual(hash, await hashPassword('other password', 'salt'))
  assert.notEqual(hash, await hashPassword('correct password', 'other salt'))
})
test('sessions reject tampering, expiration and revoked generations', async () => {
  const token = await signSession('test-key', 'v1', 1000)
  assert.equal(await verifySession(token, 'test-key', 'v1', 2000), true)
  assert.equal(await verifySession(token, 'wrong-key', 'v1', 2000), false)
  assert.equal(await verifySession(token, 'test-key', 'v2', 2000), false)
  assert.equal(await verifySession(token, 'test-key', 'v1', 1000 + 31 * 86400000), false)
  assert.equal(await verifySession(token + '.extra', 'test-key', 'v1', 2000), false)
  assert.equal(await verifySession('garbage', 'test-key', 'v1', 2000), false)
})
test('dashboard rejects unsafe URLs, duplicate IDs and HTML image data', () => {
  assert.throws(() => websiteUrl('not-a-url'), /请输入有效的 HTTP 或 HTTPS 网址/)
  assert.throws(() => websiteUrl('javascript:alert(1)'))
  assert.throws(() => websiteUrl('https://user:secret@example.com'))
  assert.equal(websiteUrl('http://192.168.1.1:8080/'), 'http://192.168.1.1:8080/')
  const dashboard = emptyDashboard()
  const site = { id: 'one', name: 'Example', url: 'https://example.com/', icon: { type: 'lucide' as const, value: 'Globe' } }
  dashboard.sections[0]!.sites.push(site)
  assert.equal(validateDashboard(dashboard), dashboard)
  dashboard.sections[0]!.sites.push({ ...site })
  assert.throws(() => validateDashboard(dashboard))
  dashboard.sections[0]!.sites.pop()
  dashboard.sections[0]!.sites[0]!.icon = { type: 'auto', value: 'data:text/html;base64,PHN2Zz4=' }
  assert.throws(() => validateDashboard(dashboard))
})

test('sessions enforce token length limit and exact expiration boundary', async () => {
  const token = await signSession('test-key', 'v1', 1000)
  const exp = 1000 + 30 * 86400000
  assert.equal(await verifySession(token, 'test-key', 'v1', exp - 1), true)
  assert.equal(await verifySession(token, 'test-key', 'v1', exp), false)
  assert.equal(await verifySession('a'.repeat(2049), 'test-key', 'v1', 2000), false)
  assert.equal(await verifySession('', 'test-key', 'v1', 2000), false)
})

test('validateDashboard enforces site count, field bounds, icon formats, colors and grid bounds', () => {
  const makeSite = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    name: 'Site ' + id,
    url: 'https://example.com/' + id,
    icon: { type: 'auto' as const, value: '' },
    ...overrides,
  })

  // 非对象、错误版本、空栏目、超过 2 个栏目、缺失 websites 栏目
  assert.throws(() => validateDashboard(null))
  assert.throws(() => validateDashboard({ ...emptyDashboard(), version: 2 }))
  assert.throws(() => validateDashboard({ version: 1, sections: [] }))
  assert.throws(() => validateDashboard({
    version: 1,
    sections: [...emptyDashboard().sections, { id: 'extra', type: 'websites', x: 0, y: 1, w: 4, h: 1, sites: [] }],
  }))
  assert.throws(() => validateDashboard({ version: 1, sections: [emptyDashboard().sections[1]] }))

  // 非法栏目 ID、hidden 类型及布局越界
  const badSection = (patch: Record<string, unknown>) => {
    const d = emptyDashboard()
    Object.assign(d.sections[0]!, patch)
    return d
  }
  assert.throws(() => validateDashboard(badSection({ id: 'bad id!' })))
  assert.throws(() => validateDashboard(badSection({ id: 'a'.repeat(81) })))
  assert.throws(() => validateDashboard(badSection({ hidden: 'yes' })))
  assert.throws(() => validateDashboard(badSection({ w: 0 })))
  assert.throws(() => validateDashboard(badSection({ w: 13 })))
  assert.throws(() => validateDashboard(badSection({ h: 0 })))
  assert.throws(() => validateDashboard(badSection({ x: 5, w: 8 })))
  assert.throws(() => validateDashboard(badSection({ x: 1.5 })))
  assert.throws(() => validateDashboard(badSection({ y: 10001 })))

  // 200 个站点边界
  const maxDashboard = emptyDashboard()
  maxDashboard.sections[0]!.sites = Array.from({ length: 200 }, (_, i) => makeSite(`s-${i}`))
  assert.equal(validateDashboard(maxDashboard), maxDashboard)
  maxDashboard.sections[0]!.sites.push(makeSite('s-200'))
  assert.throws(() => validateDashboard(maxDashboard), /最多添加 200 个网站/)

  // 站点 ID、名称、URL 长度与协议边界
  const checkSingle = (patch: Record<string, unknown>) => {
    const d = emptyDashboard()
    d.sections[0]!.sites.push(makeSite('ok', patch) as never)
    return d
  }
  assert.throws(() => validateDashboard(checkSingle({ id: 'bad id' })))
  assert.throws(() => validateDashboard(checkSingle({ name: '   ' })))
  assert.throws(() => validateDashboard(checkSingle({ name: 'a'.repeat(81) })))
  assert.doesNotThrow(() => validateDashboard(checkSingle({ name: 'a'.repeat(80) })))
  assert.throws(() => validateDashboard(checkSingle({ url: 123 })))
  assert.throws(() => validateDashboard(checkSingle({ url: 'ftp://example.com/' })))
  assert.throws(() => validateDashboard(checkSingle({ url: 'https://example.com/' + 'a'.repeat(2040) })))

  // 图标格式、data:image/*;base64 白名单与 130KB 上限、Lucide 与颜色正则
  assert.throws(() => validateDashboard(checkSingle({ icon: { type: 'unknown', value: '' } })))
  assert.throws(() => validateDashboard(checkSingle({ icon: { type: 'lucide', value: 'bad-name' } })))
  assert.throws(() => validateDashboard(checkSingle({ icon: { type: 'lucide', value: 'a'.repeat(81) } })))
  assert.doesNotThrow(() => validateDashboard(checkSingle({ icon: { type: 'lucide', value: 'Server2', color: '#007aff' } })))
  assert.throws(() => validateDashboard(checkSingle({ icon: { type: 'lucide', value: 'Globe', color: '#fff' } })))
  assert.throws(() => validateDashboard(checkSingle({ icon: { type: 'lucide', value: 'Globe', color: 'red' } })))

  const validSvg = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
  assert.doesNotThrow(() => validateDashboard(checkSingle({ icon: { type: 'auto', value: validSvg } })))
  assert.doesNotThrow(() => validateDashboard(checkSingle({ icon: { type: 'auto', value: 'data:image/x-icon;base64,AAAB' } })))
  const oversized = 'data:image/png;base64,' + 'A'.repeat(130001)
  assert.throws(() => validateDashboard(checkSingle({ icon: { type: 'auto', value: oversized } })))
  assert.throws(() => validateDashboard(checkSingle({ icon: { type: 'auto', value: 'data:image/png;base64,not valid!' } })))
  assert.throws(() => validateDashboard(checkSingle({ icon: { type: 'auto', value: 'javascript:alert(1)' } })))
})
