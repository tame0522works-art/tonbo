/**
 * 入れられたファイルを読み、検査できる形にする。
 * PDF は1ファイルで1冊、PNG・JPEG はまとめてファイル名の順に1冊として扱う。
 * 読み込み中に別のファイルが入れられたら、呼び出し側が isStale で知らせ、ここでは途中でやめる。
 */
import type { TextItem } from './check/nombre.ts'
import { guessPart, splitRasterParts, type Part } from './check/part.ts'
import { extractTexts } from './check/text.ts'
import { PdfEncryptedError } from './pdf/document.ts'
import { inspectPdf, type DocumentFacts } from './pdf/inspect.ts'
import { openImagePreview, openPdfPreview, type Preview } from './preview.ts'
import { sortByName, type RasterFile } from './raster/facts.ts'
import { inspectRaster } from './raster/inspect.ts'

/** part は本文か表紙か。ページの形から見当を付け、利用者が結果の欄で直せる */
export type Loaded =
  | { kind: 'pdf'; fileName: string; part: Part; facts: DocumentFacts; preview: Preview; texts?: TextItem[][] }
  /** 画像原稿はまとめて1冊として扱う。大きさは判型や背幅の選び方で変わるので、検査のたびに求める */
  | { kind: 'images'; fileName: string; part: Part; files: RasterFile[]; preview: Preview }
  | { kind: 'error'; fileName: string; error: string }

export type InputFile = { name: string; type?: string; arrayBuffer: () => Promise<ArrayBuffer> }

const isPdf = (b: Uint8Array) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46
const isRaster = (b: Uint8Array) => (b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0xff && b[1] === 0xd8)

function errorMessage(e: unknown): string {
  if (e instanceof PdfEncryptedError) {
    return '保護（暗号化）のかかった PDF は、中身を読めないため確かめられません。書き出しの設定で、パスワードや印刷・編集の制限（セキュリティ）を外してから入れてください。'
  }
  return e instanceof Error ? e.message : String(e)
}

/**
 * ファイルを読む。途中で isStale が true を返したら null を返す（読みかけの資源は手放す）。
 * onProgress には画面に出す文言を渡す
 */
export async function loadFiles(files: InputFile[], onProgress: (text: string) => void, isStale: () => boolean): Promise<Loaded[] | null> {
  const results: Loaded[] = []
  const images: (RasterFile & { bytes: Uint8Array; type: string })[] = []
  for (const [i, f] of files.entries()) {
    const head = files.length > 1 ? `${f.name}（${i + 1} / ${files.length} ファイル目）` : f.name
    onProgress(`${head}: 読み込んでいます`)
    const bytes = new Uint8Array(await f.arrayBuffer())
    if (isStale()) return null
    if (isRaster(bytes)) {
      try {
        images.push({ name: f.name, meta: inspectRaster(bytes), bytes, type: f.type || '' })
      } catch (e) {
        results.push({ kind: 'error', fileName: f.name, error: errorMessage(e) })
      }
      continue
    }
    if (!isPdf(bytes)) {
      results.push({ kind: 'error', fileName: f.name, error: 'PDF・PNG・JPEG のどれでもありません' })
      continue
    }
    try {
      const facts = await inspectPdf(bytes, (done, total) => !isStale() && onProgress(`${head}: 構造を読んでいます（${done} / ${total} ページ）`))
      if (isStale()) return null
      const preview = openPdfPreview(bytes)
      // ノンブルの検査に使う文字。取り出せなければノンブルだけ検査しない
      const texts = await preview
        .pdf!.then((doc) => extractTexts(doc, (done, total) => !isStale() && onProgress(`${head}: ノンブルを探すため文字を取り出しています（${done} / ${total} ページ）`)))
        .catch(() => undefined)
      if (isStale()) {
        preview.close()
        return null
      }
      results.push({ kind: 'pdf', fileName: f.name, part: guessPart(facts.pages), facts, preview, texts })
    } catch (e) {
      if (isStale()) return null
      results.push({ kind: 'error', fileName: f.name, error: errorMessage(e) })
    }
  }
  // 横長の画像（表紙）と縦長の画像（本文）が混ざっていれば、別の冊として分ける
  const groups = images.length ? splitRasterParts(images) : []
  for (const { part, files: group } of groups.reverse()) {
    const sorted = sortByName(group)
    const name = sorted.length === 1 ? sorted[0].name : `${sorted[0].name} 〜 ${sorted[sorted.length - 1].name}（${sorted.length} 枚）`
    results.unshift({ kind: 'images', fileName: name, part, files: sorted.map(({ name: n, meta }) => ({ name: n, meta })), preview: openImagePreview(sorted) })
  }
  return results
}

/** 前に開いていたファイルの表示用の資源（worker 側の文書や画像）を手放す */
export function release(loaded: Loaded[]): void {
  for (const l of loaded) if (l.kind !== 'error') l.preview.close()
}
