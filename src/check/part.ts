/**
 * 入れられたファイルが本文か表紙かを、ページの形から見当を付ける（利用者が結果の欄で直せる）。
 * 表紙は表4・背・表1 を横に並べた1枚なので横長の1ページになり、本文は縦長のページが続く。
 * 見開きで書き出した本文も横長だが、2ページ以上あるので表紙とは見分けられる。
 * 表1と表4を別のページにした表紙は縦長なので本文と見なされるが、その場合は利用者に直してもらう
 */
import type { PageFacts } from '../pdf/inspect.ts'
import type { RasterMeta } from '../raster/inspect.ts'

export type Part = 'body' | 'cover'

/** 1ページだけで、横長なら表紙 */
export function guessPart(pages: PageFacts[]): Part {
  if (pages.length !== 1) return 'body'
  const p = pages[0]
  const b = p.trimBox ?? p.cropBox
  const turned = p.rotate === 90 || p.rotate === 270
  const w = turned ? b.y1 - b.y0 : b.x1 - b.x0
  const h = turned ? b.x1 - b.x0 : b.y1 - b.y0
  return w > h ? 'cover' : 'body'
}

/**
 * 画像原稿をまとめて入れたとき、横長の画像が1枚だけなら表紙として分ける。
 * 横長の画像が2枚以上なら、見開きで書き出した本文かもしれないので分けない
 */
export function splitRasterParts<T extends { meta: RasterMeta }>(files: T[]): { part: Part; files: T[] }[] {
  const wide = files.filter((f) => f.meta.pxWidth > f.meta.pxHeight)
  const tall = files.filter((f) => f.meta.pxWidth <= f.meta.pxHeight)
  if (wide.length !== 1) return [{ part: 'body', files }]
  if (tall.length === 0) return [{ part: 'cover', files }]
  return [
    { part: 'body', files: tall },
    { part: 'cover', files: wide },
  ]
}
