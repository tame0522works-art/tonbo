/**
 * ノンブル（ページ番号）を、ページの文字から探して番号の並びを確かめる。
 * 文字の取り出しは pdf.js に任せ（日本語フォントの文字の対応表まで正しく扱えるため）、ここでは位置と数字だけを見る。
 *
 * 探し方:
 * - 仕上がりの端から MARGIN_MM 以内にある「数字だけの文字列」を候補にする（本文中の数字は長い文字列の一部なので拾わない）
 * - 「候補の番号 − ページの順番」の差で最も多いものを基準にし、各ページに「順番 + 差」の候補があるかを見る
 * - 番号が合わないページでは、ほかのページのノンブルと同じ高さにある候補だけを「番号違い」の手がかりにする
 * - 文字を画像にした原稿（漫画など）は文字が取れない。半分以上のページで候補がなければ「確かめられない」として扱う
 */
import { PT_PER_MM, type Box } from '../pdf/inspect.ts'

/** PDF の座標（pt）。x, y は文字の並びの左下（ベースライン） */
export type TextItem = { str: string; x: number; y: number; w: number; h: number }

export type NombreCandidate = { value: number; kanji: boolean; box: Box; heightMm: number }

export type NombrePage = { number: number; trim: Box; items: TextItem[] }

export type NombreAnalysis = {
  /** 基準にした「番号 − ページの順番」。候補が足りなければ null */
  offset: number | null
  /** 候補が1つ以上あったページの割合 */
  coverage: number
  pages: { number: number; expected: number | null; found?: NombreCandidate; candidates: NombreCandidate[] }[]
}

/** 仕上がりの端からこの距離までを、ノンブルを置く余白とみなす */
const MARGIN_MM = 25
/** 塗り足しに少しはみ出したノンブルも見つけて「はみ出し」と伝えるため、仕上がりの外側もこれだけ見る */
const OUTSIDE_MM = 6
/** 番号が合わなかったページで、ほかのページのノンブルと同じ高さとみなす差（mm） */
const SAME_HEIGHT_MM = 5
/** 候補が見つかったページがこれ未満の割合なら、文字が画像になっているとみなす */
export const MIN_COVERAGE = 0.5

const KANJI_DIGITS: Record<string, number> = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

/** 一〜九百九十九 の漢数字を数にする。読めなければ null */
export function kanjiNumber(s: string): number | null {
  if (!/^[〇一二三四五六七八九十百]+$/.test(s)) return null
  // 位取りの書き方（一二三 = 123）
  if (!/[十百]/.test(s)) return Number([...s].map((c) => KANJI_DIGITS[c]).join(''))
  let total = 0
  let digit = 0
  for (const c of s) {
    if (c === '百' || c === '十') {
      total += (digit || 1) * (c === '百' ? 100 : 10)
      digit = 0
    } else digit = KANJI_DIGITS[c]
  }
  return total + digit
}

export function nombreCandidates(items: TextItem[], trim: Box): NombreCandidate[] {
  const margin = MARGIN_MM * PT_PER_MM
  const outside = OUTSIDE_MM * PT_PER_MM
  const out: NombreCandidate[] = []
  for (const it of items) {
    // 全角数字を半角に、前後の飾り（- 3 - や「・」）を除く
    const s = it.str.normalize('NFKC').trim().replace(/^[-–—‐・\s]+|[-–—‐・\s]+$/g, '')
    let value: number | null = null
    let kanji = false
    if (/^\d{1,4}$/.test(s)) value = Number(s)
    else {
      value = kanjiNumber(s)
      kanji = value !== null
    }
    if (value === null) continue
    const box: Box = { x0: it.x, y0: it.y, x1: it.x + it.w, y1: it.y + it.h }
    const cx = (box.x0 + box.x1) / 2
    const cy = (box.y0 + box.y1) / 2
    // 仕上がりの外に大きく離れたもの（トンボの外の書き込みなど）は数えない
    if (cx < trim.x0 - outside || cx > trim.x1 + outside || cy < trim.y0 - outside || cy > trim.y1 + outside) continue
    const nearEdge = cx - trim.x0 < margin || trim.x1 - cx < margin || cy - trim.y0 < margin || trim.y1 - cy < margin
    if (!nearEdge) continue
    out.push({ value, kanji, box, heightMm: it.h / PT_PER_MM })
  }
  return out
}

export function analyzeNombres(pages: NombrePage[]): NombreAnalysis {
  const cands = pages.map((p) => nombreCandidates(p.items, p.trim))
  const votes = new Map<number, number>()
  cands.forEach((cs, i) => {
    // 1ページの中で同じ差を何度も数えない（同じ番号を2か所に入れる作り方もあるため）
    for (const off of new Set(cs.map((c) => c.value - (i + 1)))) votes.set(off, (votes.get(off) ?? 0) + 1)
  })
  let offset: number | null = null
  let best = 0
  for (const [off, n] of votes) {
    if (n > best || (n === best && offset !== null && Math.abs(off) < Math.abs(offset))) {
      offset = off
      best = n
    }
  }
  const withAny = cands.filter((c) => c.length > 0).length
  const coverage = pages.length ? withAny / pages.length : 0
  // 1ページだけの一致は偶然の数字かもしれないので、2ページ以上で一致したときだけ基準にする
  if (best < Math.min(2, pages.length)) offset = null
  const result = pages.map((p, i) => {
    const expected = offset === null ? null : i + 1 + offset
    return { number: p.number, expected, found: cands[i].find((c) => c.value === expected), candidates: cands[i] }
  })
  // ノンブルはどのページでもほぼ同じ高さに置く。番号が合ったページの高さを集め、合わなかったページでは
  // その高さの近くにある候補だけを「番号違い」の手がかりにする。目次の数字（ノンブルより内側の高さに並ぶ）を
  // ノンブルと取り違えて「番号が並びと合わない」と出さないため
  const heights = result.flatMap((r, i) => (r.found ? [centerY(r.found.box) - pages[i].trim.y0] : []))
  if (heights.length) {
    const tolerance = SAME_HEIGHT_MM * PT_PER_MM
    result.forEach((r, i) => {
      if (r.found) return
      r.candidates = r.candidates.filter((c) => heights.some((h) => Math.abs(centerY(c.box) - pages[i].trim.y0 - h) <= tolerance))
    })
  }
  return { offset, coverage, pages: result }
}

const centerY = (b: Box) => (b.y0 + b.y1) / 2
