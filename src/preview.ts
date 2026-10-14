/**
 * ページの見た目を canvas に描く。PDF は pdf.js、画像原稿は画像をそのまま描く。
 * 検査は src/pdf/ と src/raster/ の自前の読み取りで行い、pdf.js は表示と文字の取り出しにだけ使う。
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

/** 描いた大きさ（CSS px）と、ページの座標（pt、左下が原点）を画面の座標に直す関数 */
export type Rendered = { w: number; h: number; toView: (x: number, y: number) => [number, number] }

export type Preview = {
  /** page は 1 から。pageBox は検査で決めたページの枠（画像原稿は解像度の決め方で大きさが変わるため、表示側では決めない） */
  render(page: number, canvas: HTMLCanvasElement, cssWidth: number, pageBox: { x1: number; y1: number }, signal: AbortSignal): Promise<Rendered>
  close(): void
  /** PDF のときだけ。ノンブルの検査のための文字の取り出しに使う */
  pdf?: Promise<PDFDocumentProxy>
}

export function openPdfPreview(bytes: Uint8Array): Preview {
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
  return {
    pdf: task.promise,
    close: () => void task.destroy(),
    async render(page, canvas, cssWidth, _pageBox, signal) {
      const p = await (await task.promise).getPage(page)
      const viewport = p.getViewport({ scale: cssWidth / p.getViewport({ scale: 1 }).width })
      const ratio = window.devicePixelRatio || 1
      canvas.width = Math.round(viewport.width * ratio)
      canvas.height = Math.round(viewport.height * ratio)
      const render = p.render({
        canvas,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        // 画面用ではなく印刷されるとおりに描く（印刷しない注釈やレイヤーは出さない）。
        // 印刷用の描画は requestAnimationFrame を待たないので、裏に回ったタブでも止まらない
        intent: 'print',
      })
      signal.addEventListener('abort', () => render.cancel())
      await render.promise
      // 回転と表示範囲も含めて、PDF の座標を画面の座標に直す
      return { w: viewport.width, h: viewport.height, toView: (x, y) => viewport.convertToViewportPoint(x, y) as [number, number] }
    },
  }
}

/** 画像原稿（ファイル名の順に並べたもの）。画像はページいっぱいに置かれているとみなす */
export function openImagePreview(files: { bytes: Uint8Array; type: string }[]): Preview {
  const bitmaps = new Map<number, Promise<ImageBitmap>>()
  return {
    close: () => {
      for (const b of bitmaps.values()) void b.then((x) => x.close(), () => {})
      bitmaps.clear()
    },
    async render(page, canvas, cssWidth, pageBox, signal) {
      let bm = bitmaps.get(page)
      if (!bm) {
        const f = files[page - 1]
        // Blob から直接作るので、img 要素も blob: の URL も使わない
        bm = createImageBitmap(new Blob([f.bytes as Uint8Array<ArrayBuffer>], { type: f.type }))
        bitmaps.set(page, bm)
      }
      const img = await bm
      if (signal.aborted) throw new DOMException('中断', 'AbortError')
      const scale = cssWidth / pageBox.x1
      const w = cssWidth
      const h = pageBox.y1 * scale
      const ratio = window.devicePixelRatio || 1
      canvas.width = Math.round(w * ratio)
      canvas.height = Math.round(h * ratio)
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
      return { w, h, toView: (x, y) => [x * scale, (pageBox.y1 - y) * scale] }
    },
  }
}
