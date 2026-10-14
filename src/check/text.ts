// pdf.js でページごとの文字を取り出し、ノンブルの検査に渡す形（PDF の座標、pt）にする
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { Progress, type OnProgress } from '../progress.ts'
import type { TextItem } from './nombre.ts'

export async function extractTexts(doc: PDFDocumentProxy, onProgress?: OnProgress): Promise<TextItem[][]> {
  const out: TextItem[][] = []
  const progress = new Progress(doc.numPages, onProgress)
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const content = await page.getTextContent()
    const items: TextItem[] = []
    for (const it of content.items) {
      if (!('str' in it) || !it.str.trim()) continue
      // transform は文字の座標変換。e, f が文字の並びの左下で、高さは縦方向の拡大率から求める
      const [a, b, c, d, e, f] = it.transform as number[]
      const size = Math.hypot(c, d) || Math.hypot(a, b)
      items.push({ str: it.str, x: e, y: f, w: it.width, h: it.height || size })
    }
    out.push(items)
    page.cleanup()
    await progress.step(n)
  }
  return out
}
