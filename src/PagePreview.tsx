import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { Box } from './pdf/inspect.ts'

export type Mark = { box: Box; label?: string }

type Props = {
  pdf: Promise<PDFDocumentProxy>
  page: number
  marks: Mark[]
  level: 'error' | 'warn' | 'info'
  /** 表示の幅（CSS px） */
  width?: number
}

type Drawn = { w: number; h: number; rects: { x: number; y: number; w: number; h: number; label?: string }[] }

export function PagePreview({ pdf, page, marks, level, width = 260 }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [drawn, setDrawn] = useState<Drawn>()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    let task: { cancel: () => void } | undefined
    ;(async () => {
      try {
        const doc = await pdf
        const p = await doc.getPage(page)
        const base = p.getViewport({ scale: 1 })
        const viewport = p.getViewport({ scale: width / base.width })
        const ratio = window.devicePixelRatio || 1
        const c = canvas.current
        if (!c || cancelled) return
        c.width = Math.round(viewport.width * ratio)
        c.height = Math.round(viewport.height * ratio)
        const render = p.render({
          canvas: c,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
          // 画面用ではなく印刷されるとおりに描く（印刷しない注釈やレイヤーは出さない）。
          // 印刷用の描画は requestAnimationFrame を待たないので、裏に回ったタブでも止まらない
          intent: 'print',
        })
        task = render
        await render.promise
        if (cancelled) return
        // PDF の座標（左下が原点）を、回転と表示範囲も含めて画面の座標に直す
        const rects = marks.map((m) => {
          const [x0, y0] = viewport.convertToViewportPoint(m.box.x0, m.box.y0) as [number, number]
          const [x1, y1] = viewport.convertToViewportPoint(m.box.x1, m.box.y1) as [number, number]
          return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0), label: m.label }
        })
        setDrawn({ w: viewport.width, h: viewport.height, rects })
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [pdf, page, marks, width])

  return (
    <figure className={`preview ${level}`} style={{ width }}>
      <div className="sheet" style={drawn ? { height: drawn.h } : { aspectRatio: '148 / 210' }}>
        <canvas ref={canvas} style={drawn ? { width: drawn.w, height: drawn.h } : undefined} />
        {drawn && (
          <svg viewBox={`0 0 ${drawn.w} ${drawn.h}`} width={drawn.w} height={drawn.h} aria-hidden="true">
            {drawn.rects.map((r, i) => (
              <g key={i}>
                {/* 用紙いっぱいの枠は線が見えなくなるので、内側に少し寄せて描く */}
                <rect x={Math.max(r.x, 1.5)} y={Math.max(r.y, 1.5)} width={Math.max(Math.min(r.w, drawn.w - 3), 4)} height={Math.max(Math.min(r.h, drawn.h - 3), 4)} />
                {r.label && (
                  // 枠の左上に、塗りつぶした札として添える（画像の上に直接文字を置くと読めないため）
                  <g className="tag" transform={`translate(${Math.max(r.x, 1.5)} ${Math.max(r.y, 1.5)})`}>
                    <rect width={[...r.label].reduce((w, ch) => w + (ch.charCodeAt(0) > 0xff ? 11 : 7), 10)} height={18} />
                    <text x={5} y={13}>
                      {r.label}
                    </text>
                  </g>
                )}
              </g>
            ))}
          </svg>
        )}
        {failed && <p className="preview-failed">このページは表示できませんでした</p>}
      </div>
      <figcaption>{page} ページ</figcaption>
    </figure>
  )
}
