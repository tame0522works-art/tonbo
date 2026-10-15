import { useMemo, useState } from 'react'
import type { Finding } from '../check/rules.ts'
import type { PageFacts } from '../pdf/inspect.ts'
import type { Preview } from '../preview.ts'
import { pageRanges } from './format.ts'
import { PagePreview } from './PagePreview.tsx'

const LEVEL_LABEL = { error: '要修正', warn: '注意', info: '参考' } as const

/** 一度に開くページの数。多いと描画に時間がかかるので、残りは数だけ伝える */
const PREVIEW_PAGES = 4

/** 指摘1件。「ページを見る」で該当ページを描き、赤枠を重ねる */
export function FindingItem({ f, preview, pages }: { f: Finding; preview: Preview; pages: PageFacts[] }) {
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
