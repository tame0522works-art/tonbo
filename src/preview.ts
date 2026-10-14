/**
 * ページの見た目の表示だけに pdf.js を使う（検査は src/pdf/ の自前の読み取りで行う）。
 * 公開版は CSP で通信（connect-src）をすべて禁止しているので、pdf.js が fetch で読みに行く
 * CMap（埋め込みのない日本語フォントの文字の対応表）は、ビルド時に1つずつ JS のモジュールにし、使う分だけ動的 import で読む。
 * 動的 import は script-src 'self' の範囲なので、CSP を緩めずに済む。
 */
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

// 中身は vite.config.ts の bcmapAsModule が base64 の文字列にする
const cmaps = import.meta.glob<string>('/node_modules/pdfjs-dist/cmaps/*.bcmap', { import: 'default' })

/** pdf.js の BinaryDataFactory と同じ形。CMap だけを埋め込み分から返し、それ以外（標準フォント・wasm）は使わない */
class BundledDataFactory {
  constructor(_opts: unknown) {}
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const load = kind === 'cMapUrl' ? cmaps[`/node_modules/pdfjs-dist/cmaps/${filename}`] : undefined
    if (!load) throw new Error(`同梱していないデータ: ${kind} ${filename}`)
    return Uint8Array.from(atob(await load()), (c) => c.charCodeAt(0))
  }
}

export type Preview = { pdf: Promise<PDFDocumentProxy>; close: () => void }

export function openForPreview(bytes: Uint8Array): Preview {
  const task = getDocument({
    // pdf.js は渡したバッファを worker に移して使えなくするので、検査に使う元のバイト列とは別に写しを渡す
    data: bytes.slice(),
    // 値は使わないが、空だと CMap を読みに行かないので目印を入れておく（末尾の / は pdf.js が求める）
    cMapUrl: 'bundled:/',
    cMapPacked: true,
    BinaryDataFactory: BundledDataFactory,
    useWorkerFetch: false,
    // wasm のコンパイルは CSP の 'wasm-unsafe-eval' が要るので使わない（JPEG 2000 などは JS の実装で読む）
    useWasm: false,
  })
  // 表示用に開けなくても検査結果は出す（失敗はページの表示のところで伝える）
  task.promise.catch(() => {})
  return { pdf: task.promise, close: () => void task.destroy() }
}
