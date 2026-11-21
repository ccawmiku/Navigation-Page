import { DurableObject } from 'cloudflare:workers'

type DashboardRow = { data: string; revision: number }
type AuthState = { password?: string; epoch: string }

export class DashboardStore extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS dashboard (
        id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
    `)
  }

  private get sql() { return this.ctx.storage.sql }

  getEpoch(): string {
    return this.getSetting('epoch') || '0'
  }

  private getSetting(key: string): string | undefined {
    return this.sql.exec<{ value: string }>('SELECT value FROM settings WHERE key = ?', key).toArray()[0]?.value
  }

  getLoginState(): AuthState {
    return { password: this.getSetting('password'), epoch: this.getEpoch() }
  }

  recordLoginAttempt(key: string, now: number): number {
    return this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM login_attempts WHERE expires < ?', now)
      return this.sql.exec<{ count: number }>(`INSERT INTO login_attempts (key,count,expires)
        VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count`, key, now + 900).one().count
    })
  }

  readDashboard(): DashboardRow | undefined {
    return this.sql.exec<DashboardRow>('SELECT data,revision FROM dashboard WHERE id=1').toArray()[0]
  }

  saveDashboard(data: string, revision: number): number | null {
    const saved = revision === 0
      ? this.sql.exec<{ revision: number }>('INSERT OR IGNORE INTO dashboard(id,data,revision) VALUES(1,?,1) RETURNING revision', data)
      : this.sql.exec<{ revision: number }>(`UPDATE dashboard SET data=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP
          WHERE id=1 AND revision=? RETURNING revision`, data, revision)
    return saved.toArray()[0]?.revision ?? null
  }

  setPassword(expectedEpoch: string, password: string, epoch: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      if (this.getEpoch() !== expectedEpoch) return false
      this.sql.exec("INSERT OR REPLACE INTO settings(key,value) VALUES ('password',?),('epoch',?)", password, epoch)
      return true
    })
  }
}
