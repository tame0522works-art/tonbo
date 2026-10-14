import { useMemo, useRef, useState } from 'react'
import { PagePreview } from './PagePreview.tsx'
import { openImagePreview, openPdfPreview, type Preview } from './preview.ts'
import type { TextItem } from './check/nombre.ts'
import { checkDocument, computeSpine, type CheckOptions, type Finding } from './check/rules.ts'
import { extractTexts } from './check/text.ts'
import { PdfEncryptedError } from './pdf/document.ts'
import { boxHeightMm, boxWidthMm, inspectPdf, type DocumentFacts, type PageFacts } from './pdf/inspect.ts'
import { checkRasters, sortByName, type RasterFile } from './raster/facts.ts'
import { inspectRaster } from './raster/inspect.ts'
import sampleCover from './samples/sample-a5-cover-ng.pdf?inline'
import sampleBody from './samples/sample-a5-ng.pdf?inline'
import { PRINTERS } from './specs/index.ts'

type Loaded =
  | { kind: 'pdf'; fileName: string; facts: DocumentFacts; preview: Preview; texts?: TextItem[][] }
  /** 画像原稿はまとめて1冊として扱う。大きさは判型や背幅の選び方で変わるので、検査のたびに求める */
  | { kind: 'images'; fileName: string; files: RasterFile[]; preview: Preview }
  | { kind: 'error'; fileName: string; error: string }

type InputFile = { name: string; type?: string; arrayBuffer: () => Promise<ArrayBuffer> }

const isPdf = (b: Uint8Array) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46
const isRaster = (b: Uint8Array) => (b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0xff && b[1] === 0xd8)
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

function FindingItem({ f, preview, pages }: { f: Finding; preview: Preview; pages: PageFacts[] }) {
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
              <PagePreview key={s.page} preview={preview} page={s.page} pageBox={pages[s.page - 1].cropBox} marks={s.marks} level={f.level} />
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

function PageRow({ p, name }: { p: PageFacts; name?: string }) {
  const minDpi = p.images.filter((i) => i.color !== 'mask').reduce((m, i) => Math.min(m, i.dpiX, i.dpiY), Infinity)
  const notEmbedded = p.fonts.filter((f) => !f.embedded)
  return (
    <tr>
      <td>
        {p.number}
        {name && <span className="file-name">{name}</span>}
      </td>
      <td>{p.trimBox ? mmText(boxWidthMm(p.trimBox), boxHeightMm(p.trimBox)) : '—'}</td>
      <td>{p.sizeUnknown ? '不明' : mmText(boxWidthMm(p.cropBox), boxHeightMm(p.cropBox))}</td>
      <td>{Number.isFinite(minDpi) ? `${Math.round(minDpi)} dpi` : '—'}</td>
      <td>{[...new Set(p.images.map((i) => i.color))].join('・') || '—'}</td>
      <td>{p.rgbPaintOps > 0 ? `RGB ${p.rgbPaintOps}` : '—'}</td>
      <td>{notEmbedded.length ? notEmbedded.map((f) => f.name).join('、') : p.fonts.length ? 'すべて埋め込み' : '—'}</td>
    </tr>
  )
}

function Result({ l, settings }: { l: Loaded; settings: Settings }) {
  const printer = PRINTERS.find((p) => p.id === settings.printerId)!
  const checked = useMemo(() => {
    const opts = { ...settings, printer }
    if (l.kind === 'pdf') return { facts: l.facts, findings: checkDocument(l.facts, opts, l.texts) }
    if (l.kind === 'images') return checkRasters(l.files, opts)
    return undefined
  }, [l, settings, printer])
  if (l.kind === 'error' || !checked) {
    return (
      <section>
        <h2>{l.fileName}</h2>
        <p className="error">読み取れませんでした: {l.kind === 'error' ? l.error : ''}</p>
      </section>
    )
  }
  const { facts, findings } = checked
  const counts = { error: 0, warn: 0, info: 0 }
  for (const f of findings) counts[f.level]++
  return (
    <section>
      <h2>{l.fileName}</h2>
      <p className="meta">
        {l.kind === 'pdf'
          ? `PDF ${facts.version}・${facts.pages.length} ページ${facts.pdfx ? `・${facts.pdfx}` : ''}`
          : `画像 ${l.files.length} 枚を、ファイル名の順に 1〜${l.files.length} ページとして確かめています`}
      </p>
      <p className={`summary ${counts.error ? 'error' : counts.warn ? 'warn' : 'ok'}`}>
        {counts.error + counts.warn === 0 ? `${printer.name}の仕様で見つかった問題はありません` : `要修正 ${counts.error} 件・注意 ${counts.warn} 件`}
        {counts.info > 0 && `（参考 ${counts.info} 件）`}
      </p>
      <ul className="findings">
        {findings.map((f) => (
          <FindingItem key={f.code} f={f} preview={l.preview} pages={facts.pages} />
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
              {facts.pages.map((p) => (
                <PageRow key={p.number} p={p} name={l.kind === 'images' ? l.files[p.number - 1].name : undefined} />
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
  /** 読み込み中の進み具合（読み込んでいないときは null） */
  const [progress, setProgress] = useState<string | null>(null)
  /** 読み込み中に別のファイルが入れられたら、前の読み込みの結果は捨てる。何回目の読み込みかを数えて見分ける */
  const openCount = useRef(0)
  const [settings, setSettings] = useState<Settings>({
    printerId: PRINTERS[0].id,
    formatId: 'A5',
    part: 'body',
    ink: 'mono',
    binding: 'perfect',
    paperId: PRINTERS[0].spine.value.papers[0]?.id,
  })
  const printer = PRINTERS.find((p) => p.id === settings.printerId)!
  const spineCalc = computeSpine(printer, settings.paperId, settings.bodyPages)

  function choosePrinter(id: string) {
    const next = PRINTERS.find((p) => p.id === id)!
    // 選んでいた判型がその印刷所にもあれば引き継ぐ
    const formatId = next.formats.some((f) => f.id === settings.formatId) ? settings.formatId : next.formats[0].id
    // 用紙は印刷所ごとに違うので、同じ id があるときだけ引き継ぐ。手入力の背幅は印刷所が変われば意味が変わるので消す
    const paperId = next.spine.value.papers.some((x) => x.id === settings.paperId) ? settings.paperId : next.spine.value.papers[0]?.id
    setSettings({ ...settings, printerId: id, formatId, paperId, spineMm: undefined })
  }

  async function open(files: FileList | InputFile[] | null) {
    if (!files) return
    const list = Array.from(files)
    if (list.length === 0) return
    const me = ++openCount.current
    const stale = () => me !== openCount.current
    // 前に開いていたファイルの表示用の資源（worker 側の文書や画像）を手放し、結果も消す（読み込み中に古い結果を見せない）
    for (const l of loaded) if (l.kind !== 'error') l.preview.close()
    setLoaded([])
    const results: Loaded[] = []
    const images: (RasterFile & { bytes: Uint8Array; type: string })[] = []
    const message = (e: unknown) =>
      e instanceof PdfEncryptedError
        ? '保護（暗号化）のかかった PDF は、中身を読めないため確かめられません。書き出しの設定で、パスワードや印刷・編集の制限（セキュリティ）を外してから入れてください。'
        : e instanceof Error
          ? e.message
          : String(e)
    for (const [i, f] of list.entries()) {
      const head = list.length > 1 ? `${f.name}（${i + 1} / ${list.length} ファイル目）` : f.name
      setProgress(`${head}: 読み込んでいます`)
      const bytes = new Uint8Array(await f.arrayBuffer())
      if (stale()) return
      if (isRaster(bytes)) {
        try {
          images.push({ name: f.name, meta: inspectRaster(bytes), bytes, type: f.type || '' })
        } catch (e) {
          results.push({ kind: 'error', fileName: f.name, error: message(e) })
        }
        continue
      }
      if (!isPdf(bytes)) {
        results.push({ kind: 'error', fileName: f.name, error: 'PDF・PNG・JPEG のどれでもありません' })
        continue
      }
      try {
        const facts = await inspectPdf(bytes, (done, total) => !stale() && setProgress(`${head}: 構造を読んでいます（${done} / ${total} ページ）`))
        if (stale()) return
        const preview = openPdfPreview(bytes)
        // ノンブルの検査に使う文字。取り出せなければノンブルだけ検査しない
        const texts = await preview
          .pdf!.then((doc) => extractTexts(doc, (done, total) => !stale() && setProgress(`${head}: ノンブルを探すため文字を取り出しています（${done} / ${total} ページ）`)))
          .catch(() => undefined)
        if (stale()) {
          preview.close()
          return
        }
        results.push({ kind: 'pdf', fileName: f.name, facts, preview, texts })
      } catch (e) {
        if (stale()) return
        results.push({ kind: 'error', fileName: f.name, error: message(e) })
      }
    }
    if (images.length) {
      const sorted = sortByName(images)
      const name = sorted.length === 1 ? sorted[0].name : `${sorted[0].name} 〜 ${sorted[sorted.length - 1].name}（${sorted.length} 枚）`
      results.unshift({ kind: 'images', fileName: name, files: sorted.map(({ name: n, meta }) => ({ name: n, meta })), preview: openImagePreview(sorted) })
    }
    setLoaded(results)
    setProgress(null)
  }

  function openSample(part: 'body' | 'cover') {
    // 見本は A5 で作ってある。表紙は「本文 100 ページ・上質90kg」の本の表紙を、背幅 4mm で作ってしまった想定
    const next: Settings = { ...settings, part, formatId: printer.formats.some((f) => f.id === 'A5') ? 'A5' : settings.formatId }
    if (part === 'cover') {
      next.bodyPages = 100
      next.paperId = printer.spine.value.papers.find((x) => x.id === 'jouhou90')?.id ?? settings.paperId
      next.spineMm = undefined
    }
    setSettings(next)
    const dataUrl = part === 'cover' ? sampleCover : sampleBody
    const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), (c) => c.charCodeAt(0))
    const name = part === 'cover' ? '見本（A5 表紙・背幅違い）.pdf' : '見本（A5 本文・わざと不備あり）.pdf'
    void open([{ name, arrayBuffer: async () => bytes.buffer as ArrayBuffer }])
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
        {settings.part === 'cover' && (
          <>
            {printer.spine.value.papers.length > 0 && (
              <label>
                本文の用紙
                <select value={settings.paperId} onChange={(e) => setSettings({ ...settings, paperId: e.target.value })}>
                  {printer.spine.value.papers.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              本文のページ数
              <input
                type="number"
                min={1}
                inputMode="numeric"
                value={settings.bodyPages ?? ''}
                onChange={(e) => setSettings({ ...settings, bodyPages: e.target.value ? Number(e.target.value) : undefined })}
              />
            </label>
            <label>
              背幅（mm、手入力）
              <input
                type="number"
                min={0}
                step={0.1}
                inputMode="decimal"
                placeholder={spineCalc !== undefined ? spineCalc.toFixed(1) : ''}
                value={settings.spineMm ?? ''}
                onChange={(e) => setSettings({ ...settings, spineMm: e.target.value ? Number(e.target.value) : undefined })}
              />
            </label>
          </>
        )}
      </fieldset>
      {settings.part === 'cover' && (
        <p className="meta">
          {settings.spineMm !== undefined
            ? `入力した背幅 ${settings.spineMm}mm で確かめます。`
            : spineCalc !== undefined
              ? `計算した背幅は ${spineCalc.toFixed(2)}mm です。式: ${printer.spine.note}。`
              : printer.spine.value.method === 'table'
                ? `${printer.name}は背幅を早見表で決めます。`
                : '本文のページ数を入れると、背幅を計算して表紙の大きさを確かめます。'}
          {printer.spine.value.tableUrl && (
            <>
              {' '}
              <a href={printer.spine.value.tableUrl} target="_blank" rel="noreferrer">
                早見表を開く
              </a>
              。
            </>
          )}
          表紙は、表4・背・表1 を横に並べた1枚の PDF を想定しています（カバーは対象外）。
        </p>
      )}
      {printer.formats.find((f) => f.id === settings.formatId)?.note && (
        <p className="meta">※ {printer.formats.find((f) => f.id === settings.formatId)!.note}</p>
      )}

      <label className="drop">
        PDF、または PNG・JPEG の画像をここにドロップ、または選ぶ
        <span className="drop-note">画像はまとめて入れると、ファイル名の順に1冊として確かめます</span>
        <input type="file" accept="application/pdf,image/png,image/jpeg" multiple onChange={(e) => void open(e.target.files)} />
      </label>
      <p className="sample">
        手元に PDF がなければ{' '}
        <button type="button" onClick={() => openSample('body')}>
          本文の見本で試す
        </button>{' '}
        <button type="button" onClick={() => openSample('cover')}>
          表紙の見本で試す
        </button>
      </p>

      {progress && (
        <p className="progress" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          {progress}
        </p>
      )}
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
