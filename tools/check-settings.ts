// 画面の設定の引き継ぎ方と、ページ範囲の表示を確かめる（画面の部品から切り出した、DOM に依存しない部分）
import assert from 'node:assert/strict'
import { initialSettings, printerOf, sampleSettings, withPrinter } from '../src/settings.ts'
import { pageRanges } from '../src/ui/format.ts'

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

  // 見本: 表紙は本文 100 ページ・上質90kg の想定。表紙を開いたあとに本文の見本を開いても、表紙の設定は残るだけで害はない
  const cover = sampleSettings({ ...s, spineMm: 5, formatId: 'B5' }, 'cover')
  assert.deepEqual([cover.part, cover.formatId, cover.bodyPages, cover.paperId, cover.spineMm], ['cover', 'A5', 100, 'jouhou90', undefined])
  assert.equal(sampleSettings(cover, 'body').part, 'body')
}

console.log('check:settings ok')
