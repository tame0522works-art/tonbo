// 画面操作のテスト。公開と同じ設定でビルドしたもの（CSP 入り）をローカルで配信し、
// 本物のマウス操作とファイル選択を送って、これまでに直した不具合が戻っていないかを確かめる。
// `npm run e2e` で実行する（先に dist-e2e へビルドしてから、このスクリプトが配信とブラウザを立ち上げる）。
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { Browser, sleep, type Page, type Viewport } from './cdp.ts'
import { flate, mm, PdfBuilder } from './pdf-builder.ts'

const PORT = 4191
const BASE = `http://127.0.0.1:${PORT}/`
const DESKTOP: Viewport = { width: 1280, height: 900 }
const PHONE: Viewport = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, touch: true }
const FAILURES = 'e2e-failures'

/** ページの操作。クリックは要素の中央に本物のマウス入力を送る */
class Ui {
  readonly page: Page
  readonly files: string
  constructor(page: Page, files: string) {
    this.page = page
    this.files = files
  }

  async open() {
    await this.page.goto(BASE)
    await this.page.waitFor(`document.querySelector('.drop input')`, '画面の表示')
  }

  /** 要素を画面に入れてから、その中央をクリックする */
  async click(selector: string, text?: string) {
    const p = await this.page.run<{ x: number; y: number } | null>(`
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const el = ${text === undefined ? 'els[0]' : `els.find(e => e.textContent.includes(${JSON.stringify(text)}))`};
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      await new Promise(r => setTimeout(r, 100));
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    `)
    if (!p) throw new Error(`${selector}${text ? `（${text}）` : ''} が見つかりません`)
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.page.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 })
    }
    await sleep(150)
  }

  /** 設定欄の select を、表示の文字で選ぶ */
  async choose(label: string, option: string) {
    await this.page.run(`
      const l = [...document.querySelectorAll('.settings label')].find(l => l.textContent.startsWith(${JSON.stringify(label)}));
      const s = l.querySelector('select');
      const i = [...s.options].findIndex(o => o.textContent.includes(${JSON.stringify(option)}));
      if (i < 0) throw new Error(${JSON.stringify(`${label} に ${option} がありません`)});
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, s.options[i].value);
      s.dispatchEvent(new Event('change', { bubbles: true }));
    `)
    await sleep(200)
  }

  /** 結果の見出しの横の選択欄で、そのファイルを本文か表紙かに切り替える */
  async setPart(fileName: string, part: '本文' | '表紙') {
    await this.page.run(`
      const sec = [...document.querySelectorAll('section')].find(s => s.querySelector('h2').textContent.includes(${JSON.stringify(fileName)}));
      if (!sec) throw new Error(${JSON.stringify(`${fileName} の結果がありません`)});
      const sel = sec.querySelector('.part select');
      const i = [...sel.options].findIndex(o => o.textContent === ${JSON.stringify(part)});
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, sel.options[i].value);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    `)
    await sleep(200)
  }

  /** ファイルごとの結果（見出し・本文か表紙か・指摘の題名） */
  sections() {
    return this.page.run<{ name: string; part: string; titles: string[] }[]>(`
      return [...document.querySelectorAll('section')].map(s => ({
        name: s.querySelector('h2').textContent,
        part: s.querySelector('.part select')?.selectedOptions[0].textContent ?? '',
        titles: [...s.querySelectorAll('.finding strong')].map(x => x.textContent),
      }));
    `)
  }

  /** 設定欄の数値の入力欄に、キーボードで打ち込む */
  async type(label: string, text: string) {
    await this.click('.settings label', label)
    await this.page.run(`document.activeElement.select?.()`)
    await this.page.send('Input.insertText', { text })
    await sleep(200)
  }

  /** ファイル選択の欄に、手元のファイルを選んだことにする（利用者がダイアログで選ぶのと同じ経路） */
  async chooseFiles(paths: string[]) {
    const { result } = await this.page.send('Runtime.evaluate', { expression: `document.querySelector('.drop input')` })
    await this.page.send('DOM.setFileInputFiles', { files: paths, objectId: result.objectId })
  }

  /** 検査が終わる（読み込み中の表示が消え、結果が出る）まで待つ */
  async waitForResult(timeout = 30_000) {
    await this.page.waitFor(`!document.querySelector('.progress') && document.querySelector('section')`, '検査の結果', timeout)
    await sleep(200)
  }

  findings() {
    return this.page.run<{ level: string; title: string }[]>(`
      return [...document.querySelectorAll('.finding')].map(li => ({ level: li.querySelector('.level').textContent, title: li.querySelector('strong').textContent }));
    `)
  }

  /** 題名に text を含む指摘の「ページを見る」を押し、ページの絵が描き終わるまで待つ */
  async openPages(text: string) {
    const i = await this.page.run<number>(
      `return [...document.querySelectorAll('.findings > .finding')].findIndex(l => l.querySelector('strong').textContent.includes(${JSON.stringify(text)}))`,
    )
    if (i < 0) throw new Error(`「${text}」の指摘がありません`)
    await this.click(`.findings > .finding:nth-child(${i + 1}) .show-pages`)
    await this.page.waitFor(
      `(() => { const li = [...document.querySelectorAll('.finding')].find(l => l.querySelector('strong').textContent.includes(${JSON.stringify(text)}));
        const f = [...li.querySelectorAll('figure.preview')]; return f.length > 0 && f.every(x => x.querySelector('svg') || x.querySelector('.preview-failed')) })()`,
      'ページの表示',
    )
    return this.page.run<{ failed: number; marks: string[]; inked: number[] }>(`
      const li = [...document.querySelectorAll('.finding')].find(l => l.querySelector('strong').textContent.includes(${JSON.stringify(text)}));
      const figs = [...li.querySelectorAll('figure.preview')];
      return {
        failed: figs.filter(f => f.querySelector('.preview-failed')).length,
        marks: figs.flatMap(f => [...f.querySelectorAll('svg > g')].map(g => g.querySelector('.tag text')?.textContent ?? '枠')),
        // 描かれた画素のうち、白でないものの数（何か描けているか）
        inked: figs.map(f => { const c = f.querySelector('canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200)) n++; return n }),
      };
    `)
  }

  /** ページを開いてから起きた CSP 違反（意図して起こしたもの以外は 0 のはず） */
  violations() {
    return this.page.run<string[]>(`return window.__csp ?? []`)
  }

  file(name: string, bytes: Uint8Array): string {
    const p = join(this.files, name)
    writeFileSync(p, bytes)
    return p
  }
}

// ---- 確認用のファイル ----

function pdfOf(pages: { w: number; h: number; content?: string; resources?: string }[], extra: { trailer?: string; objects?: (b: PdfBuilder) => string } = {}) {
  const b = new PdfBuilder()
  const root = b.reserve()
  const parent = b.reserve()
  const res = extra.objects?.(b) ?? ''
  const kids = pages.map((p) =>
    b.add(`<< /Type /Page /Parent ${parent} 0 R /MediaBox [0 0 ${mm(p.w)} ${mm(p.h)}] /Resources << ${p.resources ?? res} >> /Contents ${b.add('<< /Filter /FlateDecode >>', flate(p.content ?? ''))} 0 R >>`),
  )
  b.set(root, `<< /Type /Catalog /Pages ${parent} 0 R >>`)
  b.set(parent, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`)
  let trailer = extra.trailer
  if (trailer?.includes('ENCRYPT')) trailer = trailer.replace('ENCRYPT', `${b.add('<< /Filter /Standard /V 2 /R 3 /P -4 /O <00> /U <00> >>')} 0 R`)
  return b.build(root, { trailerExtra: trailer })
}

/** 埋め込みのない日本語フォント（UniJIS-UCS2-H）で「日本語の本文」と書いた A5 のページ */
function cjkPdf() {
  const text = Buffer.from('日本語の本文', 'utf16le').swap16().toString('hex')
  return pdfOf([{ w: 154, h: 216, content: `BT /F1 24 Tf ${mm(20)} ${mm(150)} Td <${text}> Tj ET` }], {
    objects: (b) => {
      const desc = b.add('<< /Type /FontDescriptor /FontName /MS-Mincho /Flags 4 /FontBBox [0 -141 1000 859] /ItalicAngle 0 /Ascent 859 /Descent -141 /CapHeight 700 /StemV 80 >>')
      const cid = b.add(`<< /Type /Font /Subtype /CIDFontType0 /BaseFont /MS-Mincho /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor ${desc} 0 R /DW 1000 >>`)
      return `/Font << /F1 ${b.add(`<< /Type /Font /Subtype /Type0 /BaseFont /MS-Mincho /Encoding /UniJIS-UCS2-H /DescendantFonts [${cid} 0 R] >>`)} 0 R >>`
    },
  })
}

/** 300ページの原稿（読み込みに時間がかかり、進み具合の表示を見られる） */
function bigPdf() {
  const b = new PdfBuilder()
  const root = b.reserve()
  const parent = b.reserve()
  const font = b.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const kids: number[] = []
  for (let n = 1; n <= 300; n++) {
    let ops = `BT /F1 6 Tf 8 TL ${mm(10)} ${mm(200)} Td `
    for (let i = 0; i < 300; i++) ops += `(line ${i} of page ${n}) Tj T* `
    ops += `ET BT /F1 8 Tf ${mm(77)} ${mm(11)} Td (${n}) Tj ET`
    kids.push(b.add(`<< /Type /Page /Parent ${parent} 0 R /MediaBox [0 0 ${mm(154)} ${mm(216)}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${b.add('<< /Filter /FlateDecode >>', flate(ops))} 0 R >>`))
  }
  b.set(root, `<< /Type /Catalog /Pages ${parent} 0 R >>`)
  b.set(parent, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count 300 >>`)
  return b.build(root, { compressed: true })
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])))
  return Buffer.concat([head, data, crc])
}

/**
 * ブラウザで表示できる本物の PNG。塗り足し込み A5（154×216mm）を 72dpi で作る。
 * palette を渡すと、白と黒のパレット画像（1bit）にする
 */
function png(seed: number, palette = false): Uint8Array {
  const w = 437
  const h = 612
  const bpp = palette ? 1 / 8 : 1
  const rowBytes = Math.ceil(w * bpp)
  const raw = Buffer.alloc((rowBytes + 1) * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < rowBytes; x++) raw[y * (rowBytes + 1) + 1 + x] = palette ? ((y >> 4) + seed) % 2 ? 0xff : 0x0f : (x * 3 + y + seed * 40) & 0xff
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = palette ? 1 : 8
  ihdr[9] = palette ? 3 : 0
  const phys = Buffer.alloc(9)
  phys.writeUInt32BE(Math.round(72 / 0.0254), 0)
  phys.writeUInt32BE(Math.round(72 / 0.0254), 4)
  phys[8] = 1
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...(palette ? [pngChunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255]))] : []),
    pngChunk('pHYs', phys),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- 場面 ----

type Scenario = { name: string; viewport?: Viewport; run: (ui: Ui) => Promise<void> }

const scenarios: Scenario[] = [
  {
    name: '本文の見本: 指摘が出て、解像度の足りない画像に赤枠と値の札が付く',
    async run(ui) {
      await ui.open()
      await ui.click('.sample button', '本文')
      await ui.waitForResult()
      const f = await ui.findings()
      assert.deepEqual(
        f.map((x) => x.title),
        [
          'フォント「MS-Mincho」が埋め込まれていません',
          'ノンブルが見つからないページがあります',
          'カラーの画像の解像度が推奨（350dpi）より低いです',
          'モノクロ本文に RGB の色が使われています',
          '塗り足しがありません',
          'ページ数が料金表の刻みに合いません',
        ],
      )
      const pages = await ui.openPages('解像度')
      assert.equal(pages.failed, 0)
      assert.deepEqual(pages.marks, ['約 95dpi'])
      assert.ok(pages.inked[0] > 1000, 'ページの絵が描かれている')
      assert.deepEqual(await ui.violations(), [])
    },
  },
  {
    name: '印刷所を変えると、同じ原稿でも指摘の重さが変わる',
    async run(ui) {
      await ui.open()
      await ui.click('.sample button', '本文')
      await ui.waitForResult()
      const level = async (title: string) => (await ui.findings()).find((f) => f.title.includes(title))?.level
      assert.equal(await level('ノンブル'), '要修正')
      assert.equal(await level('RGB'), '注意')
      // ポプルスはノンブル不要、モノクロ本文の RGB の混在も可
      await ui.choose('印刷所', 'ポプルス')
      assert.equal(await level('ノンブル'), '参考')
      assert.equal(await level('RGB'), '参考')
    },
  },
  {
    name: '表紙の見本: 背幅のずれを示し、早見表しかない印刷所では手入力した背幅で確かめる',
    async run(ui) {
      await ui.open()
      await ui.click('.sample button', '表紙')
      await ui.waitForResult()
      assert.equal((await ui.findings())[0].title, '表紙の背幅が 2.6mm 狭いです')
      const pages = await ui.openPages('背幅')
      assert.deepEqual(pages.marks, ['背 4mm'])
      // しまや出版は式がないので、背幅がわからないと伝える。早見表の値を打ち込むと確かめられる
      await ui.choose('印刷所', 'しまや出版')
      assert.ok((await ui.findings()).some((f) => f.title.includes('背幅がわからない')))
      await ui.type('背幅', '6.3')
      assert.equal((await ui.findings())[0].title, '表紙の背幅が 2.3mm 狭いです')
      assert.deepEqual(await ui.violations(), [])
    },
  },
  {
    name: 'ファイルを選ぶ: 保護のかかった PDF・2ページの表紙・埋め込みのない日本語フォントのページ',
    async run(ui) {
      await ui.open()
      // 保護（暗号化）のかかった PDF は読み進めず、案内を出す
      await ui.chooseFiles([ui.file('protected.pdf', pdfOf([{ w: 154, h: 216 }], { trailer: '/Encrypt ENCRYPT' }))])
      await ui.waitForResult()
      const error = await ui.page.run<string>(`return document.querySelector('section p.error')?.textContent ?? ''`)
      assert.match(error, /保護（暗号化）のかかった PDF/)

      // 表1と表4を別のページにした表紙は縦長なので、まず本文と見なされる。結果の欄で表紙に直すと、
      // 大きさを誤って「合わない」とせず、別のページにした表紙として扱う
      await ui.chooseFiles([ui.file('cover-2p.pdf', pdfOf([{ w: 154, h: 216 }, { w: 154, h: 216 }]))])
      await ui.waitForResult()
      assert.equal((await ui.sections())[0].part, '本文')
      await ui.setPart('cover-2p.pdf', '表紙')
      assert.deepEqual((await ui.findings()).map((f) => f.title), ['表1と表4を別のページにした表紙とみなしました'])

      // 埋め込みのない日本語フォントのページも、CSP のもとで（CMap をスクリプトとして読んで）描ける
      await ui.chooseFiles([ui.file('cjk.pdf', cjkPdf())])
      await ui.waitForResult()
      const pages = await ui.openPages('MS-Mincho')
      assert.equal(pages.failed, 0)
      assert.ok(pages.inked[0] > 50, `日本語の文字が描かれている（${pages.inked[0]} 画素）`)
      assert.deepEqual(await ui.violations(), [])
    },
  },
  {
    name: '本文と表紙を一緒に入れると、ファイルごとに見分けて確かめる（見開きの本文も見分ける）',
    async run(ui) {
      await ui.open()
      await ui.choose('印刷所', '緑陽社')
      // 本文（A5 単ページ 4 枚）・見開きで書き出した本文・表紙（A5 上質90kg 100 ページ = 背幅 6.7mm）
      const body = pdfOf([1, 2, 3, 4].map(() => ({ w: 154, h: 216 })))
      const spread = pdfOf([1, 2].map(() => ({ w: 302, h: 216 })))
      const cover = pdfOf([{ w: 148 * 2 + 6.7 + 6, h: 216 }])
      await ui.chooseFiles([ui.file('honbun.pdf', body), ui.file('mihiraki.pdf', spread), ui.file('hyoushi.pdf', cover)])
      await ui.waitForResult()
      // 表紙のファイルがあるので、表紙の欄が出る。用紙とページ数を入れると背幅を計算して確かめる
      await ui.choose('本文の用紙', '上質90kg')
      await ui.type('本文のページ数', '100')
      const s = await ui.sections()
      assert.deepEqual(
        s.map((x) => [x.name, x.part]),
        [
          ['honbun.pdf', '本文'],
          ['mihiraki.pdf', '本文'],
          ['hyoushi.pdf', '表紙'],
        ],
      )
      // 本文は大きさの指摘なし、見開きは見開きとして伝え（大きさの不一致にはしない）、表紙は背幅が合っている
      assert.ok(!s[0].titles.some((t) => /大きさ|塗り足し/.test(t)), s[0].titles.join(' / '))
      assert.ok(s[1].titles.includes('見開きで書き出されたページがあります'))
      assert.ok(!s[1].titles.some((t) => t.includes('用紙の大きさ')))
      assert.ok(!s[2].titles.some((t) => /背幅|大きさ/.test(t)), s[2].titles.join(' / '))
      assert.deepEqual(await ui.violations(), [])
    },
  },
  {
    name: '画像原稿: ファイル名の順に並べ、ページを描き、白黒のパレット画像を RGB としない',
    async run(ui) {
      await ui.open()
      await ui.choose('印刷所', '緑陽社')
      await ui.chooseFiles([ui.file('10.png', png(3)), ui.file('2.png', png(2)), ui.file('1.png', png(1, true))])
      await ui.waitForResult()
      const rows = await ui.page.run<string[]>(`return [...document.querySelectorAll('tbody tr .file-name')].map(s => s.textContent)`)
      assert.deepEqual(rows, ['1.png', '2.png', '10.png'])
      const titles = (await ui.findings()).map((f) => f.title)
      assert.ok(!titles.some((t) => t.includes('RGB')), 'グレーと白黒のパレット画像だけなので RGB の指摘は出ない')
      const pages = await ui.openPages('解像度')
      assert.equal(pages.failed, 0)
      assert.ok(pages.inked.every((n) => n > 1000), '画像が描かれている')
      assert.deepEqual(await ui.violations(), [])
    },
  },
  {
    name: '読み込み中: 進み具合を出し、途中で別のファイルを開いたら前の結果を捨てる',
    async run(ui) {
      await ui.open()
      await ui.chooseFiles([ui.file('big.pdf', bigPdf())])
      await ui.page.waitFor(`/構造を読んでいます|文字を取り出しています/.test(document.querySelector('.progress')?.textContent ?? '')`, '進み具合の表示', 10_000)
      await ui.click('.sample button', '本文')
      await ui.waitForResult()
      await sleep(1500)
      const names = await ui.page.run<string[]>(`return [...document.querySelectorAll('section h2')].map(h => h.textContent)`)
      assert.deepEqual(names, ['見本（A5 本文・わざと不備あり）.pdf'])
    },
  },
  {
    name: 'スマホ: 指摘とページの絵が横にはみ出さない',
    viewport: PHONE,
    async run(ui) {
      await ui.open()
      await ui.click('.sample button', '本文')
      await ui.waitForResult()
      await ui.openPages('解像度')
      const { scrollW, clientW } = await ui.page.run<{ scrollW: number; clientW: number }>(
        `return { scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth }`,
      )
      assert.equal(scrollW, clientW)
    },
  },
  {
    name: '外への通信は、ブラウザが拒否する',
    async run(ui) {
      await ui.open()
      const blocked = await ui.page.run<boolean>(`try { await fetch('https://example.com/'); return false } catch { return true }`)
      assert.ok(blocked)
      await sleep(200)
      assert.ok((await ui.violations()).some((v) => v.startsWith('connect-src')))
    },
  },
]

// ---- 実行 ----

let server: ChildProcess | null = null

async function startServer() {
  // vite の preview で dist-e2e を配信する（npx を介さず、どの OS でも同じ起動のしかたにする）
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--outDir', 'dist-e2e', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    if (await fetch(BASE).then((r) => r.ok, () => false)) return
    await sleep(100)
  }
  await stopServer()
  throw new Error('テスト用のサーバーが起動しませんでした')
}

async function stopServer() {
  if (!server) return
  const s = server
  server = null
  const exited = new Promise((r) => s.once('exit', r))
  s.kill()
  await exited
}

async function main() {
  const only = process.argv[2]
  await startServer()
  const browser = await Browser.launch(9335)
  let failed = 0
  try {
    for (const s of scenarios.filter((s) => !only || s.name.includes(only))) {
      const files = mkdtempSync(join(tmpdir(), 'tonbo-e2e-'))
      const page = await browser.newPage(s.viewport ?? DESKTOP)
      // ページの中で起きた CSP 違反を記録しておく（どの場面でも、意図したもの以外は起きないはず）
      await page.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));`,
      })
      const ui = new Ui(page, files)
      const t0 = Date.now()
      try {
        await s.run(ui)
        console.log(`  ✓ ${s.name}（${((Date.now() - t0) / 1000).toFixed(1)}秒）`)
      } catch (e) {
        failed++
        console.log(`  ✗ ${s.name}\n      ${e instanceof Error ? e.message : String(e)}`)
        mkdirSync(FAILURES, { recursive: true })
        const { data } = await page.send('Page.captureScreenshot', { format: 'png' }).catch(() => ({ data: '' }))
        if (data) writeFileSync(join(FAILURES, `${scenarios.indexOf(s) + 1}.png`), Buffer.from(data, 'base64'))
      } finally {
        await page.send('Page.close').catch(() => {})
        rmSync(files, { recursive: true, force: true })
      }
    }
  } finally {
    await browser.close()
    await stopServer()
  }
  if (failed > 0) {
    console.log(`\n${failed} 件失敗しました（失敗時の画面: ${FAILURES}/）`)
    process.exit(1)
  }
  console.log('\ne2e OK')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
