// README に載せる画面の画像を撮る。公開と同じ設定のビルドを配信した状態（npm run build → npm run preview）で
// `npm run screenshots` を実行する。Edge（なければ Chrome）を画面なしで起動し、Chrome DevTools Protocol で操作する。
// 同梱の見本 PDF を開き、指摘のページを開くまでを毎回同じ手順で行うので、アプリを直したら同じ画像を撮り直せる。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Browser, sleep, type Page } from './cdp.ts'

const BASE = process.argv[2] ?? 'http://localhost:5192/'
const OUT = 'docs/images'

/** 要素の上端から height px ぶんを撮る（ページ全体は長いので、見せたいところだけ切り出す） */
async function shoot(cdp: Page, name: string, selector: string, height: number, width?: number) {
  const r = await cdp.run<{ x: number; y: number; w: number }>(`
    const el = document.querySelector(${JSON.stringify(selector)});
    el.scrollIntoView({ block: 'start' });
    await new Promise(r => setTimeout(r, 300));
    const b = el.getBoundingClientRect();
    return { x: b.left + scrollX, y: b.top + scrollY, w: b.width };
  `)
  const pad = 16
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: (width ?? r.w) + pad * 2, height: height + pad * 2, scale: 1 },
  })
  writeFileSync(join(OUT, name), Buffer.from(data, 'base64'))
  console.log(`  ${OUT}/${name}`)
}

/** 印刷所を選び、見本を開いて検査結果が出るのを待つ */
const OPEN_SAMPLE = (printerId: string, which: '本文' | '表紙') => `
  const sel = document.querySelector('.settings select');
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, '${printerId}');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  [...document.querySelectorAll('.sample button')].find(b => b.textContent.includes('${which}')).click();
  for (let i = 0; i < 100 && !document.querySelector('.findings .finding'); i++) await new Promise(r => setTimeout(r, 100));
`

/** 題名に text を含む指摘の「ページを見る」を押し、ページの絵と赤枠が出るのを待つ */
const OPEN_PAGES = (text: string) => `
  const li = [...document.querySelectorAll('.finding')].find(l => l.querySelector('strong').textContent.includes(${JSON.stringify(text)}));
  li.querySelector('.show-pages').click();
  for (let i = 0; i < 100 && li.querySelectorAll('figure.preview svg').length < li.querySelectorAll('figure.preview').length; i++) await new Promise(r => setTimeout(r, 100));
  for (let i = 0; i < 100 && !li.querySelector('figure.preview'); i++) await new Promise(r => setTimeout(r, 100));
  await new Promise(r => setTimeout(r, 500));
`

async function main() {
  mkdirSync(OUT, { recursive: true })
  // このブラウザ専用の一時プロファイルを使うので、普段のデータには触れない
  const browser = await Browser.launch()
  try {
    const cdp = await browser.newPage({ width: 1180, height: 900 })
    const open = async () => {
      await cdp.goto(BASE)
      // 同じポートで別の作品が動いていると、その画面を撮ってしまうので、tonbo であることを先に確かめる
      const title = await cdp.run<string>(`return document.title`)
      if (title !== 'tonbo') throw new Error(`${BASE} で動いているのは tonbo ではありません（ページの題名: ${title || 'なし'}）`)
    }

    console.log('撮影:')
    // 1. 本文の見本を緑陽社の仕様で確かめ、解像度の指摘のページを開いたところ
    await open()
    await cdp.run(`${OPEN_SAMPLE('ryokuyou', '本文')} ${OPEN_PAGES('解像度')}`)
    await shoot(cdp, 'findings.png', 'section', 900)

    // 2. 設定欄（日光企画の判型・注記）と、ドロップ欄
    await shoot(cdp, 'settings.png', 'main', 330)

    // 3. 表紙の見本で、背幅のずれを示したところ（日光企画、上質90kg・本文100ページ）
    await open()
    await cdp.run(`${OPEN_SAMPLE('nikko', '表紙')} ${OPEN_PAGES('背幅')}`)
    await shoot(cdp, 'cover.png', 'section', 560)

    // 4. スマホ（本文の見本を日光企画の仕様で）
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
    await open()
    await cdp.run(`${OPEN_SAMPLE('nikko', '本文')}`)
    await sleep(300)
    await shoot(cdp, 'mobile.png', 'section', 760)
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
