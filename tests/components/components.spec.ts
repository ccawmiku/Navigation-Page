import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import type { AccountUsage } from '../../shared/account-usage'
import SiteIcon from '../../src/SiteIcon.vue'
import DialogShell from '../../src/DialogShell.vue'
import CloudflareQuota from '../../src/CloudflareQuota.vue'
import QuotaDetails from '../../src/QuotaDetails.vue'
import IconPicker from '../../src/IconPicker.vue'
import TurnstileWidget from '../../src/TurnstileWidget.vue'

function sampleUsage(overrides: Partial<AccountUsage> = {}): AccountUsage {
  const now = Date.UTC(2026, 10, 27, 4, 0)
  return {
    status: 'ok',
    scope: 'account',
    day: '2026-11-27',
    fetchedAt: now,
    nextRefreshAt: now + 60000,
    resetAt: Date.UTC(2026, 10, 28, 0, 0),
    metrics: [
      { id: 'workers-requests', product: 'Workers', name: '请求统计', value: 92000, limit: 100000, unit: 'count', period: 'day', note: 'Workers 说明' },
      { id: 'workers-cpu', product: 'Workers', name: 'CPU 累计', value: 12.4, limit: null, unit: 'ms', period: 'day' },
      { id: 'do-requests', product: 'Durable Objects', name: '请求统计', value: 12000, limit: 100000, unit: 'count', period: 'day' },
      { id: 'do-duration', product: 'Durable Objects', name: '内存驻留时长', value: 500, limit: 13000, unit: 'gbs', period: 'day' },
      { id: 'do-read', product: 'Durable Objects', name: 'SQLite 读取行数', value: 1000, limit: 5000000, unit: 'count', period: 'day' },
      { id: 'do-write', product: 'Durable Objects', name: 'SQLite 写入行数', value: 200, limit: 100000, unit: 'count', period: 'day' },
      { id: 'do-storage', product: 'Durable Objects', name: 'SQLite 存储峰值', value: 4096, limit: 5e9, unit: 'bytes', period: 'storage' },
      { id: 'd1-read', product: 'D1', name: '读取行数', value: 500, limit: 5000000, unit: 'count', period: 'day' },
      { id: 'd1-write', product: 'D1', name: '写入行数', value: 100, limit: 100000, unit: 'count', period: 'day' },
      { id: 'd1-storage', product: 'D1', name: '存储峰值', value: 2048, limit: 5e9, unit: 'bytes', period: 'storage' },
      { id: 'workflow-invocations', product: 'Workflows', name: '启动次数', value: 5, limit: null, unit: 'count', period: 'day' },
      { id: 'workflow-steps', product: 'Workflows', name: '步骤（step.do）', value: 300, limit: 3000, unit: 'count', period: 'day' },
      { id: 'workflow-cpu', product: 'Workflows', name: 'CPU 累计', value: 10, limit: null, unit: 'ms', period: 'day' },
      { id: 'workflow-storage', product: 'Workflows', name: '状态存储', value: null, limit: 1e9, unit: 'bytes', period: 'storage' },
    ],
    ...overrides,
  }
}

afterEach(() => {
  document.body.innerHTML = ''
  document.body.style.overflow = ''
  document.head.querySelectorAll('script[data-turnstile]').forEach(el => el.remove())
  delete window.turnstile
  vi.restoreAllMocks()
})

describe('SiteIcon', () => {
  it('renders auto image, falls back to Globe on error, and resets error when value changes', async () => {
    const wrapper = mount(SiteIcon, {
      props: { icon: { type: 'auto', value: 'https://example.com/a.png', color: '#ff3b30' } },
    })
    expect(wrapper.find('img').attributes('src')).toBe('https://example.com/a.png')
    expect(wrapper.find('img').attributes('referrerpolicy')).toBe('no-referrer')
    expect(wrapper.find('.site-icon').classes()).toContain('logo-icon')

    await wrapper.find('img').trigger('error')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('svg').exists()).toBe(true)
    expect(wrapper.find('.site-icon').classes()).not.toContain('logo-icon')

    await wrapper.setProps({ icon: { type: 'auto', value: 'https://example.com/b.png' } })
    expect(wrapper.find('img').attributes('src')).toBe('https://example.com/b.png')
    expect(wrapper.find('.site-icon').classes()).toContain('logo-icon')
  })

  it('renders lucide glyph including non-common catalog icons', async () => {
    const wrapper = mount(SiteIcon, {
      props: { icon: { type: 'lucide', value: 'Camera', color: '#34a853' } },
    })
    await flushPromises()
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('svg').exists()).toBe(true)
    expect((wrapper.find('.site-icon').element as HTMLElement).style.color).toBe('#34a853')
  })
})

describe('DialogShell', () => {
  it('locks body scroll, handles Escape and backdrop clicks, traps Tab focus, and restores focus on unmount', async () => {
    const trigger = document.createElement('button')
    trigger.textContent = '触发按钮'
    document.body.appendChild(trigger)
    trigger.focus()

    const Host = defineComponent({
      props: { busy: Boolean },
      emits: ['close'],
      setup(props, { emit }) {
        return () => h(DialogShell, { title: '测试弹窗', busy: props.busy, onClose: () => emit('close') }, {
          default: () => [
            h('input', { 'aria-label': '输入框' }),
            h('button', { type: 'button' }, '确认'),
          ],
        })
      },
    })

    const wrapper = mount(Host, { attachTo: document.body, props: { busy: false } })
    await flushPromises()

    expect(document.body.style.overflow).toBe('hidden')
    const dialog = document.body.querySelector('.dialog') as HTMLElement
    const closeBtn = dialog.querySelector('button[aria-label="关闭"]') as HTMLButtonElement
    const input = dialog.querySelector('input[aria-label="输入框"]') as HTMLInputElement
    const confirmBtn = dialog.querySelectorAll('button')[1] as HTMLButtonElement
    expect(document.activeElement).toBe(closeBtn)

    // happy-dom 中 offsetParent 默认可能为 null，这里显式模拟可见节点的 offsetParent 以验证焦点陷阱分支
    for (const el of [closeBtn, input, confirmBtn]) {
      Object.defineProperty(el, 'offsetParent', { configurable: true, get: () => document.body })
    }

    confirmBtn.focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(closeBtn)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(confirmBtn)

    // busy 为 true 时阻止 backdrop 关闭并禁用关闭按钮
    await wrapper.setProps({ busy: true })
    expect(closeBtn.disabled).toBe(true)
    const backdrop = document.body.querySelector('.dialog-backdrop') as HTMLElement
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(wrapper.emitted('close')).toBeUndefined()

    await wrapper.setProps({ busy: false })
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await nextTick()
    expect(wrapper.emitted('close')).toHaveLength(2)

    wrapper.unmount()
    expect(document.body.style.overflow).toBe('')
    expect(document.activeElement).toBe(trigger)
  })
})

describe('CloudflareQuota & QuotaDetails', () => {
  it('renders skeleton, status texts, 90% warning states, ARIA progressbars and editing constraints', async () => {
    const skeleton = mount(CloudflareQuota, {
      props: { usage: null, busy: true, error: '', editing: false },
    })
    expect(skeleton.find('.quota-skeleton').exists()).toBe(true)
    expect(skeleton.findAll('.quota-skeleton > div')).toHaveLength(4)

    const cases: Array<[Partial<AccountUsage>, string, string]> = [
      [{ status: 'ok' }, '', '全账号 · 今日用量'],
      [{ status: 'partial' }, '', '部分统计暂不可用'],
      [{ status: 'stale' }, '', '上次更新的数据'],
      [{ status: 'unconfigured' }, '', '统计暂未配置'],
      [{ status: 'error' }, '', '暂时无法更新'],
      [{ status: 'ok' }, '网络失败', '暂时无法更新'],
    ]
    for (const [patch, error, expected] of cases) {
      const w = mount(CloudflareQuota, { props: { usage: sampleUsage(patch), busy: false, error, editing: false } })
      expect(w.find('.quota-heading p').text()).toBe(expected)
      if (patch.status === 'stale') expect(w.find('.quota-footer span').text()).toBe('显示上次数据')
    }

    const wrapper = mount(CloudflareQuota, {
      props: { usage: sampleUsage(), busy: false, error: '', editing: false },
    })
    const productButtons = wrapper.findAll('.quota-product')
    expect(productButtons).toHaveLength(4)
    expect(productButtons[0]!.find('strong').classes()).toContain('quota-warning')
    expect(productButtons[0]!.attributes('style')).toContain('#df5a45')
    expect(productButtons[0]!.find('[role="progressbar"]').attributes('aria-valuenow')).toBe('92')
    expect(productButtons[0]!.find('[role="progressbar"]').attributes('aria-valuetext')).toBe('92.0%')

    await wrapper.find('.quota-refresh').trigger('click')
    await productButtons[0]!.trigger('click')
    await wrapper.find('[aria-label="查看额度详情"]').trigger('click')
    expect(wrapper.emitted('refresh')).toHaveLength(1)
    expect(wrapper.emitted('open')).toHaveLength(2)

    await wrapper.setProps({ editing: true })
    expect((wrapper.find('.quota-refresh').element as HTMLButtonElement).disabled).toBe(true)
    expect((wrapper.find('.quota-product').element as HTMLButtonElement).disabled).toBe(true)
    expect((wrapper.find('[aria-label="查看额度详情"]').element as HTMLButtonElement).disabled).toBe(true)
    await wrapper.find('[aria-label="移除 Cloudflare 额度拼贴"]').trigger('click')
    expect(wrapper.emitted('hide')).toHaveLength(1)
  })

  it('renders 14 metrics across 4 product groups, notices and empty/busy states in QuotaDetails', async () => {
    const usage = sampleUsage({ status: 'partial', message: '部分统计暂不可用，未返回的用量不会显示为零。' })
    const wrapper = mount(QuotaDetails, {
      props: { usage, busy: false, error: '' },
    })
    expect(wrapper.findAll('.quota-detail-group')).toHaveLength(4)
    expect(wrapper.findAll('.quota-detail-metric')).toHaveLength(14)
    expect(wrapper.find('.quota-notice').text()).toContain('部分统计暂不可用')
    expect(wrapper.find('.quota-detail-metric strong').classes()).toContain('quota-warning')
    expect(wrapper.find('.quota-track.quota-high').exists()).toBe(true)
    expect(wrapper.find('.quota-metric-note').text()).toContain('Workers 说明')

    await wrapper.find('.quota-detail-refresh').trigger('click')
    expect(wrapper.emitted('refresh')).toHaveLength(1)

    await wrapper.setProps({ usage: null, busy: true, error: '请求失败' })
    expect(wrapper.find('.quota-notice').text()).toBe('请求失败')
    expect((wrapper.find('.quota-detail-refresh').element as HTMLButtonElement).disabled).toBe(true)
    expect(wrapper.text()).toContain('正在读取统计…')
  })
})

describe('IconPicker', () => {
  it('loads icons, filters by Chinese aliases, paginates and emits selection', async () => {
    const wrapper = mount(IconPicker, { props: { selected: 'Globe' } })
    expect(wrapper.find('.picker-empty').text()).toBe('加载中…')
    await flushPromises()

    const counterBefore = wrapper.find('.icon-pagination span').text()
    expect(counterBefore).toMatch(/^1 \/ \d+ · \d+$/)
    expect((wrapper.find('button[aria-label="上一页"]').element as HTMLButtonElement).disabled).toBe(true)

    await wrapper.find('button[aria-label="下一页"]').trigger('click')
    expect(wrapper.find('.icon-pagination span').text()).toMatch(/^2 \/ /)

    // 中文别名“服务器”映射到 server，且搜索重置页码到 1
    await wrapper.find('input[aria-label="搜索 Lucide 图标"]').setValue('服务器')
    expect(wrapper.find('.icon-pagination span').text()).toMatch(/^1 \/ /)
    const serverBtn = wrapper.find('button[aria-label="Server"]')
    expect(serverBtn.exists()).toBe(true)
    await serverBtn.trigger('click')
    expect(wrapper.emitted('select')).toEqual([['Server']])

    await wrapper.setProps({ selected: 'Server' })
    expect(wrapper.find('button[aria-label="Server"]').attributes('aria-pressed')).toBe('true')

    await wrapper.find('input[aria-label="搜索 Lucide 图标"]').setValue('__nonexistent_icon_xyz__')
    expect(wrapper.find('.picker-empty').text()).toBe('未找到图标')
  })
})

describe('TurnstileWidget', () => {
  function interceptTurnstileScript() {
    let injected: HTMLScriptElement | null = null
    const originalAppend = document.head.appendChild.bind(document.head)
    vi.spyOn(document.head, 'appendChild').mockImplementation((node: Node) => {
      if (node instanceof HTMLScriptElement && node.dataset.turnstile) {
        injected = node
        return node as never
      }
      return originalAppend(node)
    })
    return () => injected
  }

  it('injects script when absent, renders widget, forwards callbacks, resets and removes on unmount', async () => {
    let capturedOptions: Record<string, (...args: unknown[]) => void> | undefined
    const render = vi.fn((_el: HTMLElement, options: Record<string, (...args: unknown[]) => void>) => {
      capturedOptions = options
      return 'widget-1'
    })
    const reset = vi.fn()
    const remove = vi.fn()
    const getInjected = interceptTurnstileScript()

    const wrapper = mount(TurnstileWidget, { props: { sitekey: 'test-site-key' } })
    const script = getInjected()!
    expect(script).not.toBeNull()
    expect(script.src).toBe('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit')

    window.turnstile = { render, reset, remove }
    script.dispatchEvent(new Event('load'))
    expect(render).toHaveBeenCalledTimes(1)

    capturedOptions!.callback!('tok-123')
    capturedOptions!['expired-callback']!()
    capturedOptions!['error-callback']!()
    expect(wrapper.emitted('token')).toEqual([['tok-123'], [''], ['']])
    expect(wrapper.emitted('error')).toHaveLength(1)

    ;(wrapper.vm as unknown as { reset: () => void }).reset()
    expect(reset).toHaveBeenCalledWith('widget-1')
    expect(wrapper.emitted('token')!.at(-1)).toEqual([''])

    wrapper.unmount()
    expect(remove).toHaveBeenCalledWith('widget-1')
  })

  it('emits error when turnstile script fails to load', () => {
    const getInjected = interceptTurnstileScript()
    const wrapper = mount(TurnstileWidget, { props: { sitekey: 'test-site-key' } })
    const script = getInjected()!
    script.dispatchEvent(new Event('error'))
    expect(wrapper.emitted('error')).toHaveLength(1)
  })
})
