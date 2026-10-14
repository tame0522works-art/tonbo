// ノンブルの候補の拾い方、番号の並びの判定、印刷所ごとの条件を確かめる。
// 最後に、組み立てた PDF から pdf.js で文字を取り出し、座標の受け渡しが合っているかも見る
import assert from 'node:assert/strict'
import { analyzeNombres, kanjiNumber, nombreCandidates, type TextItem } from '../src/check/nombre.ts'
import { checkDocument, type CheckOptions } from '../src/check/rules.ts'
import { extractTexts } from '../src/check/text.ts'
import { PT_PER_MM, type DocumentFacts, type PageFacts } from '../src/pdf/inspect.ts'
import { PRINTERS } from '../src/specs/index.ts'
import { mm, PdfBuilder } from './pdf-builder.ts'

const P = PT_PER_MM
const box = (wMm: number, hMm: number, offMm = 0) => ({ x0: offMm * P, y0: offMm * P, x1: (offMm + wMm) * P, y1: (offMm + hMm) * P })
// A5 塗り足し込み（154×216）の中央に仕上がり（148×210）
const trim = box(148, 210, 3)
/** 仕上がりの左下から (xMm, yMm) の位置に、高さ hMm の文字 */
const text = (str: string, xMm: number, yMm: number, hMm = 3): TextItem => ({ str, x: (3 + xMm) * P, y: (3 + yMm) * P, w: str.length * hMm * 0.6 * P, h: hMm * P })

assert.equal(kanjiNumber('十二'), 12)
assert.equal(kanjiNumber('百五'), 105)
assert.equal(kanjiNumber('一二三'), 123)
assert.equal(kanjiNumber('三十'), 30)
assert.equal(kanjiNumber('ノ'), null)

// 余白の数字だけを拾い、本文中の数字や仕上がりから大きく離れた書き込みは拾わない
{
  const c = nombreCandidates(
    [
      text('12', 70, 8), // 下の余白
      text('－ 13 －', 70, 200), // 上の余白、全角の飾りつき
      text('2026', 70, 100), // 本文の真ん中
      text('第3章の12ページ', 10, 8), // 文の一部
      text('５', 1, 100), // ノド側の隠しノンブル（全角）
      text('9', 70, -12), // 仕上がりから 12mm 外（トンボの外）
    ],
    trim,
  ).map((x) => x.value)
  assert.deepEqual(c, [12, 13, 5])
}

function pageText(n: number, items: TextItem[]) {
  return { number: n, trim, items }
}
{
  // 3ページ目から始まる本（offset 2）。4ページ目だけ番号がなく、5ページ目は番号が違う
  const a = analyzeNombres([
    pageText(1, [text('3', 70, 8)]),
    pageText(2, [text('4', 70, 8)]),
    pageText(3, [text('5', 70, 8)]),
    pageText(4, []),
    pageText(5, [text('9', 70, 8)]),
    pageText(6, [text('8', 70, 8)]),
  ])
  assert.equal(a.offset, 2)
  assert.deepEqual(
    a.pages.map((p) => [p.expected, p.found?.value ?? null, p.candidates.length]),
    [
      [3, 3, 1],
      [4, 4, 1],
      [5, 5, 1],
      [6, null, 0],
      [7, null, 1],
      [8, 8, 1],
    ],
  )
}
{
  // 文字が取れない（画像にした）原稿は、基準を決めない
  const a = analyzeNombres([pageText(1, []), pageText(2, []), pageText(3, [text('3', 70, 8)])])
  assert.equal(a.offset, null)
}

// --- 印刷所ごとの判定 ---
const spec = (id: string) => PRINTERS.find((p) => p.id === id)!
const media = box(154, 216)
const page = (n: number): PageFacts => ({ number: n, mediaBox: media, cropBox: media, rotate: 0, fonts: [], images: [], rgbPaintOps: 0, spotColors: [], unreadable: [] })
const facts = (n: number): DocumentFacts => ({ version: '1.7', repaired: false, pdfx: '', pages: Array.from({ length: n }, (_, i) => page(i + 1)) })
const opts = (id: string): CheckOptions => ({ printer: spec(id), formatId: 'A5', part: 'body', ink: 'mono', binding: 'perfect' })
const nombreCodes = (id: string, texts: TextItem[][]) =>
  checkDocument(facts(texts.length), opts(id), texts)
    .filter((f) => f.code.startsWith('nombre'))
    .map((f) => [f.code, f.level, f.pages])

const good = [1, 2, 3, 4].map((n) => [text(String(n), 70, 8)])
for (const id of ['nikko', 'ryokuyou', 'popls', 'shimaya']) assert.deepEqual(nombreCodes(id, good), [], id)

const gap = [[text('1', 70, 8)], [text('2', 70, 8)], [], [text('4', 70, 8)]]
assert.deepEqual(nombreCodes('ryokuyou', gap), [['nombre-missing', 'error', [3]]])
assert.deepEqual(nombreCodes('popls', gap), [['nombre-missing', 'info', [3]]], 'ポプルスはノンブル不要')

// 日光企画: 偶数始まり・漢数字・塗り足しへのはみ出し
assert.deepEqual(nombreCodes('nikko', [2, 3, 4, 5].map((n) => [text(String(n), 70, 8)])), [['nombre-odd-start', 'warn', []]])
assert.deepEqual(
  nombreCodes('nikko', [[text('一', 70, 8)], [text('二', 70, 8)], [text('3', 70, 8)], [text('4', 70, 8)]]),
  [['nombre-kanji', 'error', [1, 2]]],
)
assert.deepEqual(nombreCodes('nikko', [[text('1', 70, -2)], [text('2', 70, 8)], [text('3', 70, 8)], [text('4', 70, 8)]]), [['nombre-outside', 'warn', [1]]])
// 緑陽社: 高さ 2mm 未満
assert.deepEqual(nombreCodes('ryokuyou', [1, 2, 3, 4].map((n) => [text(String(n), 70, 8, n === 2 ? 1.2 : 3)])), [['nombre-small', 'warn', [2]]])
// 文字が取れない原稿は、必須の印刷所でも「確かめられない」の1件だけにする
assert.deepEqual(nombreCodes('shimaya', [[], [], [], []]), [['nombre-undetectable', 'warn', []]])

// --- pdf.js での取り出し ---
{
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const b = new PdfBuilder()
  const root = b.reserve()
  const pages = b.reserve()
  const font = b.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const kids: number[] = []
  for (const n of [1, 2, 3]) {
    // 仕上がりの下端から 8mm、左右の中央にノンブル。本文に「2026」
    const c = b.add('<< >>', `BT /F1 9 Tf ${mm(3 + 72)} ${mm(3 + 8)} Td (${n}) Tj ET BT /F1 10 Tf ${mm(20)} ${mm(100)} Td (in 2026 we) Tj ET`)
    kids.push(b.add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${mm(154)} ${mm(216)}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c} 0 R >>`))
  }
  b.set(root, `<< /Type /Catalog /Pages ${pages} 0 R >>`)
  b.set(pages, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count 3 >>`)
  const task = pdfjs.getDocument({ data: new Uint8Array(b.build(root)), verbosity: 0 })
  const doc = await task.promise
  const texts = await extractTexts(doc as never)
  const a = analyzeNombres(texts.map((items, i) => ({ number: i + 1, trim, items })))
  assert.equal(a.offset, 0)
  assert.ok(a.pages.every((p) => p.found), '3ページともノンブルが見つかる')
  // 9pt の文字の高さ ≒ 3.2mm、位置は仕上がりの下端から 8mm
  const f = a.pages[0].found!
  assert.ok(Math.abs(f.heightMm - 9 / P) < 0.1, `高さ ${f.heightMm}`)
  assert.ok(Math.abs(f.box.y0 / P - 11) < 0.1, `位置 ${f.box.y0 / P}`)
  await task.destroy()
}

console.log('check:nombre ok')
