/**
 * ページから集めた事実を、選んだ印刷所の仕様と突き合わせて指摘にする。
 * 指摘の重さは3段階:
 * - error … 印刷所が不備として扱う、または仕上がりが確実に崩れる（サイズ違い・フォント未埋め込み）
 * - warn  … 推奨から外れていて、仕上がりが期待と変わるおそれがある（解像度不足・RGB の変換）
 * - info  … 問題ではないが、知っておくとよいこと
 * 同じ種類の指摘はページをまとめて1件にする（80ページの本で同じ指摘が80件並ばないように）。
 */
import { boxHeightMm, boxWidthMm, PT_PER_MM, type Box, type DocumentFacts, type PageFacts } from '../pdf/inspect.ts'
import type { Format, PrinterSpec, Sourced } from '../specs/types.ts'
import { analyzeNombres, MIN_COVERAGE, type TextItem } from './nombre.ts'

export type Level = 'error' | 'warn' | 'info'

export type Finding = {
  level: Level
  /** 同じ種類をまとめるための鍵 */
  code: string
  title: string
  detail: string
  pages: number[]
  /** ページ上の該当箇所（PDF の座標、pt）。赤枠で示す */
  regions: { page: number; box: Box; label?: string }[]
  sources: { label: string; url: string }[]
}

export type CheckOptions = {
  printer: PrinterSpec
  formatId: string
  part: 'body' | 'cover'
  /** 本文の刷り色。表紙は常にカラーとして扱う */
  ink: 'mono' | 'color'
  binding: 'perfect' | 'saddle'
}

/** 寸法の比較で許す差（mm）。作成ソフトの丸めで 0.1mm 前後ずれるのはよくある */
const TOLERANCE_MM = 0.5

/**
 * texts はページごとの文字（pdf.js で取り出したもの）。ノンブルの検査に使う。
 * 渡さなければノンブルは検査しない（Node での確認や、文字の取り出しに失敗したとき）
 */
export function checkDocument(facts: DocumentFacts, opts: CheckOptions, texts?: TextItem[][]): Finding[] {
  const { printer } = opts
  const format = printer.formats.find((f) => f.id === opts.formatId)
  if (!format) throw new Error(`${printer.name} に判型 ${opts.formatId} がない`)
  const out = new Map<string, Finding>()
  const cite = (v: { src: string[] }) => v.src.map((k) => ({ label: printer.name, url: printer.sources[k] }))
  const add: Add = (f, page, box, label) => {
    let found = out.get(f.code)
    if (!found) {
      found = { ...f, pages: [], regions: [] }
      out.set(f.code, found)
    }
    if (page !== undefined && !found.pages.includes(page)) found.pages.push(page)
    if (page !== undefined && box) found.regions.push({ page, box, label })
  }

  if (facts.repaired) {
    add({
      level: 'warn',
      code: 'repaired',
      title: 'PDF の内部の目次（相互参照表）が壊れています',
      detail: 'tonbo は全体を読み直して検査しましたが、印刷所の機械で正しく開けない恐れがあります。作成ソフトから書き出し直すと直ります。',
      sources: [],
    })
  }

  for (const p of facts.pages) {
    if (opts.part === 'body') checkSize(p, format, printer, cite, add)
    checkImages(p, opts, cite, add)
    checkFonts(p, printer, cite, add)
    checkPaint(p, opts, cite, add)
    if (p.unreadable.length) {
      add(
        {
          level: 'warn',
          code: 'unreadable',
          title: '確かめられなかった部分があります',
          detail: `次のものは tonbo が読めない形式で保存されていたため、検査していません: ${[...new Set(p.unreadable)].join('、')}`,
          sources: [],
        },
        p.number,
      )
    }
  }
  if (opts.part === 'body') checkPageCount(facts.pages.length, format, opts, cite, add)
  if (opts.part === 'body' && texts) checkNombres(facts.pages, texts, format, printer, cite, add)

  const order: Record<Level, number> = { error: 0, warn: 1, info: 2 }
  return [...out.values()].sort((a, b) => order[a.level] - order[b.level])
}

type Cite = (v: { src: string[] }) => Finding['sources']
type Add = (f: Omit<Finding, 'pages' | 'regions'>, page?: number, box?: Box, label?: string) => void

/** 仕様データの注記をつなげる（注記は文末の「。」なしで書いてある） */
const note = (v: { note?: string }) => (v.note ? v.note.replace(/。?$/, '。') : '')

const mm1 = (v: number) => (Math.round(v * 10) / 10).toString()
const near = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE_MM

/** ページの向き（Rotate）を反映した、見たままの幅と高さ */
function size(b: Box, rotate: number): [number, number] {
  const w = boxWidthMm(b)
  const h = boxHeightMm(b)
  return rotate === 90 || rotate === 270 ? [h, w] : [w, h]
}

function checkSize(p: PageFacts, format: Format, printer: PrinterSpec, cite: Cite, add: Add) {
  const bleed = printer.bleedMm.value
  const [mw, mh] = size(p.cropBox, p.rotate)
  const formatText = `${format.label}（${format.w}×${format.h}mm）`
  if (p.trimBox) {
    // 仕上がりの枠が書かれていれば、それを信じて仕上がりと塗り足しを別々に確かめる
    const [tw, th] = size(p.trimBox, p.rotate)
    if (!near(tw, format.w) || !near(th, format.h)) {
      add(
        {
          level: 'error',
          code: 'trim-size',
          title: `仕上がりサイズが ${formatText} と違います`,
          detail: `PDF に書かれた仕上がり（TrimBox）は ${mm1(tw)}×${mm1(th)}mm です。`,
          sources: cite(format),
        },
        p.number,
        p.trimBox,
      )
      return
    }
    const outer = p.bleedBox ?? p.cropBox
    const margin = Math.min(p.trimBox.x0 - outer.x0, p.trimBox.y0 - outer.y0, outer.x1 - p.trimBox.x1, outer.y1 - p.trimBox.y1) / PT_PER_MM
    if (margin < bleed - TOLERANCE_MM) {
      add(
        {
          level: 'warn',
          code: 'bleed-short',
          title: `塗り足しが ${bleed}mm に足りません`,
          detail: `仕上がりの外側に ${mm1(Math.max(0, margin))}mm しかありません。絵柄が端まであるページは、断裁のずれで白い線が出ることがあります。${note(printer.bleedMm)}`,
          sources: cite(printer.bleedMm),
        },
        p.number,
        p.trimBox,
      )
    }
    return
  }
  // 仕上がりの枠がない PDF（多くのお絵描きソフトの書き出し）は、用紙の大きさから判断する
  if (near(mw, format.w) && near(mh, format.h)) {
    add(
      {
        level: 'warn',
        code: 'no-bleed',
        title: '塗り足しがありません',
        detail: `用紙が仕上がりと同じ ${formatText} です。絵柄が端まであるページは、天地左右に ${bleed}mm ずつ足した ${format.w + bleed * 2}×${format.h + bleed * 2}mm で作ってください。${note(printer.bleedMm)}`,
        sources: cite(printer.bleedMm),
      },
      p.number,
      p.cropBox,
    )
  } else if (near(mw, format.w + bleed * 2) && near(mh, format.h + bleed * 2)) {
    // 塗り足し込みの大きさちょうど。仕上がりは中央にあるとみなせる
  } else if (looksLikeMarks(mw - format.w, mh - format.h, bleed)) {
    add(
      {
        level: 'info',
        code: 'with-marks',
        title: 'トンボ付きの大きさとみなしました',
        detail: `用紙が ${mm1(mw)}×${mm1(mh)}mm で、${formatText} より大きいため、仕上がりは中央にあるとみなしています。トンボの位置は確かめていません。`,
        sources: [],
      },
      p.number,
    )
  } else {
    add(
      {
        level: 'error',
        code: 'page-size',
        title: `用紙の大きさが ${formatText} に合いません`,
        detail: `このページは ${mm1(mw)}×${mm1(mh)}mm です。仕上がりのままなら ${format.w}×${format.h}mm、塗り足し込みなら ${format.w + bleed * 2}×${format.h + bleed * 2}mm で作ってください。`,
        sources: cite(format),
      },
      p.number,
      p.cropBox,
    )
  }
}

/**
 * 仕上がりより大きい用紙が、トンボの余白を付けたものに見えるか。
 * トンボは天地左右に同じ幅で付くので、幅と高さの増え方がそろう。
 * そろっていなければ別の判型（A5 指定に B5 の原稿など）とみなす
 */
function looksLikeMarks(extraW: number, extraH: number, bleed: number): boolean {
  return extraW > bleed * 2 && extraH > bleed * 2 && extraW <= 40 && extraH <= 40 && Math.abs(extraW - extraH) <= 4
}

/** 画像がページの見える範囲に少しでもかかっているか（はみ出して全部隠れた画像は検査しない） */
const visible = (img: Box, page: Box) => img.x1 > page.x0 && img.x0 < page.x1 && img.y1 > page.y0 && img.y0 < page.y1

function checkImages(p: PageFacts, opts: CheckOptions, cite: Cite, add: Add) {
  const res = opts.printer.resolution
  for (const img of p.images) {
    if (!visible(img.bounds, p.cropBox) || img.pxWidth < 2 || img.pxHeight < 2) continue
    const dpi = Math.min(img.dpiX, img.dpiY)
    const mono = img.color === 'mask' || (img.color === 'gray' && img.bitsPerComponent === 1)
    const kind = mono ? 'mono' : img.color === 'gray' ? 'gray' : 'color'
    const spec: Sourced<{ recommended: number; acceptable?: number }> = res[kind]
    const { recommended, acceptable } = spec.value
    // 推奨値ちょうどで作っても、作成ソフトの丸めで 1〜2dpi 下がることがあるので少し許す
    if (dpi >= recommended * 0.97) continue
    const kindLabel = { mono: 'モノクロ2階調', gray: 'グレースケール', color: 'カラー' }[kind]
    const below = acceptable !== undefined && dpi < acceptable
    add(
      {
        level: 'warn',
        code: `dpi-${kind}${below ? '-low' : ''}`,
        title: `${kindLabel}の画像の解像度が推奨（${recommended}dpi）より低いです`,
        detail:
          '印刷される大きさでの解像度が足りない画像があります（画像ごとの値は赤枠に添えて示します）。' +
          (acceptable !== undefined ? `${opts.printer.name}は ${acceptable}dpi 以上なら印刷はできるとしています。` : '') +
          note(spec),
        sources: cite(spec),
      },
      p.number,
      img.bounds,
      `約 ${Math.round(dpi)}dpi`,
    )
  }
}

/** フォント名を比べやすい形にする（空白・記号を除いて小文字に） */
const fontKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

function checkFonts(p: PageFacts, printer: PrinterSpec, cite: Cite, add: Add) {
  const exempt = printer.fontEmbedExempt
  for (const f of p.fonts) {
    if (f.embedded) continue
    if (exempt?.value.some((e) => fontKey(f.name).includes(fontKey(e)))) {
      add(
        {
          level: 'info',
          code: `font-exempt-${f.name}`,
          title: `フォント「${f.name}」が埋め込まれていません（不備にはなりません）`,
          detail: note(exempt),
          sources: cite(exempt),
        },
        p.number,
      )
      continue
    }
    add(
      {
        level: 'error',
        code: `font-${f.name}`,
        title: `フォント「${f.name}」が埋め込まれていません`,
        detail: '印刷所の機械に同じフォントがなければ、別の書体に置き換わったり文字化けしたりします。書き出しの設定で「フォントを埋め込む」を選ぶか、文字をアウトライン化してください。',
        sources: [],
      },
      p.number,
    )
  }
}

function checkPaint(p: PageFacts, opts: CheckOptions, cite: Cite, add: Add) {
  const rgbBoxes = p.images.filter((i) => i.color === 'rgb' && visible(i.bounds, p.cropBox)).map((i) => i.bounds)
  const rgb = rgbBoxes.length > 0 || p.rgbPaintOps > 0
  const part = opts.part === 'cover' ? 'cover' : 'body'
  const policy = opts.printer.rgb[part]
  if (rgb) {
    if (part === 'body' && opts.ink === 'mono') {
      add(
        {
          level: policy.value === 'accepted' ? 'info' : 'warn',
          code: 'rgb-in-mono',
          title: 'モノクロ本文に RGB の色が使われています',
          detail: `画像、または文字や図形の色が RGB です。白黒で刷られるので、濃さの見え方が画面と変わります。${note(policy)}`,
          sources: cite(policy),
        },
        p.number,
      )
    } else if (policy.value === 'converted') {
      add(
        {
          level: 'warn',
          code: 'rgb-converted',
          title: 'RGB の色が使われています（印刷所で CMYK に変換されます）',
          detail: `画像、または文字や図形の色が RGB です。鮮やかな色ほどくすんで刷られます。色を確かめたい場合は、作成ソフトで CMYK に変換して見え方を確認してから入稿してください。${note(policy)}`,
          sources: cite(policy),
        },
        p.number,
      )
    } else if (policy.value === 'accepted') {
      add(
        {
          level: 'info',
          code: 'rgb-accepted',
          title: 'RGB の色が使われています（この印刷所は RGB のまま受け付けます）',
          detail: note(policy),
          sources: cite(policy),
        },
        p.number,
      )
    } else {
      add(
        {
          level: 'info',
          code: 'rgb-unspecified',
          title: 'RGB の色が使われています',
          detail: `${opts.printer.name}のサイトには、本文の RGB の扱いについての記載が見つかりませんでした。`,
          sources: [],
        },
        p.number,
      )
    }
  }
  if (rgb) {
    // 指摘はどれか1つだけ出ているので、その指摘に RGB 画像の位置を足す（文字や図形の色は位置を追っていない）
    const code = part === 'body' && opts.ink === 'mono' ? 'rgb-in-mono' : `rgb-${policy.value}`
    for (const b of rgbBoxes) add({ level: 'info', code, title: '', detail: '', sources: [] }, p.number, b, 'RGB の画像')
  }
  if (p.spotColors.length) {
    add(
      {
        level: 'info',
        code: 'spot',
        title: '特色が使われています',
        detail: `特色「${p.spotColors.join('、')}」が使われています。特色で刷る注文でなければ、CMYK かグレーに置き換えて刷られます。`,
        sources: [],
      },
      p.number,
    )
  }
}

function checkPageCount(pages: number, format: Format, opts: CheckOptions, cite: Cite, add: Add) {
  const rule = opts.printer.pageUnit[opts.binding]
  const bindingLabel = opts.binding === 'saddle' ? '中とじ' : '無線とじ（平とじ）'
  if (!rule) {
    add({
      level: 'info',
      code: 'page-unit-unknown',
      title: `${bindingLabel}のページ数の単位は確かめていません`,
      detail: `${opts.printer.name}のサイトに、${bindingLabel}のページ数の単位の記載が見つかりませんでした。`,
      sources: [],
    })
    return
  }
  const u = rule.value
  const unit = u.byFormat?.[format.id] ?? u.unit
  const total = u.includesCover ? pages + 4 : pages
  const countText = u.includesCover ? `本文 ${pages} ページと表紙 4 ページの計 ${total} ページ` : `本文 ${pages} ページ`
  const problems: string[] = []
  if (total % unit !== 0) problems.push(`${unit} の倍数ではありません`)
  if (u.min !== undefined && total < u.min) problems.push(`${u.min} ページ未満です`)
  if (u.max !== undefined && total > u.max) problems.push(`${u.max} ページを超えています`)
  if (problems.length === 0) return
  add({
    level: u.strict ? 'error' : 'info',
    code: 'page-unit',
    title: u.strict ? `ページ数が${bindingLabel}の条件に合いません` : `ページ数が料金表の刻みに合いません`,
    detail: `${countText}で、${problems.join('。')}。${u.strict ? '白ページを足して調整してください。' : ''}${note(rule)}`,
    sources: cite(rule),
  })
}


/**
 * ページの仕上がりの枠。TrimBox があればそれを、なければ用紙の中央に判型の大きさを置いたものとみなす
 * （塗り足し込みやトンボ付きの用紙は、仕上がりが中央にある作り方が一般的なため）
 */
export function pageTrim(p: PageFacts, format: Format): Box {
  if (p.trimBox) return p.trimBox
  const turned = p.rotate === 90 || p.rotate === 270
  const w = (turned ? format.h : format.w) * PT_PER_MM
  const h = (turned ? format.w : format.h) * PT_PER_MM
  const cx = (p.cropBox.x0 + p.cropBox.x1) / 2
  const cy = (p.cropBox.y0 + p.cropBox.y1) / 2
  return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 }
}

function checkNombres(pages: PageFacts[], texts: TextItem[][], format: Format, printer: PrinterSpec, cite: Cite, add: Add) {
  if (pages.length < 2) return
  const rule = printer.nombre
  const r = rule.value
  const sources = cite(rule)
  const trims = pages.map((p) => pageTrim(p, format))
  const a = analyzeNombres(pages.map((p, i) => ({ number: p.number, trim: trims[i], items: texts[i] ?? [] })))
  if (a.coverage < MIN_COVERAGE || a.offset === null) {
    add({
      level: r.required ? 'warn' : 'info',
      code: 'nombre-undetectable',
      title: r.required ? 'ノンブルを確かめられませんでした' : 'ノンブルは見つかりませんでした',
      detail:
        (r.required
          ? 'ページの余白に番号の文字が見つかりませんでした。文字を画像にしている（ラスタライズした）原稿は読み取れないので、全ページに入っているか目で確かめてください。'
          : '') + note(rule),
      sources,
    })
    return
  }
  a.pages.forEach((pg, i) => {
    if (pg.found) {
      const b = pg.found.box
      const trim = trims[i]
      const label = String(pg.found.value)
      if (r.insideTrim && (b.x0 < trim.x0 || b.y0 < trim.y0 || b.x1 > trim.x1 || b.y1 > trim.y1)) {
        add(
          {
            level: 'warn',
            code: 'nombre-outside',
            title: 'ノンブルが仕上がりの外（塗り足し）にかかっています',
            detail: `断裁で切れてしまいます。仕上がりの内側に入れてください。${note(rule)}`,
            sources,
          },
          pg.number,
          b,
          label,
        )
      }
      // 文字の高さは書体の枠から求めた概算なので、少し許す
      if (r.minHeightMm !== undefined && pg.found.heightMm < r.minHeightMm - 0.2) {
        add(
          {
            level: 'warn',
            code: 'nombre-small',
            title: `ノンブルの文字が ${r.minHeightMm}mm より小さいです`,
            detail: `文字の大きさから見た高さが ${r.minHeightMm}mm に届いていません。${note(rule)}`,
            sources,
          },
          pg.number,
          b,
          label,
        )
      }
      if (r.noKanji && pg.found.kanji) {
        add(
          { level: 'error', code: 'nombre-kanji', title: 'ノンブルに漢数字が使われています', detail: `算用数字（1, 2, 3…）にしてください。${note(rule)}`, sources },
          pg.number,
          b,
          '漢数字',
        )
      }
      return
    }
    if (pg.candidates.length) {
      const c = pg.candidates[0]
      add(
        {
          level: 'warn',
          code: 'nombre-sequence',
          title: 'ノンブルの番号が並びと合わないページがあります',
          detail: '前後のページから見て、入っているべき番号と違う番号が見つかりました。番号の飛びや重なり、ページの順番の入れ替わりがないか確かめてください。',
          sources: [],
        },
        pg.number,
        c.box,
        `${c.value}（${pg.expected} のはず）`,
      )
      return
    }
    add(
      {
        level: r.required ? 'error' : 'info',
        code: 'nombre-missing',
        title: r.required ? 'ノンブルが見つからないページがあります' : 'ノンブルのないページがあります',
        detail: `前後のページから見て番号が入っているはずのページで、余白に番号が見つかりませんでした。白ページにも入れる必要があります。${note(rule)}`,
        sources,
      },
      pg.number,
    )
  })
  const first = a.pages[0].expected
  if (r.oddStart && first !== null && first % 2 === 0) {
    add({
      level: 'warn',
      code: 'nombre-odd-start',
      title: `ノンブルが偶数（${first}）から始まっています`,
      detail: `${printer.name}は奇数ページから始めることを求めています。${note(rule)}`,
      sources,
    })
  }
}
