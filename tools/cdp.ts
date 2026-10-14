// Edge / Chrome を画面なしで起動し、Chrome DevTools Protocol で操作するための最小限の道具。
// README の画像を撮る screenshots.ts で使う（fuda の tools/cdp.ts と同じもの）。
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Listener = (params: any, sessionId?: string) => void

/** 1本の WebSocket の上で、ブラウザ全体と各ページ（session）への命令を送り分ける */
class Connection {
  private id = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private listeners = new Map<string, Set<Listener>>()

  private ws: WebSocket

  constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`))
        else p.resolve(msg.result)
      } else if (msg.method) {
        this.listeners.get(msg.method)?.forEach((fn) => fn(msg.params, msg.sessionId))
      }
    })
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params, sessionId }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  on(method: string, fn: Listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set())
    this.listeners.get(method)!.add(fn)
  }

  close() {
    this.ws.close()
  }
}

/** 1つのタブ。send はそのタブ宛ての命令、run はタブの中で async 関数の本体を実行して戻り値を受け取る */
export class Page {
  private conn: Connection
  readonly sessionId: string
  readonly targetId: string

  constructor(conn: Connection, sessionId: string, targetId: string) {
    this.conn = conn
    this.sessionId = sessionId
    this.targetId = targetId
  }

  send(method: string, params: object = {}) {
    return this.conn.send(method, params, this.sessionId)
  }

  on(method: string, fn: (params: any) => void) {
    this.conn.on(method, (params, sessionId) => sessionId === this.sessionId && fn(params))
  }

  async run<T = unknown>(body: string): Promise<T> {
    const res = await this.send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) throw new Error(`ページ内でエラー: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`)
    return res.result.value as T
  }

  async waitFor(expr: string, label: string, timeout = 15_000) {
    const until = Date.now() + timeout
    while (Date.now() < until) {
      if (await this.run<boolean>(`return !!(${expr})`).catch(() => false)) return
      await sleep(100)
    }
    throw new Error(`${label} を待ちきれませんでした`)
  }

  async goto(url: string) {
    await this.send('Page.navigate', { url })
    await this.waitFor(`document.readyState === 'complete'`, 'ページの読み込み')
  }
}

export type Viewport = { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean; touch?: boolean }

export class Browser {
  private conn: Connection
  private stop: () => Promise<void>

  private constructor(conn: Connection, stop: () => Promise<void>) {
    this.conn = conn
    this.stop = stop
  }

  static async launch(port = 9333): Promise<Browser> {
    const exe = BROWSERS.find((p) => existsSync(p))
    if (!exe) throw new Error('Edge か Chrome が見つかりません')
    const profile = mkdtempSync(join(tmpdir(), 'tonbo-browser-'))
    const args = [
      '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-gpu',
      // Linux の CI では、利用者の名前空間が制限されていてサンドボックスを作れないことがある
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      'about:blank',
    ]
    const child = spawn(exe, args, { stdio: 'ignore' })

    let wsUrl = ''
    for (let i = 0; i < 100 && !wsUrl; i++) {
      wsUrl = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json() as Promise<{ webSocketDebuggerUrl: string }>).then((j) => j.webSocketDebuggerUrl).catch(() => '')
      if (!wsUrl) await sleep(200)
    }
    if (!wsUrl) {
      child.kill()
      throw new Error('ブラウザに接続できませんでした')
    }
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    const conn = new Connection(ws)

    // Windows の Edge は起動用のプロセスと本体が別なので、起動用を kill しても本体が残る。
    // 本体に閉じるよう頼み、プロファイルを手放すまで待ってから消す
    const stop = async () => {
      await Promise.race([conn.send('Browser.close').catch(() => {}), sleep(3000)])
      conn.close()
      child.kill()
      for (let i = 0; i < 20; i++) {
        try {
          rmSync(profile, { recursive: true, force: true })
          return
        } catch {
          await sleep(500)
        }
      }
      console.warn(`一時プロファイルを消せませんでした（残しても問題ありません）: ${profile}`)
    }
    return new Browser(conn, stop)
  }

  /** 保存データの混ざらない新しい環境（ブラウザのシークレットウィンドウのようなもの）でタブを開く */
  async newPage(viewport: Viewport, opts: { downloadPath?: string } = {}): Promise<Page> {
    const { browserContextId } = await this.conn.send('Target.createBrowserContext')
    if (opts.downloadPath) {
      await this.conn.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: opts.downloadPath, browserContextId })
    }
    const { targetId } = await this.conn.send('Target.createTarget', { url: 'about:blank', browserContextId })
    const { sessionId } = await this.conn.send('Target.attachToTarget', { targetId, flatten: true })
    const page = new Page(this.conn, sessionId, targetId)
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor ?? 1, mobile: viewport.mobile ?? false,
    })
    if (viewport.touch) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    return page
  }

  close() {
    return this.stop()
  }
}
