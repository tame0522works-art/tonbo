import { useState } from 'react'
import { boxHeightMm, boxWidthMm, inspectPdf, type DocumentFacts, type PageFacts } from './pdf/inspect.ts'

type Loaded = { fileName: string; facts: DocumentFacts } | { fileName: string; error: string }

const mmText = (w: number, h: number) => `${w.toFixed(1)} × ${h.toFixed(1)} mm`

function PageRow({ p }: { p: PageFacts }) {
  const minDpi = p.images.filter((i) => i.color !== 'mask').reduce((m, i) => Math.min(m, i.dpiX, i.dpiY), Infinity)
  const notEmbedded = p.fonts.filter((f) => !f.embedded)
  return (
    <tr>
      <td>{p.number}</td>
      <td>{p.trimBox ? mmText(boxWidthMm(p.trimBox), boxHeightMm(p.trimBox)) : '—'}</td>
      <td>{mmText(boxWidthMm(p.mediaBox), boxHeightMm(p.mediaBox))}</td>
      <td>{Number.isFinite(minDpi) ? `${Math.round(minDpi)} dpi` : '—'}</td>
      <td>{[...new Set(p.images.map((i) => i.color))].join('・') || '—'}</td>
      <td>{p.rgbPaintOps > 0 ? `RGB ${p.rgbPaintOps}` : '—'}</td>
      <td>{notEmbedded.length ? notEmbedded.map((f) => f.name).join('、') : p.fonts.length ? 'すべて埋め込み' : '—'}</td>
    </tr>
  )
}

export default function App() {
  const [loaded, setLoaded] = useState<Loaded[]>([])
  const [dragging, setDragging] = useState(false)

  async function open(files: FileList | null) {
    if (!files) return
    const results: Loaded[] = []
    for (const f of Array.from(files)) {
      try {
        results.push({ fileName: f.name, facts: await inspectPdf(new Uint8Array(await f.arrayBuffer())) })
      } catch (e) {
        results.push({ fileName: f.name, error: e instanceof Error ? e.message : String(e) })
      }
    }
    setLoaded(results)
  }

  return (
    <main
      className={dragging ? 'dragging' : undefined}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void open(e.dataTransfer.files)
      }}
    >
      <header>
        <h1>tonbo</h1>
        <p>同人誌の入稿データを、印刷所の仕様に照らして確かめます。ファイルはこの端末の外に送りません。</p>
      </header>
      <label className="drop">
        PDF をここにドロップ、または選ぶ
        <input type="file" accept="application/pdf" multiple onChange={(e) => void open(e.target.files)} />
      </label>
      {loaded.map((l) => (
        <section key={l.fileName}>
          <h2>{l.fileName}</h2>
          {'error' in l ? (
            <p className="error">読み取れませんでした: {l.error}</p>
          ) : (
            <>
              <p className="meta">
                PDF {l.facts.version}・{l.facts.pages.length} ページ{l.facts.pdfx && `・${l.facts.pdfx}`}
                {l.facts.repaired && '・相互参照表が壊れていたため、全体を読み直しました'}
              </p>
              <table>
                <thead>
                  <tr>
                    <th>ページ</th>
                    <th>仕上がり（TrimBox）</th>
                    <th>用紙（MediaBox）</th>
                    <th>最低解像度</th>
                    <th>画像の色</th>
                    <th>図形・文字の色</th>
                    <th>未埋め込みフォント</th>
                  </tr>
                </thead>
                <tbody>
                  {l.facts.pages.map((p) => (
                    <PageRow key={p.number} p={p} />
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      ))}
      <footer>版 {__APP_VERSION__}</footer>
    </main>
  )
}
