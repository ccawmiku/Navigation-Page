import { bindings, defineConfig, defineWorker, exports } from 'cf/config'
import * as entrypoint from './worker/index.ts' with { type: 'cf-worker' }

export default defineConfig(({ mode }) => {
  const worker = defineWorker({
    name: 'home-nav',
    entrypoint,
    compatibilityDate: '2026-10-27',
    compatibilityFlags: ['nodejs_compat'],
    domains: ['index.onya.cc', 'index.yaemiko.lol'],
    workersDev: false,
    previewUrls: false,
    exports: { DashboardStore: exports.durableObject({ storage: 'sqlite' }) },
    assets: { notFoundHandling: 'single-page-application', runWorkerFirst: ['/api/*'] },
    observability: { enabled: true, logs: { enabled: true }, traces: { enabled: true, headSamplingRate: 0.01 } },
  })
  return { worker: {
    ...worker,
    env: {
      ASSETS: bindings.assets(),
      DASHBOARD_STORE: bindings.durableObject({ worker, exportName: 'DashboardStore' }),
      ADMIN_PASSWORD: bindings.secret(),
      SESSION_SECRET: bindings.secret(),
      TURNSTILE_SECRET: bindings.secret(),
      CF_ANALYTICS_TOKEN: bindings.secret(),
      CF_ANALYTICS_ACCOUNT_ID: bindings.secret(),
      TURNSTILE_SITE_KEY: bindings.text(mode === 'development' ? '1x00000000000000000000AA' : '0x4AAAAAAFoQuEqMCcs9svVR'),
    },
  } }
})
