import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { emptyDashboard, validateDashboard, type Dashboard } from '../../shared/dashboard'
import type { AccountUsage } from '../../shared/account-usage'
import App from '../../src/App.vue'

vi.mock('grid-layout-plus', () => ({
  GridLayout: defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }),
  GridItem: defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }),
}))
vi.mock('../../src/IconPicker.vue', () => ({
  __esModule: true,
  default: defineComponent({
    emits: ['select'],
    setup: (_, { emit }) => () => h('button', { type: 'button', onClick: () => emit('select', 'Server') }, 'Server'),
  }),
}))

const turnstileReset = vi.fn()
const TurnstileStub = defineComponent({
  emits: ['token', 'error'],
  setup(_, { emit, expose }) {
    expose({ reset: turnstileReset })
    return () => h('div', [
      h('button', { type: 'button', 'data-test': 'verify-turnstile', onClick: () => emit('token', 'turnstile-ok') }, 'verify'),
      h('button', { type: 'button', 'data-test': 'fail-turnstile', onClick: () => emit('error') }, 'fail'),
    ])
  },
})

let authenticatedState: boolean
let bootstrapFails: boolean
let stored: Dashboard
let revision: number
let dashboardGets: number
let dashboardPuts: number
let putShouldFail: boolean
let nextErrorStatus: { path: string; status: number; error: string } | null
let lastLoginBody: { password: string; token: string } | null
let lastPasswordBody: { current: string; password: string } | null
let logoutCalls: number
let usageData: AccountUsage
let wrapper: VueWrapper | undefined

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))
const websites = () => stored.sections.find(s => s.type === 'websites')!

function makeUsage(): AccountUsage {
  const now = Date.UTC(2026, 10, 27, 4, 0)
  return {
    status: 'ok',
    scope: 'account',
    day: '2026-11-27',
    fetchedAt: now,
    nextRefreshAt: now + 60000,
    resetAt: Date.UTC(2026, 10, 28, 0, 0),
    metrics: [
      { id: 'workers-requests', product: 'Workers', name: '请求统计', value: 120, limit: 100000, unit: 'count', period: 'day' },
    ],
  }
}

beforeEach(() => {
  authenticatedState = true
  bootstrapFails = false
  stored = emptyDashboard()
  websites().sites = [
    { id: 'nas', name: 'NAS', url: 'https://nas.example.com/', icon: { type: 'auto', value: 'https://nas.example.com/favicon.ico' } },
    { id: 'router', name: '路由器', url: 'http://192.168.1.1/', icon: { type: 'lucide', value: 'Router', color: '#007aff' } },
  ]
  revision = 1
  dashboardGets = 0
  dashboardPuts = 0
  putShouldFail = false
  nextErrorStatus = null
  lastLoginBody = null
  lastPasswordBody = null
  logoutCalls = 0
  usageData = makeUsage()
  turnstileReset.mockReset()

  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    if (nextErrorStatus && url.startsWith(nextErrorStatus.path)) {
      const { status, error } = nextErrorStatus
      nextErrorStatus = null
      return Response.json({ error }, { status })
    }
    if (url === '/api/bootstrap') {
      if (bootstrapFails) {
        bootstrapFails = false
        return Response.json({ error: '服务初始化失败' }, { status: 500 })
      }
      return Response.json({ authenticated: authenticatedState, sitekey: 'test-site-key' })
    }
    if (url === '/api/login' && options.method === 'POST') {
      lastLoginBody = JSON.parse(options.body as string)
      if (lastLoginBody!.password !== 'correct-password') {
        return Response.json({ error: '密码错误' }, { status: 401 })
      }
      authenticatedState = true
      return Response.json({ ok: true })
    }
    if (url === '/api/logout' && options.method === 'POST') {
      logoutCalls++
      authenticatedState = false
      return Response.json({ ok: true })
    }
    if (url === '/api/password' && options.method === 'POST') {
      lastPasswordBody = JSON.parse(options.body as string)
      if (lastPasswordBody!.current !== 'correct-password') {
        return Response.json({ error: '当前密码错误' }, { status: 400 })
      }
      authenticatedState = false
      return Response.json({ ok: true })
    }
    if (url.startsWith('/api/account-usage')) {
      return Response.json(usageData)
    }
    if (url === '/api/metadata' && options.method === 'POST') {
      return Response.json({ name: '自动标题', icon: 'https://auto.example.com/icon.png' })
    }
    if (url === '/api/dashboard' && options.method === 'PUT') {
      dashboardPuts++
      if (putShouldFail) {
        putShouldFail = false
        return Response.json({ error: '保存失败' }, { status: 500 })
      }
      const input = JSON.parse(options.body as string)
      stored = clone(validateDashboard(input.dashboard))
      revision++
      return Response.json({ revision })
    }
    if (url === '/api/dashboard') {
      dashboardGets++
      return Response.json({ dashboard: clone(stored), revision })
    }
    throw new Error('Unexpected API call: ' + url)
  }))
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function boot() {
  wrapper = mount(App, {
    attachTo: document.body,
    global: {
      stubs: {
        teleport: true,
        TurnstileWidget: TurnstileStub,
      },
    },
  })
  await flushPromises()
  return wrapper
}

function selectImportFile(file: File) {
  const input = wrapper!.get('input[type="file"]')
  Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
  return input.trigger('change')
}

describe('App core flows', () => {
  it('handles bootstrap retry, login errors with turnstile reset, successful login and logout', async () => {
    authenticatedState = false
    bootstrapFails = true
    await boot()

    expect(wrapper!.find('.error-state p').text()).toBe('服务初始化失败')
    await wrapper!.get('.error-state button.pill').trigger('click')
    await flushPromises()
    expect(wrapper!.find('form.login-card').exists()).toBe(true)

    // Turnstile error callback displays alert
    await wrapper!.get('[data-test="fail-turnstile"]').trigger('click')
    expect(wrapper!.get('.login-card .form-error').text()).toContain('验证加载失败')

    // Wrong password shows error and resets turnstile
    await wrapper!.get('.login-card input[type="password"]').setValue('wrong-password')
    await wrapper!.get('[data-test="verify-turnstile"]').trigger('click')
    await wrapper!.get('form.login-card').trigger('submit')
    await flushPromises()
    expect(lastLoginBody).toEqual({ password: 'wrong-password', token: 'turnstile-ok' })
    expect(wrapper!.get('.login-card .form-error').text()).toBe('密码错误')
    expect(turnstileReset).toHaveBeenCalledTimes(1)

    // Correct password logs in and loads dashboard
    await wrapper!.get('.login-card input[type="password"]').setValue('correct-password')
    await wrapper!.get('form.login-card').trigger('submit')
    await flushPromises()
    expect(wrapper!.find('.home-page').exists()).toBe(true)
    expect(wrapper!.findAll('.app-icon-link')).toHaveLength(2)

    // Logout clears session back to login screen
    await wrapper!.get('[aria-label="账户设置"]').trigger('click')
    await wrapper!.findAll('.account-menu button').find(b => b.text() === '退出登录')!.trigger('click')
    await flushPromises()
    expect(logoutCalls).toBe(1)
    expect(wrapper!.find('form.login-card').exists()).toBe(true)
  })

  it('logs out cleanly when any authenticated API returns 401', async () => {
    await boot()
    expect(wrapper!.find('.home-page').exists()).toBe(true)

    nextErrorStatus = { path: '/api/account-usage', status: 401, error: '请先登录' }
    await wrapper!.get('.quota-refresh').trigger('click')
    await flushPromises()
    expect(wrapper!.find('form.login-card').exists()).toBe(true)
  })

  it('adds a site with host fallback name, respects delete confirmation, and opens empty-state add button', async () => {
    const confirmMock = vi.fn(() => true)
    vi.stubGlobal('confirm', confirmMock)
    await boot()

    // Add site with blank name -> defaults to URL host
    await wrapper!.get('[aria-label="添加网站"]').trigger('click')
    await wrapper!.get('.url-field input').setValue('https://git.example.com/repo')
    await wrapper!.get('.site-form').trigger('submit')
    await flushPromises()
    expect(websites().sites).toHaveLength(3)
    expect(websites().sites[2]!.name).toBe('git.example.com')

    // Cancel delete confirmation -> keeps site
    confirmMock.mockReturnValueOnce(false)
    await wrapper!.get('.app-icon-link[title="git.example.com"]').trigger('contextmenu')
    await wrapper!.get('button.danger').trigger('click')
    await flushPromises()
    expect(websites().sites).toHaveLength(3)

    // Confirm delete -> removes site
    confirmMock.mockReturnValue(true)
    await wrapper!.get('button.danger').trigger('click')
    await flushPromises()
    expect(websites().sites).toHaveLength(2)

    // Delete remaining two sites -> empty-add button becomes visible
    for (const title of ['NAS', '路由器']) {
      await wrapper!.get(`.app-icon-link[title="${title}"]`).trigger('contextmenu')
      await wrapper!.get('button.danger').trigger('click')
      await flushPromises()
    }
    expect(wrapper!.find('.empty-add').exists()).toBe(true)
    await wrapper!.get('.empty-add').trigger('click')
    expect(wrapper!.find('.site-form').exists()).toBe(true)
  })

  it('exports config and validates size, JSON, confirmation and save rollback on import', async () => {
    const confirmMock = vi.fn(() => true)
    vi.stubGlobal('confirm', confirmMock)
    const createObjectURL = vi.fn(() => 'blob:home-nav-test')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }))
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await boot()

    // Export config
    await wrapper!.get('[aria-label="账户设置"]').trigger('click')
    await wrapper!.findAll('.account-menu button').find(b => b.text() === '导出配置')!.trigger('click')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(clickSpy).toHaveBeenCalledTimes(1)

    // Reject oversized file (> 1.5MB)
    const oversized = { size: 1500001, text: async () => '{}' } as unknown as File
    await selectImportFile(oversized)
    await flushPromises()
    expect(wrapper!.get('.toast').text()).toBe('文件过大')
    expect(dashboardPuts).toBe(0)

    // Reject invalid JSON / invalid schema
    await selectImportFile(new File(['{bad-json'], 'bad.json', { type: 'application/json' }))
    await flushPromises()
    expect(wrapper!.get('.toast').text()).toBeTruthy()
    expect(dashboardPuts).toBe(0)

    const validImport = emptyDashboard()
    validImport.sections[0]!.sites.push({ id: 'imported-1', name: '导入站', url: 'https://imported.example.com/', icon: { type: 'auto', value: '' } })

    // Cancel confirmation -> no save
    confirmMock.mockReturnValueOnce(false)
    await selectImportFile(new File([JSON.stringify(validImport)], 'nav.json', { type: 'application/json' }))
    await flushPromises()
    expect(dashboardPuts).toBe(0)
    expect(wrapper!.findAll('.app-icon-link')).toHaveLength(2)

    // Save failure rolls back dashboard
    confirmMock.mockReturnValueOnce(true)
    putShouldFail = true
    await selectImportFile(new File([JSON.stringify(validImport)], 'nav.json', { type: 'application/json' }))
    await flushPromises()
    expect(wrapper!.get('.toast').text()).toBe('保存失败')
    expect(wrapper!.findAll('.app-icon-link')).toHaveLength(2)

    // Successful import updates dashboard and saves
    confirmMock.mockReturnValueOnce(true)
    await selectImportFile(new File([JSON.stringify(validImport)], 'nav.json', { type: 'application/json' }))
    await flushPromises()
    expect(wrapper!.get('.toast').text()).toBe('已导入')
    expect(wrapper!.findAll('.app-icon-link')).toHaveLength(1)
    expect(wrapper!.get('.app-icon-link').attributes('title')).toBe('导入站')
  })

  it('validates password mismatch, server error and logs out after successful password change', async () => {
    await boot()

    await wrapper!.get('[aria-label="账户设置"]').trigger('click')
    await wrapper!.findAll('.account-menu button').find(b => b.text() === '修改密码')!.trigger('click')

    const inputs = wrapper!.findAll('.password-form input')
    await inputs[0]!.setValue('correct-password')
    await inputs[1]!.setValue('new-password-1')
    await inputs[2]!.setValue('new-password-2')
    await wrapper!.get('.password-form').trigger('submit')
    expect(wrapper!.get('.password-form .form-error').text()).toBe('两次输入的密码不一致')
    expect(lastPasswordBody).toBeNull()

    await inputs[0]!.setValue('wrong-current')
    await inputs[2]!.setValue('new-password-1')
    await wrapper!.get('.password-form').trigger('submit')
    await flushPromises()
    expect(wrapper!.get('.password-form .form-error').text()).toBe('当前密码错误')

    await inputs[0]!.setValue('correct-password')
    await wrapper!.get('.password-form').trigger('submit')
    await flushPromises()
    expect(lastPasswordBody).toEqual({ current: 'correct-password', password: 'new-password-1' })
    expect(wrapper!.find('form.login-card').exists()).toBe(true)
    expect(wrapper!.get('.toast').text()).toBe('密码已修改，请重新登录')
  })

  it('supports tile hide/restore, Alt+Arrow reordering, Escape rollback and quota modal', async () => {
    await boot()

    // Open quota details outside edit mode
    await wrapper!.get('[aria-label="查看额度详情"]').trigger('click')
    expect(wrapper!.find('.quota-details').exists()).toBe(true)
    await wrapper!.get('button[aria-label="关闭"]').trigger('click')

    // Enter customization mode
    await wrapper!.get('.customize-dashboard-button').trigger('click')
    expect(wrapper!.find('.home-page.editing').exists()).toBe(true)

    // Hide Cloudflare quota tile and restore it from "添加拼贴"
    await wrapper!.get('[aria-label="移除 Cloudflare 额度拼贴"]').trigger('click')
    expect(wrapper!.find('.quota-tile').exists()).toBe(false)
    await wrapper!.get('.add-tile').trigger('click')
    const quotaChoice = wrapper!.findAll('.tile-picker-choice').find(b => b.text().includes('Cloudflare 额度'))!
    expect((quotaChoice.element as HTMLButtonElement).disabled).toBe(false)
    await quotaChoice.trigger('click')
    expect(wrapper!.find('.quota-tile').exists()).toBe(true)

    // Reorder shortcuts via Alt+ArrowRight and Alt+ArrowLeft
    const firstLink = () => wrapper!.findAll('.app-icon-link')[0]!
    expect(firstLink().attributes('title')).toBe('NAS')
    await firstLink().trigger('keydown.alt.right')
    expect(firstLink().attributes('title')).toBe('路由器')
    await wrapper!.findAll('.app-icon-link')[1]!.trigger('keydown.alt.left')
    expect(firstLink().attributes('title')).toBe('NAS')

    // Move again and hide tile, then press Escape twice (close menu first, then cancel edit and rollback)
    await firstLink().trigger('keydown.alt.right')
    await wrapper!.get('[aria-label="移除 Cloudflare 额度拼贴"]').trigger('click')
    await wrapper!.get('.section-menu-button').trigger('click')
    expect(wrapper!.find('.section-menu').exists()).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(wrapper!.find('.section-menu').exists()).toBe(false)
    expect(wrapper!.find('.home-page.editing').exists()).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(wrapper!.find('.home-page.editing').exists()).toBe(false)
    expect(firstLink().attributes('title')).toBe('NAS')
    expect(wrapper!.find('.quota-tile').exists()).toBe(true)
    expect(dashboardPuts).toBe(0)
  })

  it('refreshes dashboard on visibilitychange only when idle', async () => {
    await boot()
    const getsAfterBoot = dashboardGets

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    expect(dashboardGets).toBe(getsAfterBoot + 1)

    await wrapper!.get('.customize-dashboard-button').trigger('click')
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    expect(dashboardGets).toBe(getsAfterBoot + 1)
  })
})
