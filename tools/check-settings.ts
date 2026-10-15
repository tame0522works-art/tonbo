// 画面の設定の引き継ぎ方と覚え方、本文か表紙かの見当の付け方、ページ範囲の表示を確かめる（画面の部品から切り出した、DOM に依存しない部分）
import assert from 'node:assert/strict'
import { initialSettings, printerOf, restoreSettings, sampleSettings, serializeSettings, withPrinter } from '../src/settings.ts'
import { pageRanges } from '../src/ui/format.ts'
import { guessPart, splitRasterParts } from '../src/check/part.ts'
import type { PageFacts } from '../src/pdf/inspect.ts'

assert.equal(pageRanges([5, 1, 2, 3]), '1〜3, 5')
assert.equal(pageRanges([7]), '7')
assert.equal(pageRanges([]), '')

{
  const s = initialSettings()
  assert.equal(printerOf(s).id, 'nikko')
  assert.equal(s.paperId, printerOf(s).spine.value.papers[0].id)

  // 新書は日光企画にもポプルスにもある → 引き継ぐ。A4 は日光企画にない → 先頭の判型に戻す
  assert.equal(withPrinter({ ...s, formatId: 'shinsho' }, 'popls').formatId, 'shinsho')
  assert.equal(withPrinter({ ...withPrinter(s, 'popls'), formatId: 'A4' }, 'nikko').formatId, 'A5')
  // 用紙は同じ id があれば引き継ぎ、なければ新しい印刷所の先頭に。早見表だけのしまや出版には用紙がない
  assert.equal(withPrinter({ ...s, paperId: 'jouhou90' }, 'ryokuyou').paperId, 'jouhou90')
  assert.equal(withPrinter({ ...s, paperId: 'bidan' }, 'ryokuyou').paperId, 'comic-rumba84')
  assert.equal(withPrinter(s, 'shimaya').paperId, undefined)
  // 手入力の背幅は印刷所が変わると意味が変わるので消す
  assert.equal(withPrinter({ ...s, spineMm: 6.3 }, 'popls').spineMm, undefined)

  // 見本: 表紙は本文 100 ページ・上質90kg の想定（本文か表紙かはファイルごとに持つので、設定には入らない）
  const cover = sampleSettings({ ...s, spineMm: 5, formatId: 'B5' }, 'cover')
  assert.deepEqual([cover.formatId, cover.bodyPages, cover.paperId, cover.spineMm], ['A5', 100, 'jouhou90', undefined])
  assert.equal(sampleSettings({ ...s, formatId: 'B5' }, 'body').formatId, 'A5')
}

// --- 本文か表紙かの見当 ---
{
  const P = 72 / 25.4
  const page = (n: number, wMm: number, hMm: number, rotate = 0): PageFacts => {
    const b = { x0: 0, y0: 0, x1: wMm * P, y1: hMm * P }
    return { number: n, mediaBox: b, cropBox: b, rotate, fonts: [], images: [], rgbPaintOps: 0, spotColors: [], unreadable: [] }
  }
  assert.equal(guessPart([page(1, 308.7, 216)]), 'cover', '横長の1ページは表紙')
  assert.equal(guessPart([page(1, 154, 216)]), 'body')
  assert.equal(guessPart([page(1, 216, 308.7, 90)]), 'cover', '回転して横長に見えるページも表紙')
  assert.equal(guessPart([page(1, 154, 216), page(2, 154, 216)]), 'body', '表1と表4を別にした表紙は縦長なので本文と見なす（利用者が直す）')
  assert.equal(guessPart([1, 2].map((n) => page(n, 302, 216))), 'body', '見開きの本文は2ページ以上あるので本文')

  const raster = (name: string, w: number, h: number) => ({ name, meta: { format: 'png' as const, pxWidth: w, pxHeight: h, color: 'gray' as const, bitDepth: 8, alpha: false, icc: false } })
  const groups = splitRasterParts([raster('cover.png', 4300, 3000), raster('1.png', 2122, 2976), raster('2.png', 2122, 2976)])
  assert.deepEqual(groups.map((g) => [g.part, g.files.map((f) => f.name)]), [
    ['body', ['1.png', '2.png']],
    ['cover', ['cover.png']],
  ])
  assert.deepEqual(splitRasterParts([raster('1.png', 2122, 2976)]).map((g) => g.part), ['body'])
  assert.deepEqual(splitRasterParts([raster('cover.png', 4300, 3000)]).map((g) => g.part), ['cover'])
  // 横長が2枚以上なら見開きの本文かもしれないので、分けずに本文とする
  assert.deepEqual(splitRasterParts([raster('1.png', 4244, 2976), raster('2.png', 4244, 2976), raster('3.png', 2122, 2976)]).map((g) => [g.part, g.files.length]), [['body', 3]])
}

// --- 端末に覚える ---
{
  const base = initialSettings()
  // 覚えた値をそのまま戻す。本文のページ数と手入力の背幅は覚えない
  const s = { ...withPrinter(base, 'popls'), formatId: 'B5', ink: 'color' as const, binding: 'saddle' as const, paperId: 'jouhou110', bodyPages: 80, spineMm: 6 }
  const back = restoreSettings(serializeSettings(s))
  assert.deepEqual(
    [back.printerId, back.formatId, back.ink, back.binding, back.paperId, back.bodyPages, back.spineMm],
    ['popls', 'B5', 'color', 'saddle', 'jouhou110', undefined, undefined],
  )
  // 読めない値・形の違う値は初期値に
  for (const raw of [null, '', 'not json', '[]', '{"v":2,"printerId":"popls"}', '{"v":1,"printerId":"unknown"}']) {
    assert.deepEqual(restoreSettings(raw), base, String(raw))
  }
  // 印刷所は合っていて、ほかの項目が今の仕様にないときは、その項目だけ初期値に（日光企画に A4 はない）
  const partial = restoreSettings('{"v":1,"printerId":"nikko","formatId":"A4","ink":"rainbow","binding":"saddle","paperId":"nope"}')
  assert.deepEqual([partial.printerId, partial.formatId, partial.ink, partial.binding, partial.paperId], ['nikko', 'A5', 'mono', 'saddle', base.paperId])
  // 早見表しかない印刷所（用紙がない）も戻せる
  assert.equal(restoreSettings(serializeSettings(withPrinter(base, 'shimaya'))).printerId, 'shimaya')
}

console.log('check:settings ok')
