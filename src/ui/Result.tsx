import { useMemo } from 'react'
import { checkDocument } from '../check/rules.ts'
import type { Loaded } from '../load.ts'
import { boxHeightMm, boxWidthMm, type PageFacts } from '../pdf/inspect.ts'
import { checkRasters } from '../raster/facts.ts'
import { printerOf, type Settings } from '../settings.ts'
import { FindingItem } from './FindingItem.tsx'

const mmText = (w: number, h: number) => `${w.toFixed(1)} × ${h.toFixed(1)} mm`

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

/** 1ファイル（画像原稿はまとめて1冊）の検査結果。設定が変わるたびに判定し直す */
export function Result({ l, settings }: { l: Loaded; settings: Settings }) {
  const printer = printerOf(settings)
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
