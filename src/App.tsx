import { useMemo, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { PagePreview } from './PagePreview.tsx'
import { openForPreview, type Preview } from './preview.ts'
import { checkDocument, type CheckOptions, type Finding } from './check/rules.ts'
import { boxHeightMm, boxWidthMm, inspectPdf, type DocumentFacts, type PageFacts } from './pdf/inspect.ts'
import sampleDataUrl from './samples/sample-a5-ng.pdf?inline'
import { PRINTERS } from './specs/index.ts'

type Loaded = { fileName: string; facts: DocumentFacts; preview: Preview } | { fileName: string; error: string }
type Settings = Omit<CheckOptions, 'printer'> & { printerId: string }

const LEVEL_LABEL = { error: '要修正', warn: '注意', info: '参考' } as const

const mmText = (w: number, h: number) => `${w.toFixed(1)} × ${h.toFixed(1)} mm`

/** 1, 2, 3, 5 → 「1〜3, 5」 */
function pageRanges(pages: number[]): string {
  const s = [...pages].sort((a, b) => a - b)
  const out: string[] = []
  for (let i = 0; i < s.length; i++) {
    let j = i
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++
    out.push(j > i ? `${s[i]}〜${s[j]}` : `${s[i]}`)
    i = j
  }
  return out.join(', ')
}

/** 一度に開くページの数。多いと描画に時間がかかるので、残りは数だけ伝える */
const PREVIEW_PAGES = 4

function FindingItem({ f, pdf }: { f: Finding; pdf: Promise<PDFDocumentProxy> }) {
  const sources = [...new Map(f.sources.map((s) => [s.url, s])).values()]
  const [open, setOpen] = useState(false)
  // 赤枠のあるページを先に見せる
  const shown = useMemo(() => {
    const withRegions = [...new Set(f.regions.map((r) => r.page))]
    const rest = f.pages.filter((p) => !withRegions.includes(p))
    return [...withRegions, ...rest].slice(0, PREVIEW_PAGES).map((page) => ({ page, marks: f.regions.filter((r) => r.page === page) }))
  }, [f])
  return (
    <li className={`finding ${f.level}`}>
      <span className="level">{LEVEL_LABEL[f.level]}</span>
      <div>
        <strong>{f.title}</strong>
        {f.pages.length > 0 && <span className="pages">ページ {pageRanges(f.pages)}</span>}
        {f.detail && <p>{f.detail}</p>}
        {f.pages.length > 0 && (
          <button type="button" className="show-pages" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'ページを閉じる' : 'ページを見る'}
          </button>
        )}
        {open && (
          <div className="previews">
            {shown.map((s) => (
              <PagePreview key={s.page} pdf={pdf} page={s.page} marks={s.marks} level={f.level} />
            ))}
            {f.pages.length > PREVIEW_PAGES && <p className="meta">ほか {f.pages.length - PREVIEW_PAGES} ページ</p>}
          </div>
        )}
        {sources.length > 0 && (
          <p className="sources">
            出典:{' '}
            {sources.map((s, i) => (
              <a key={s.url} href={s.url} target="_blank" rel="noreferrer">
                {s.label}
                {sources.length > 1 ? ` (${i + 1})` : ''}
              </a>
            ))}
          </p>
        )}
      </div>
    </li>
  )
}

function PageRow({ p }: { p: PageFacts }) {
  const minDpi = p.images.filter((i) => i.color !== 'mask').reduce((m, i) => Math.min(m, i.dpiX, i.dpiY), Infinity)
  const notEmbedded = p.fonts.filter((f) => !f.embedded)
  return (
    <tr>
      <td>{p.number}</td>
      <td>{p.trimBox ? mmText(boxWidthMm(p.trimBox), boxHeightMm(p.trimBox)) : '—'}</td>
      <td>{mmText(boxWidthMm(p.cropBox), boxHeightMm(p.cropBox))}</td>
      <td>{Number.isFinite(minDpi) ? `${Math.round(minDpi)} dpi` : '—'}</td>
      <td>{[...new Set(p.images.map((i) => i.color))].join('・') || '—'}</td>
      <td>{p.rgbPaintOps > 0 ? `RGB ${p.rgbPaintOps}` : '—'}</td>
      <td>{notEmbedded.length ? notEmbedded.map((f) => f.name).join('、') : p.fonts.length ? 'すべて埋め込み' : '—'}</td>
    </tr>
  )
}

function Result({ l, settings }: { l: Loaded; settings: Settings }) {
  const printer = PRINTERS.find((p) => p.id === settings.printerId)!
  const findings = useMemo(() => ('facts' in l ? checkDocument(l.facts, { ...settings, printer }) : []), [l, settings, printer])
  if ('error' in l) {
    return (
      <section>
        <h2>{l.fileName}</h2>
        <p className="error">読み取れませんでした: {l.error}</p>
      </section>
    )
  }
  const counts = { error: 0, warn: 0, info: 0 }
  for (const f of findings) counts[f.level]++
  return (
    <section>
      <h2>{l.fileName}</h2>
      <p className="meta">
        PDF {l.facts.version}・{l.facts.pages.length} ページ{l.facts.pdfx && `・${l.facts.pdfx}`}
      </p>
      <p className={`summary ${counts.error ? 'error' : counts.warn ? 'warn' : 'ok'}`}>
        {counts.error + counts.warn === 0 ? `${printer.name}の仕様で見つかった問題はありません` : `要修正 ${counts.error} 件・注意 ${counts.warn} 件`}
        {counts.info > 0 && `（参考 ${counts.info} 件）`}
      </p>
      <ul className="findings">
        {findings.map((f) => (
          <FindingItem key={f.code} f={f} pdf={l.preview.pdf} />
        ))}
      </ul>
      <details>
        <summary>ページごとの読み取り結果</summary>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>ページ</th>
                <th>仕上がり（TrimBox）</th>
                <th>用紙</th>
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
        </div>
      </details>
    </section>
  )
}

export default function App() {
  const [loaded, setLoaded] = useState<Loaded[]>([])
  const [dragging, setDragging] = useState(false)
  const [settings, setSettings] = useState<Settings>({ printerId: PRINTERS[0].id, formatId: 'A5', part: 'body', ink: 'mono', binding: 'perfect' })
  const printer = PRINTERS.find((p) => p.id === settings.printerId)!

  function choosePrinter(id: string) {
    const next = PRINTERS.find((p) => p.id === id)!
    // 選んでいた判型がその印刷所にもあれば引き継ぐ
    const formatId = next.formats.some((f) => f.id === settings.formatId) ? settings.formatId : next.formats[0].id
    setSettings({ ...settings, printerId: id, formatId })
  }

  async function open(files: FileList | { name: string; arrayBuffer: () => Promise<ArrayBuffer> }[] | null) {
    if (!files) return
    // 前に開いていたファイルの表示用の資源（worker 側の文書）を手放す
    for (const l of loaded) if ('preview' in l) l.preview.close()
    const results: Loaded[] = []
    for (const f of Array.from(files)) {
      try {
        const bytes = new Uint8Array(await f.arrayBuffer())
        const facts = await inspectPdf(bytes)
        results.push({ fileName: f.name, facts, preview: openForPreview(bytes) })
      } catch (e) {
        results.push({ fileName: f.name, error: e instanceof Error ? e.message : String(e) })
      }
    }
    setLoaded(results)
  }

  function openSample() {
    // 見本は A5 の本文として作ってある
    if (printer.formats.some((f) => f.id === 'A5')) setSettings({ ...settings, formatId: 'A5', part: 'body' })
    const bytes = Uint8Array.from(atob(sampleDataUrl.split(',')[1]), (c) => c.charCodeAt(0))
    void open([{ name: '見本（A5 本文・わざと不備あり）.pdf', arrayBuffer: async () => bytes.buffer }])
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

      <fieldset className="settings">
        <label>
          印刷所
          <select value={settings.printerId} onChange={(e) => choosePrinter(e.target.value)}>
            {PRINTERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          判型
          <select value={settings.formatId} onChange={(e) => setSettings({ ...settings, formatId: e.target.value })}>
            {printer.formats.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}（{f.w}×{f.h}mm）
              </option>
            ))}
          </select>
        </label>
        <label>
          ファイル
          <select value={settings.part} onChange={(e) => setSettings({ ...settings, part: e.target.value as Settings['part'] })}>
            <option value="body">本文</option>
            <option value="cover">表紙</option>
          </select>
        </label>
        {settings.part === 'body' && (
          <>
            <label>
              刷り色
              <select value={settings.ink} onChange={(e) => setSettings({ ...settings, ink: e.target.value as Settings['ink'] })}>
                <option value="mono">モノクロ</option>
                <option value="color">カラー</option>
              </select>
            </label>
            <label>
              とじ方
              <select value={settings.binding} onChange={(e) => setSettings({ ...settings, binding: e.target.value as Settings['binding'] })}>
                <option value="perfect">無線とじ（平とじ）</option>
                <option value="saddle">中とじ</option>
              </select>
            </label>
          </>
        )}
      </fieldset>
      {printer.formats.find((f) => f.id === settings.formatId)?.note && (
        <p className="meta">※ {printer.formats.find((f) => f.id === settings.formatId)!.note}</p>
      )}

      <label className="drop">
        PDF をここにドロップ、または選ぶ
        <input type="file" accept="application/pdf" multiple onChange={(e) => void open(e.target.files)} />
      </label>
      <p className="sample">
        手元に PDF がなければ{' '}
        <button type="button" onClick={openSample}>
          見本で試す
        </button>
      </p>

      {loaded.map((l) => (
        <Result key={l.fileName} l={l} settings={settings} />
      ))}

      <footer>
        <p>
          各印刷所の公式サイトに書かれた仕様（{PRINTERS[0].checkedAt} 時点）を元にした非公式のチェックです。入稿の前に、必ず印刷所の最新の案内も確かめてください。
        </p>
        <p>版 {__APP_VERSION__}</p>
      </footer>
    </main>
  )
}
