// ページの事実と印刷所の仕様から、期待どおりの指摘が出るか（出ないべきものが出ないか）を確かめる
import assert from 'node:assert/strict'
import { checkDocument, computeSpine, type CheckOptions } from '../src/check/rules.ts'
import { PT_PER_MM, type DocumentFacts, type ImagePlacement, type PageFacts } from '../src/pdf/inspect.ts'
import { PRINTERS } from '../src/specs/index.ts'

const spec = (id: string) => PRINTERS.find((p) => p.id === id)!
const box = (wMm: number, hMm: number, offMm = 0) => ({ x0: offMm * PT_PER_MM, y0: offMm * PT_PER_MM, x1: (offMm + wMm) * PT_PER_MM, y1: (offMm + hMm) * PT_PER_MM })

function page(n: number, over: Partial<PageFacts> = {}): PageFacts {
  const media = box(154, 216)
  return { number: n, mediaBox: media, cropBox: media, rotate: 0, fonts: [], images: [], rgbPaintOps: 0, spotColors: [], unreadable: [], ...over }
}
const doc = (pages: PageFacts[], over: Partial<DocumentFacts> = {}): DocumentFacts => ({ version: '1.7', repaired: false, pdfx: '', pages, ...over })
const image = (over: Partial<ImagePlacement>): ImagePlacement => ({
  label: 'Im0',
  pxWidth: 100,
  pxHeight: 100,
  color: 'cmyk',
  bitsPerComponent: 8,
  dpiX: 350,
  dpiY: 350,
  bounds: box(50, 50, 10),
  ...over,
})
const opts = (over: Partial<CheckOptions> = {}): CheckOptions => ({ printer: spec('ryokuyou'), formatId: 'A5', part: 'body', ink: 'mono', binding: 'perfect', ...over })
const codes = (d: DocumentFacts, o = opts()) => checkDocument(d, o).map((f) => f.code)

// 何も問題のない A5 の本文（塗り足し込み 154×216mm、偶数ページ）では指摘が出ない
assert.deepEqual(codes(doc([page(1), page(2)])), [])

// --- サイズ ---
assert.deepEqual(codes(doc([page(1, { mediaBox: box(148, 210), cropBox: box(148, 210) }), page(2)])), ['no-bleed'])
assert.deepEqual(codes(doc([page(1, { mediaBox: box(182, 257), cropBox: box(182, 257) }), page(2)])), ['page-size'])
// トンボ付き（各辺 +13mm ほど）
assert.deepEqual(codes(doc([page(1, { mediaBox: box(174, 236), cropBox: box(174, 236) }), page(2)])), ['with-marks'])
// 横向きに保存して Rotate で縦に戻しているページは、見たままの向きで比べる
assert.deepEqual(codes(doc([page(1, { mediaBox: box(216, 154), cropBox: box(216, 154), rotate: 90 }), page(2)])), [])
// TrimBox があれば、それで仕上がりと塗り足しを確かめる
assert.deepEqual(codes(doc([page(1, { trimBox: box(148, 210, 3), bleedBox: box(154, 216) }), page(2)])), [])
assert.deepEqual(codes(doc([page(1, { trimBox: box(148, 210, 1), mediaBox: box(150, 212), cropBox: box(150, 212) }), page(2)])), ['bleed-short'])
assert.deepEqual(codes(doc([page(1, { trimBox: box(182, 257, 3) }), page(2)])), ['trim-size'])
// 判型の寸法は印刷所ごと: 新書 107×175 はポプルスでは合い、緑陽社（114×182）では合わない
const shinsho = [page(1, { mediaBox: box(113, 181), cropBox: box(113, 181) }), page(2, { mediaBox: box(113, 181), cropBox: box(113, 181) })]
assert.deepEqual(codes(doc(shinsho), opts({ printer: spec('popls'), formatId: 'shinsho', binding: 'saddle' })), ['page-unit'])
assert.deepEqual(codes(doc(shinsho), opts({ formatId: 'shinsho' })), ['page-size'])
// 日光企画の新書は 105×175mm（テンプレートから読み取り）
const nikkoShinsho = [1, 2, 3, 4].map((n) => page(n, { mediaBox: box(111, 181), cropBox: box(111, 181) }))
assert.deepEqual(codes(doc(nikkoShinsho), opts({ printer: spec('nikko'), formatId: 'shinsho' })), [])

// --- 解像度 ---
{
  const d = doc([
    page(1, { images: [image({ dpiX: 349, dpiY: 349 })] }), // 丸めの範囲なので出さない
    page(2, { images: [image({ dpiX: 250, dpiY: 400 })] }), // 縦横の低いほうで判断
    page(3, { images: [image({ color: 'gray', dpiX: 400, dpiY: 400 })] }), // グレーは 600 推奨・300 で可
    page(4, { images: [image({ color: 'mask', dpiX: 1200, dpiY: 1200 })] }),
    page(5, { images: [image({ color: 'gray', dpiX: 200, dpiY: 200, bounds: box(10, 10, 500) })] }), // ページの外なので数えない
    page(6),
  ])
  const f = checkDocument(d, opts())
  assert.deepEqual(
    f.map((x) => [x.code, x.pages]),
    [
      ['dpi-color', [2]],
      ['dpi-gray', [3]],
    ],
  )
  assert.ok(f[0].sources.every((s) => s.url.startsWith('https://www.ryokuyou.co.jp/')))
  // ポプルスはカラー 200dpi 以上なら印刷可。それを下回ると別の指摘になる
  const low = doc([page(1, { images: [image({ dpiX: 150, dpiY: 150 })] }), page(2, { images: [image({ dpiX: 250, dpiY: 250 })] })])
  assert.deepEqual(codes(low, opts({ printer: spec('popls'), formatId: 'A5', binding: 'saddle' })).sort(), ['dpi-color', 'dpi-color-low', 'page-unit'])
}

// --- フォント ---
{
  const fonts = [
    { name: 'KozMinPr6N-Regular', subtype: 'Type0', embedded: false },
    { name: 'ArialMT', subtype: 'TrueType', embedded: false },
    { name: 'GenShin', subtype: 'Type0', embedded: true },
  ]
  const d = doc([page(1, { fonts }), page(2, { fonts })])
  const f = checkDocument(d, opts({ printer: spec('nikko') }))
  // 日光企画は Arial を例外として明記している
  const byCode = Object.fromEntries(f.map((x) => [x.code, x]))
  assert.equal(byCode['font-KozMinPr6N-Regular'].level, 'error')
  assert.deepEqual(byCode['font-KozMinPr6N-Regular'].pages, [1, 2], '同じ指摘はページをまとめる')
  assert.equal(byCode['font-exempt-ArialMT'].level, 'info')
  assert.equal(checkDocument(d, opts()).find((x) => x.code === 'font-ArialMT')?.level, 'error', '緑陽社には例外がない')
}

// --- RGB ---
{
  const rgbPage = (n: number) => page(n, { rgbPaintOps: 2 })
  const d = doc([rgbPage(1), page(2)])
  assert.equal(checkDocument(d, opts()).find((x) => x.code === 'rgb-in-mono')?.level, 'warn', '緑陽社のスミ刷り本文は RGB を変換する')
  assert.equal(checkDocument(d, opts({ printer: spec('popls'), binding: 'saddle' })).find((x) => x.code === 'rgb-in-mono')?.level, 'info')
  // 表紙: 緑陽社は RGB 歓迎、しまやは変換
  const cover = doc([page(1, { images: [image({ color: 'rgb' })] })])
  assert.deepEqual(codes(cover, opts({ part: 'cover' })), ['cover-spine-unknown', 'rgb-accepted'])
  assert.deepEqual(codes(cover, opts({ part: 'cover', printer: spec('shimaya') })), ['rgb-converted', 'cover-spine-unknown'])
  // 表紙はページ数と判型の大きさを本文の基準では見ない
  assert.ok(!codes(cover, opts({ part: 'cover' })).includes('page-unit'))
}

// --- ページ数 ---
{
  const pages = (n: number) => Array.from({ length: n }, (_, i) => page(i + 1))
  assert.ok(codes(doc(pages(3))).includes('page-unit'), '緑陽社の無線とじは 2 ページ単位')
  // 緑陽社の中とじは表紙込みで 4 の倍数: 本文 8 → 12 で合う、本文 6 → 10 で合わない
  assert.ok(!codes(doc(pages(8)), opts({ binding: 'saddle' })).includes('page-unit'))
  assert.ok(codes(doc(pages(6)), opts({ binding: 'saddle' })).includes('page-unit'))
  // 日光企画の刻みは料金表なので info。B5 は 4、A5 は 8（表紙込み）
  const nikkoA5 = checkDocument(doc(pages(8)), opts({ printer: spec('nikko') })).find((x) => x.code === 'page-unit')
  assert.equal(nikkoA5?.level, 'info')
  assert.ok(!codes(doc(pages(12)), opts({ printer: spec('nikko') })).includes('page-unit'))
  const b5 = pages(8).map((p) => ({ ...p, mediaBox: box(188, 263), cropBox: box(188, 263) }))
  assert.ok(!codes(doc(b5), opts({ printer: spec('nikko'), formatId: 'B5' })).includes('page-unit'))
  // しまやは単位の記載がないので、確かめていないことを伝える
  assert.ok(codes(doc(pages(2)), opts({ printer: spec('shimaya') })).includes('page-unit-unknown'))
}

// 壊れた PDF・読めなかった部分は伝える。error → warn → info の順に並ぶ
{
  const d = doc([page(1, { unreadable: ['ページの描画命令（LZWDecode）'], fonts: [{ name: 'X', subtype: 'Type1', embedded: false }] }), page(2, { rgbPaintOps: 1 })], { repaired: true })
  assert.deepEqual(
    checkDocument(d, opts({ printer: spec('popls'), binding: 'saddle' })).map((f) => f.level),
    ['error', 'error', 'warn', 'warn', 'info'],
  )
}

// --- 表紙と背幅 ---
{
  // 背幅の式: 日光企画は表紙込みページ数 × 厚み、緑陽社は 0.05 × 本文 × 係数 + 0.4、ポプルスは全ページ ÷ 係数
  const near2 = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-9, `${a} ≒ ${b}`)
  near2(computeSpine(spec('nikko'), 'jouhou90', 100), 104 * 0.063)
  near2(computeSpine(spec('ryokuyou'), 'jouhou90', 100), 0.05 * 100 * 1.26 + 0.4)
  near2(computeSpine(spec('popls'), 'jouhou90', 100), 104 / 16.5)
  assert.equal(computeSpine(spec('shimaya'), undefined, 100), undefined, 'しまやは早見表だけ')
  assert.equal(computeSpine(spec('nikko'), 'jouhou90', undefined), undefined)

  // A5・背幅 6.7mm（緑陽社 上質90kg 100ページ）: 仕上がり 302.7×210、塗り足し込み 308.7×216
  const coverOpts = (over: Partial<CheckOptions> = {}) => opts({ part: 'cover', paperId: 'jouhou90', bodyPages: 100, ...over })
  const coverPage = (w: number, h: number, over: Partial<PageFacts> = {}) => doc([page(1, { mediaBox: box(w, h), cropBox: box(w, h), ...over })])
  assert.deepEqual(codes(coverPage(308.7, 216), coverOpts()), [])
  assert.deepEqual(codes(coverPage(302.7, 210), coverOpts()), ['no-bleed'])
  // 背幅が 1mm 狭い → 注意、3mm 広い → 要修正
  const narrow = checkDocument(coverPage(307.7, 216), coverOpts())
  assert.deepEqual(narrow.map((f) => [f.code, f.level]), [['cover-spine', 'warn']])
  assert.match(narrow[0].title, /1mm 狭い/)
  assert.deepEqual(
    checkDocument(coverPage(311.7, 216), coverOpts()).map((f) => [f.code, f.level]),
    [['cover-spine', 'error']],
  )
  // TrimBox がある表紙は、それで幅を見る
  assert.deepEqual(codes(coverPage(320, 230, { trimBox: box(302.7, 210, 5) }), coverOpts()), [])
  // トンボ付き（天地左右に 10mm ずつ）でも、天地の余白から幅を逆算する
  assert.deepEqual(codes(coverPage(322.7, 230), coverOpts()), ['with-marks'])
  // 高さが合わなければ大きさの不一致
  assert.deepEqual(codes(coverPage(308.7, 263), coverOpts()), ['cover-size'])
  // 入力した背幅が計算値より優先される（しまや出版は早見表の値を入れてもらう）
  assert.deepEqual(codes(coverPage(308.3, 216), coverOpts({ printer: spec('shimaya'), spineMm: 6.3 })), [])
}

// 表紙を数えに含めるかが書かれていない印刷所（ポプルスの平とじ: 10 ページ以上の 2 の倍数）は、両方の数え方で試す
{
  const pages = (n: number) => Array.from({ length: n }, (_, i) => page(i + 1))
  const popls = (n: number) => checkDocument(doc(pages(n)), opts({ printer: spec('popls') })).filter((f) => f.code.startsWith('page-unit'))
  assert.deepEqual(popls(10).map((f) => f.code), [], '本文だけでも表紙込みでも合う')
  const ambiguous = popls(8)
  assert.deepEqual(ambiguous.map((f) => [f.code, f.level]), [['page-unit-ambiguous', 'warn']], '本文だけなら 10 未満、表紙込みなら 12 で合う')
  assert.match(ambiguous[0].detail, /本文 8 ページで、10 ページ未満です。本文 8 ページと表紙 4 ページの計 12 ページで条件に合います/)
  assert.deepEqual(popls(7).map((f) => [f.code, f.level]), [['page-unit', 'error']], 'どちらで数えても奇数')
  // 緑陽社の無線とじ（2 ページ単位）は、表紙の 4 ページを足しても偶奇が変わらないので、結果は数え方によらない
  assert.deepEqual(
    checkDocument(doc(pages(3)), opts()).filter((f) => f.code.startsWith('page-unit')).map((f) => f.code),
    ['page-unit'],
  )
}

// 表紙の PDF が2ページ以上
{
  const coverOpts = opts({ part: 'cover', paperId: 'jouhou90', bodyPages: 100 })
  const sized = (n: number, w: number, h: number) => page(n, { mediaBox: box(w, h), cropBox: box(w, h) })
  // 1ページ目が A5 1面分（塗り足し込み）→ 表1と表4を別のページにしたとみなし、大きさと背幅は確かめない
  assert.deepEqual(codes(doc([sized(1, 154, 216), sized(2, 154, 216)]), coverOpts), ['cover-separate'])
  // 1ページ目が表4・背・表1 を並べた大きさ → 1ページ目だけ確かめたと伝える
  assert.deepEqual(codes(doc([sized(1, 308.7, 216), sized(2, 154, 216)]), coverOpts), ['cover-extra-pages'])
  // 1ページ目の背幅が違えば、その指摘も出る
  assert.deepEqual(codes(doc([sized(1, 305.7, 216), sized(2, 154, 216)]), coverOpts), ['cover-spine', 'cover-extra-pages'])
}

console.log('check:rules ok')
