/**
 * 画像原稿（PNG / JPEG）を、PDF と同じ「ページの事実」にして同じ判定にかける。
 * 画像1枚を1ページとし、画像がページいっぱいに置かれているとみなす。
 *
 * 大きさの決め方:
 * 1. 画像に書かれた解像度で求めた大きさが、仕上がりか塗り足し込みの大きさに合えば、それを使う
 * 2. 合わなければ、縦横比が合う大きさを探し、その大きさで刷るとみなして解像度を逆算する
 *    （書き出しソフトによっては、350dpi で作っても解像度の情報が 72dpi になるため）
 * 3. どちらでもなければ大きさはわからないとし、縦横比が合わないことを伝える
 */
import { checkDocument, computeSpine, sortFindings, type CheckOptions, type Finding } from '../check/rules.ts'
import { type ColorFamily, type DocumentFacts, type PageFacts } from '../pdf/inspect.ts'
import type { RasterMeta } from './inspect.ts'

export type RasterFile = { name: string; meta: RasterMeta }

/** 寸法の比較で許す差（mm）と、縦横比の比較で許す差（割合） */
const SIZE_TOLERANCE_MM = 0.5
const ASPECT_TOLERANCE = 0.005

const FORMAT_LABEL = { png: 'PNG', jpeg: 'JPEG' } as const

/** ファイル名の順（数字は数として比べる: 2.png は 10.png より前） */
export function sortByName<T extends { name: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }))
}

export function rasterFacts(files: RasterFile[], opts: CheckOptions): { facts: DocumentFacts; findings: Finding[] } {
  const { printer } = opts
  const format = printer.formats.find((f) => f.id === opts.formatId)!
  const bleed = printer.bleedMm.value
  // 刷り上がりの候補（幅, 高さ, 名前）。表紙は背幅がわかるときだけ候補を作れる
  const targets: { w: number; h: number; label: string }[] = []
  if (opts.part === 'body') {
    targets.push({ w: format.w + bleed * 2, h: format.h + bleed * 2, label: `塗り足し込みの${format.label}` }, { w: format.w, h: format.h, label: `${format.label}の仕上がり` })
  } else {
    const spine = opts.spineMm ?? computeSpine(printer, opts.paperId, opts.bodyPages)
    if (spine !== undefined) {
      const w = format.w * 2 + spine
      targets.push({ w: w + bleed * 2, h: format.h + bleed * 2, label: `塗り足し込みの${format.label}の表紙` }, { w, h: format.h, label: `${format.label}の表紙の仕上がり` })
    }
  }

  const findings = new Map<string, Finding>()
  const add = (f: Omit<Finding, 'pages' | 'regions'>, page?: number) => {
    let found = findings.get(f.code)
    if (!found) {
      found = { ...f, pages: [], regions: [] }
      findings.set(f.code, found)
    }
    if (page !== undefined) found.pages.push(page)
  }

  const pages: PageFacts[] = files.map(({ meta }, i) => {
    const number = i + 1
    const sizeFrom = (dpiX: number, dpiY: number) => ({ w: (meta.pxWidth / dpiX) * 25.4, h: (meta.pxHeight / dpiY) * 25.4 })
    let dpiX: number | undefined
    let dpiY: number | undefined
    if (meta.dpi) {
      const s = sizeFrom(meta.dpi.x, meta.dpi.y)
      if (targets.length === 0 || targets.some((t) => Math.abs(t.w - s.w) <= SIZE_TOLERANCE_MM && Math.abs(t.h - s.h) <= SIZE_TOLERANCE_MM)) {
        dpiX = meta.dpi.x
        dpiY = meta.dpi.y
      }
    }
    if (dpiX === undefined) {
      const aspect = meta.pxWidth / meta.pxHeight
      const t = targets.find((x) => Math.abs(x.w / x.h / aspect - 1) <= ASPECT_TOLERANCE)
      if (t) {
        dpiX = meta.pxWidth / (t.w / 25.4)
        dpiY = meta.pxHeight / (t.h / 25.4)
        add(
          {
            level: 'info',
            code: 'raster-dpi-inferred',
            title: '画像の解像度の情報を使わず、大きさから解像度を求めました',
            detail: meta.dpi
              ? `画像に書かれた解像度（${Math.round(meta.dpi.x)}dpi）では大きさが判型に合わないため、縦横比の合う「${t.label}」の大きさで刷るとみなし、その大きさでの解像度（約 ${Math.round(Math.min(dpiX, dpiY))}dpi）で確かめています。書き出しソフトによっては、解像度の情報が 72dpi のまま書かれることがあります。`
              : `画像に解像度の情報がないため、縦横比の合う「${t.label}」の大きさで刷るとみなし、その大きさでの解像度（約 ${Math.round(Math.min(dpiX, dpiY))}dpi）で確かめています。`,
            sources: [],
          },
          number,
        )
      }
    }
    const sizeUnknown = dpiX === undefined || dpiY === undefined
    if (sizeUnknown) {
      add(
        {
          level: 'error',
          code: 'raster-size',
          title: '画像の大きさが判型に合いません',
          detail:
            `画像は ${meta.pxWidth}×${meta.pxHeight} 画素で、` +
            (meta.dpi ? `書かれた解像度（${Math.round(meta.dpi.x)}dpi）では ${mmText(sizeFrom(meta.dpi.x, meta.dpi.y))} です。` : '解像度の情報がありません。') +
            (targets.length
              ? `縦横比も ${targets.map((t) => `${t.label}（${round1(t.w)}×${round1(t.h)}mm）`).join('・')} と合いません。`
              : '背幅がわからないため、表紙として合う大きさを決められません。本文の用紙とページ数を選ぶか、背幅を入れてください。'),
          sources: targets.length ? format.src.map((k) => ({ label: printer.name, url: printer.sources[k] })) : [],
        },
        number,
      )
    }
    // 大きさがわからないときは解像度も決まらないので、解像度の検査にかからない値にしておく
    const dx = dpiX ?? Infinity
    const dy = dpiY ?? Infinity
    // 大きさがわからないページの枠は、表示で画像がゆがまないよう、画像の縦横比のまま仮に 72dpi として置く
    const wPt = sizeUnknown ? meta.pxWidth : (meta.pxWidth / dx) * 72
    const hPt = sizeUnknown ? meta.pxHeight : (meta.pxHeight / dy) * 72
    const box = { x0: 0, y0: 0, x1: wPt, y1: hPt }
    const color: ColorFamily = meta.color === 'mono' ? 'gray' : meta.color === 'indexed' ? 'rgb' : meta.color
    return {
      number,
      mediaBox: box,
      cropBox: box,
      rotate: 0,
      fonts: [],
      images: [
        {
          label: files[i].name,
          pxWidth: meta.pxWidth,
          pxHeight: meta.pxHeight,
          color,
          bitsPerComponent: meta.color === 'mono' ? 1 : meta.bitDepth,
          dpiX: dx,
          dpiY: dy,
          bounds: box,
        },
      ],
      rgbPaintOps: 0,
      spotColors: [],
      unreadable: [],
      sizeUnknown,
    }
  })

  for (const fmt of ['png', 'jpeg'] as const) {
    const idx = files.flatMap((f, i) => (f.meta.format === fmt ? [i + 1] : []))
    if (idx.length === 0) continue
    const policy = printer.imageFormats[fmt]
    if (policy.value === 'accepted') continue
    const sources = policy.src.map((k) => ({ label: printer.name, url: printer.sources[k] }))
    for (const n of idx) {
      add(
        {
          level: policy.value === 'discouraged' ? 'warn' : 'info',
          code: `raster-format-${fmt}`,
          title:
            policy.value === 'discouraged'
              ? `${FORMAT_LABEL[fmt]} での入稿は推奨されていません`
              : `${printer.name}のサイトに ${FORMAT_LABEL[fmt]} での入稿の記載がありません`,
          detail: `${policy.note ?? ''}${policy.note ? '。' : ''}受け付けてもらえるか、入稿の前に印刷所に確かめてください。`,
          sources,
        },
        n,
      )
    }
  }
  const alpha = files.flatMap((f, i) => (f.meta.alpha ? [i + 1] : []))
  for (const n of alpha) {
    add(
      {
        level: 'info',
        code: 'raster-alpha',
        // ヘッダからは「透明を持てる形式か」しかわからない（実際に透明な画素があるかは画素を見ないとわからない）
        title: '透明（アルファチャンネル）を持つ画像があります',
        detail: '透明な部分があれば、印刷では紙の色（白）になります。背景を塗りつぶすか、白で統合してから書き出すと確実です。',
        sources: [],
      },
      n,
    )
  }
  if (opts.part === 'body' && files.length > 1) {
    const rule = printer.nombre
    add({
      level: 'info',
      code: 'nombre-raster',
      title: '画像の原稿のノンブルは確かめていません',
      detail: `画像の中の文字は読み取れないため、ノンブルが入っているかは目で確かめてください。ページの順番は、ファイル名の順（数字は数として比べる）に並べています。${rule.note ? `${rule.note}。` : ''}`,
      sources: rule.src.map((k) => ({ label: printer.name, url: printer.sources[k] })),
    })
  }

  return { facts: { version: '', repaired: false, pdfx: '', pages }, findings: [...findings.values()] }
}

const round1 = (v: number) => Math.round(v * 10) / 10
const mmText = (s: { w: number; h: number }) => `${round1(s.w)}×${round1(s.h)}mm`

/** 画像原稿の検査。画像ならではの指摘と、PDF と共通の判定をまとめて返す */
export function checkRasters(files: RasterFile[], opts: CheckOptions): { facts: DocumentFacts; findings: Finding[] } {
  const { facts, findings } = rasterFacts(files, opts)
  return { facts, findings: sortFindings([...findings, ...checkDocument(facts, opts)]) }
}
