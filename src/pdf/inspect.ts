/**
 * 検査に必要な事実だけをページごとに集める（判定はしない。判定は印刷所の仕様と突き合わせる側で行う）。
 * - ページの枠（MediaBox / CropBox / BleedBox / TrimBox）
 * - 実際に見える文字を描くのに使われたフォントと、その埋め込みの有無（透明な文字だけのフォントは数えない）
 * - 画像の画素数・色空間と、ページ上に置かれた大きさ（そこから実効解像度が決まる）
 * - 図形や文字の塗りに RGB が使われたか
 * 描画命令は cm（座標変換）・q/Q（状態の保存と復元）・Do（画像や部品の配置）など、必要な演算子だけを解釈する。
 */
import { Progress, type OnProgress } from '../progress.ts'
import { paletteColor } from '../palette.ts'
import { PdfDocument, UnsupportedFilter } from './document.ts'
import {
  displayName,
  isName,
  isOperator,
  isRef,
  isStream,
  isString,
  latin1,
  Lexer,
  PdfSyntaxError,
  type PdfDict,
  type PdfValue,
} from './objects.ts'

export type Box = { x0: number; y0: number; x1: number; y1: number }
/** 色の系統。spot は特色（Separation / DeviceN）、lab は Lab や CalRGB 以外の色の決め方 */
export type ColorFamily = 'gray' | 'rgb' | 'cmyk' | 'spot' | 'lab' | 'mask' | 'unknown'

export type FontInfo = { name: string; subtype: string; embedded: boolean }

export type ImagePlacement = {
  /** リソース上の名前（インライン画像は「インライン」） */
  label: string
  pxWidth: number
  pxHeight: number
  color: ColorFamily
  bitsPerComponent: number
  /** ページ上での実効解像度。横と縦で拡大率が違うことがあるので両方持つ */
  dpiX: number
  dpiY: number
  /** ページ座標（pt）での外接矩形 */
  bounds: Box
}

export type PageFacts = {
  /** 1 から数えたページ番号 */
  number: number
  mediaBox: Box
  cropBox: Box
  bleedBox?: Box
  trimBox?: Box
  rotate: number
  fonts: FontInfo[]
  images: ImagePlacement[]
  /** RGB の色で塗った・線を引いた・文字を描いた回数 */
  rgbPaintOps: number
  spotColors: string[]
  /** 読み取れなかったもの（未対応の圧縮形式など）。検査結果に「確かめられなかった」として出す */
  unreadable: string[]
  /** 大きさがわからない（解像度の情報がない画像原稿で、縦横比も判型に合わない）。大きさの検査をしない */
  sizeUnknown?: boolean
}

export type DocumentFacts = {
  version: string
  repaired: boolean
  /** PDF/X の宣言（OutputIntents の GTS_PDFX など）。なければ空 */
  pdfx: string
  pages: PageFacts[]
}

export const PT_PER_MM = 72 / 25.4

/** onProgress には、読み終えたページ数と全体のページ数（ページツリーの /Count）を渡す */
export async function inspectPdf(bytes: Uint8Array, onProgress?: OnProgress): Promise<DocumentFacts> {
  const doc = await PdfDocument.open(bytes)
  const root = (await doc.getDict(doc.trailer.get('Root')))!
  const pages: PageFacts[] = []
  const tree = await doc.getDict(root.get('Pages'))
  const progress = new Progress(Number(await doc.get(tree?.get('Count'))) || 0, onProgress)
  await walkPages(doc, tree, {}, pages, new Set(), progress)
  return { version: doc.version, repaired: doc.repaired, pdfx: await pdfxOf(doc, root), pages }
}

async function pdfxOf(doc: PdfDocument, root: PdfDict): Promise<string> {
  const intents = await doc.get(root.get('OutputIntents'))
  if (!Array.isArray(intents)) return ''
  for (const i of intents) {
    const d = await doc.getDict(i)
    if (d && isName(d.get('S'), 'GTS_PDFX')) {
      const id = await doc.get(d.get('OutputConditionIdentifier'))
      return id && typeof id === 'object' && 'bytes' in id ? 'PDF/X' + `（${latin1(id.bytes)}）` : 'PDF/X'
    }
  }
  return ''
}

/** ページツリーで親から子へ受け継がれる値 */
type Inherited = { MediaBox?: PdfValue; CropBox?: PdfValue; Resources?: PdfValue; Rotate?: PdfValue }

async function walkPages(doc: PdfDocument, node: PdfDict | undefined, inh: Inherited, out: PageFacts[], seen: Set<PdfDict>, progress: Progress) {
  if (!node || seen.has(node)) return
  seen.add(node)
  const next: Inherited = {
    MediaBox: node.get('MediaBox') ?? inh.MediaBox,
    CropBox: node.get('CropBox') ?? inh.CropBox,
    Resources: node.get('Resources') ?? inh.Resources,
    Rotate: node.get('Rotate') ?? inh.Rotate,
  }
  const kids = await doc.get(node.get('Kids'))
  if (isName(node.get('Type'), 'Pages') || (Array.isArray(kids) && !node.has('Contents'))) {
    if (Array.isArray(kids)) for (const k of kids) await walkPages(doc, await doc.getDict(k), next, out, seen, progress)
    return
  }
  out.push(await inspectPage(doc, node, next, out.length + 1))
  await progress.step(out.length)
}

async function boxOf(doc: PdfDocument, v: PdfValue | undefined, unit: number): Promise<Box | undefined> {
  const a = await doc.get(v)
  if (!Array.isArray(a) || a.length < 4) return undefined
  const n = await Promise.all(a.slice(0, 4).map((x) => doc.get(x)))
  if (!n.every((x) => typeof x === 'number')) return undefined
  const [x0, y0, x1, y1] = n as number[]
  return { x0: Math.min(x0, x1) * unit, y0: Math.min(y0, y1) * unit, x1: Math.max(x0, x1) * unit, y1: Math.max(y0, y1) * unit }
}

async function inspectPage(doc: PdfDocument, page: PdfDict, inh: Inherited, number: number): Promise<PageFacts> {
  const unit = typeof page.get('UserUnit') === 'number' ? (page.get('UserUnit') as number) : 1
  // MediaBox がないページは仕様違反だが、多くのビューアと同じく US Letter とみなす
  const mediaBox = (await boxOf(doc, inh.MediaBox, unit)) ?? { x0: 0, y0: 0, x1: 612, y1: 792 }
  const facts: PageFacts = {
    number,
    mediaBox,
    cropBox: (await boxOf(doc, inh.CropBox, unit)) ?? mediaBox,
    bleedBox: await boxOf(doc, page.get('BleedBox'), unit),
    trimBox: await boxOf(doc, page.get('TrimBox'), unit),
    rotate: (((Number(await doc.get(inh.Rotate)) || 0) % 360) + 360) % 360,
    fonts: [],
    images: [],
    rgbPaintOps: 0,
    spotColors: [],
    unreadable: [],
  }
  const content = await contentBytes(doc, page.get('Contents'), facts)
  const resources = await doc.getDict(inh.Resources)
  const ctx: Ctx = { doc, facts, fontsSeen: new Map(), fontCache: new Map(), spots: new Set(), formsActive: new Set() }
  await run(ctx, content, resources, [unit, 0, 0, unit, 0, 0])
  facts.fonts = [...ctx.fontsSeen.values()]
  facts.spotColors = [...ctx.spots]
  return facts
}

async function contentBytes(doc: PdfDocument, v: PdfValue | undefined, facts: PageFacts): Promise<Uint8Array> {
  const c = await doc.get(v)
  const parts = Array.isArray(c) ? c : [c]
  const out: Uint8Array[] = []
  for (const p of parts) {
    const s = await doc.get(p)
    if (!isStream(s)) continue
    try {
      out.push(await doc.decode(s), Uint8Array.of(10))
    } catch (e) {
      facts.unreadable.push(e instanceof UnsupportedFilter ? `ページの描画命令（${e.filter}）` : 'ページの描画命令')
    }
  }
  const total = out.reduce((n, b) => n + b.length, 0)
  const joined = new Uint8Array(total)
  let at = 0
  for (const b of out) {
    joined.set(b, at)
    at += b.length
  }
  return joined
}

type Matrix = [number, number, number, number, number, number]
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
]

type Ctx = {
  doc: PdfDocument
  facts: PageFacts
  fontsSeen: Map<string, FontInfo>
  /** フォントの辞書を読んだ結果（同じフォントを何度も選び直す PDF が多いので、読むのは1回だけにする） */
  fontCache: Map<string, FontInfo | undefined>
  spots: Set<string>
  /** 部品（Form XObject）が自分自身を呼ぶ壊れたファイルで止まらないように */
  formsActive: Set<PdfValue>
}

/**
 * 描画の状態のうち、検査に要るものだけ。font と textRender（文字の表示モード）は q/Q で保存・復元される。
 * 表示モード 3 は「塗りも線もない」透明な文字で、スキャンした PDF の検索用の文字などに使われ、印刷されない
 */
type GState = { ctm: Matrix; fill: ColorFamily; stroke: ColorFamily; font?: { key: string; info?: FontInfo }; textRender: number }

/** 部品（Form XObject）は、呼び出した側の状態を受け継いで描かれる */
type Inherit = Pick<GState, 'font' | 'textRender'>

async function run(ctx: Ctx, content: Uint8Array, resources: PdfDict | undefined, ctm: Matrix, inherit: Inherit = { textRender: 0 }): Promise<void> {
  const { doc } = ctx
  const lx = new Lexer(content)
  const stack: GState[] = []
  let gs: GState = { ctm, fill: 'gray', stroke: 'gray', ...inherit }
  let operands: PdfValue[] = []
  const resource = async (kind: string, key: PdfValue) => {
    if (!isName(key)) return undefined
    const dict = await doc.getDict(resources?.get(kind))
    return dict?.get(key.name)
  }
  const paint = (family: ColorFamily) => {
    if (family === 'rgb') ctx.facts.rgbPaintOps++
  }
  for (;;) {
    let tok: ReturnType<Lexer['next']>
    const before = lx.pos
    try {
      tok = lx.next(true)
    } catch (e) {
      if (!(e instanceof PdfSyntaxError)) throw e
      if (lx.pos === before) lx.pos++
      operands = []
      continue
    }
    if (tok === undefined) break
    if (!isOperator(tok)) {
      operands.push(tok)
      continue
    }
    const op = tok.op
    switch (op) {
      case 'q':
        stack.push(gs)
        gs = { ...gs }
        break
      case 'Q':
        gs = stack.pop() ?? gs
        break
      case 'cm': {
        const nums = operands.filter((x): x is number => typeof x === 'number')
        if (nums.length === 6) gs.ctm = multiply(nums as Matrix, gs.ctm)
        break
      }
      // 色を選ぶ命令では数えず、その色で実際に塗ったときに数える（下の f・S・Tj など）。
      // 色を選んだだけで何も描かない PDF や、透明な文字の色指定を「RGB が使われている」と誤って数えないため
      case 'rg':
        gs.fill = 'rgb'
        break
      case 'RG':
        gs.stroke = 'rgb'
        break
      case 'k':
        gs.fill = 'cmyk'
        break
      case 'K':
        gs.stroke = 'cmyk'
        break
      case 'g':
        gs.fill = 'gray'
        break
      case 'G':
        gs.stroke = 'gray'
        break
      case 'cs':
      case 'CS': {
        const fam = await colorFamily(ctx, operands[0], resources)
        if (op === 'cs') gs.fill = fam
        else gs.stroke = fam
        break
      }
      case 'f':
      case 'F':
      case 'f*':
        paint(gs.fill)
        break
      case 'S':
      case 's':
        paint(gs.stroke)
        break
      case 'B':
      case 'B*':
      case 'b':
      case 'b*':
        paint(gs.fill)
        paint(gs.stroke)
        break
      case 'sh': {
        const sh = await doc.getDict(await resource('Shading', operands[0]))
        if (sh) paint(await colorFamily(ctx, sh.get('ColorSpace'), resources))
        break
      }
      case 'Tf': {
        // 書体を選んだだけでは数えない。実際に見える文字を描いたときに数える（下の Tj など）
        const fontRef = await resource('Font', operands[0])
        const key = isRef(fontRef) ? `${fontRef.num}` : isName(operands[0]) ? operands[0].name : ''
        if (!key) break
        if (!ctx.fontCache.has(key)) ctx.fontCache.set(key, await fontInfo(doc, fontRef))
        gs.font = { key, info: ctx.fontCache.get(key) }
        break
      }
      case 'Tr':
        if (typeof operands[0] === 'number') gs.textRender = operands[0]
        break
      case 'Tj':
      case 'TJ':
      case "'":
      case '"': {
        if (gs.font?.info && gs.textRender !== 3 && !ctx.fontsSeen.has(gs.font.key)) ctx.fontsSeen.set(gs.font.key, gs.font.info)
        // 表示モード 0・2・4・6 は塗り、1・2・5・6 は線で文字を描く（3 と 7 は描かない）
        if ([0, 2, 4, 6].includes(gs.textRender)) paint(gs.fill)
        if ([1, 2, 5, 6].includes(gs.textRender)) paint(gs.stroke)
        break
      }
      case 'Do': {
        const xo = await doc.get(await resource('XObject', operands[0]))
        if (!isStream(xo)) break
        const sub = await doc.get(xo.dict.get('Subtype'))
        if (isName(sub, 'Image')) {
          const label = isName(operands[0]) ? operands[0].name : ''
          await placeImage(ctx, xo.dict, label, gs.ctm, resources)
        } else if (isName(sub, 'Form') && !ctx.formsActive.has(xo) && ctx.formsActive.size < 32) {
          ctx.formsActive.add(xo)
          const m = await doc.get(xo.dict.get('Matrix'))
          const fm = Array.isArray(m) && m.length === 6 && m.every((x) => typeof x === 'number') ? (m as Matrix) : ([1, 0, 0, 1, 0, 0] as Matrix)
          try {
            const body = await doc.decode(xo)
            await run(ctx, body, (await doc.getDict(xo.dict.get('Resources'))) ?? resources, multiply(fm, gs.ctm), { font: gs.font, textRender: gs.textRender })
          } catch (e) {
            if (e instanceof UnsupportedFilter) ctx.facts.unreadable.push(`部品 ${isName(operands[0]) ? operands[0].name : ''}（${e.filter}）`)
            else throw e
          }
          ctx.formsActive.delete(xo)
        }
        break
      }
      case 'BI':
        await inlineImage(ctx, lx, gs.ctm, resources)
        break
    }
    operands = []
  }
}

async function colorFamily(ctx: Ctx, v: PdfValue | undefined, resources: PdfDict | undefined, depth = 0): Promise<ColorFamily> {
  const { doc } = ctx
  const cs = await doc.get(v)
  if (depth > 8) return 'unknown'
  if (isName(cs)) {
    switch (cs.name) {
      case 'DeviceGray':
      case 'G':
      case 'CalGray':
        return 'gray'
      case 'DeviceRGB':
      case 'RGB':
      case 'CalRGB':
        return 'rgb'
      case 'DeviceCMYK':
      case 'CMYK':
        return 'cmyk'
      case 'Pattern':
        return 'unknown'
    }
    const named = (await doc.getDict(resources?.get('ColorSpace')))?.get(cs.name)
    return named === undefined ? 'unknown' : colorFamily(ctx, named, resources, depth + 1)
  }
  if (!Array.isArray(cs) || cs.length === 0) return 'unknown'
  const kind = await doc.get(cs[0])
  if (!isName(kind)) return 'unknown'
  switch (kind.name) {
    case 'ICCBased': {
      const s = await doc.get(cs[1])
      const n = isStream(s) ? Number(await doc.get(s.dict.get('N'))) : 0
      return n === 1 ? 'gray' : n === 3 ? 'rgb' : n === 4 ? 'cmyk' : 'unknown'
    }
    case 'Indexed':
    case 'I': {
      const base = await colorFamily(ctx, cs[1], resources, depth + 1)
      if (base !== 'rgb') return base
      // 元が RGB でも、パレットの中身が灰色だけならグレーとして扱う（白と黒の2色も、1bit ならモノクロ2階調として判定される）
      const hival = Number(await doc.get(cs[2]))
      const lookup = await doc.get(cs[3])
      let table: Uint8Array | undefined
      if (isString(lookup)) table = lookup.bytes
      else if (isStream(lookup)) table = await doc.decode(lookup).catch(() => undefined)
      if (!table || !(hival >= 0)) return base
      return paletteColor(table, Math.min(hival + 1, Math.floor(table.length / 3))) === 'rgb' ? 'rgb' : 'gray'
    }
    case 'Separation':
    case 'DeviceN': {
      const names = await doc.get(cs[1])
      const list = (Array.isArray(names) ? names : [names]).filter((n) => isName(n)).map((n) => n.name)
      // All は全版、None は版なし。どちらも特色ではないので、代替の色空間で判断する
      const real = list.filter((n) => n !== 'All' && n !== 'None' && !['Cyan', 'Magenta', 'Yellow', 'Black'].includes(n))
      if (real.length === 0) return list.every((n) => ['Cyan', 'Magenta', 'Yellow', 'Black'].includes(n)) ? 'cmyk' : colorFamily(ctx, cs[2], resources, depth + 1)
      for (const n of real) ctx.spots.add(displayName(n))
      return 'spot'
    }
    case 'Lab':
      return 'lab'
    case 'CalRGB':
      return 'rgb'
    case 'CalGray':
      return 'gray'
    case 'Pattern':
      return cs.length > 1 ? colorFamily(ctx, cs[1], resources, depth + 1) : 'unknown'
  }
  return 'unknown'
}

function placementOf(ctm: Matrix, pxWidth: number, pxHeight: number) {
  // 画像は単位正方形（0,0〜1,1）を CTM で写した場所に描かれる
  const wPt = Math.hypot(ctm[0], ctm[1])
  const hPt = Math.hypot(ctm[2], ctm[3])
  const corners = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ].map(([u, v]) => [u * ctm[0] + v * ctm[2] + ctm[4], u * ctm[1] + v * ctm[3] + ctm[5]])
  const xs = corners.map((c) => c[0])
  const ys = corners.map((c) => c[1])
  return {
    dpiX: wPt > 0 ? pxWidth / (wPt / 72) : 0,
    dpiY: hPt > 0 ? pxHeight / (hPt / 72) : 0,
    bounds: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) },
  }
}

async function placeImage(ctx: Ctx, dict: PdfDict, label: string, ctm: Matrix, resources: PdfDict | undefined) {
  const { doc } = ctx
  const pxWidth = Number(await doc.get(dict.get('Width'))) || 0
  const pxHeight = Number(await doc.get(dict.get('Height'))) || 0
  const mask = (await doc.get(dict.get('ImageMask'))) === true
  // JPEG 2000 は色空間を画像の中に持つことがあり、その場合は PDF 側からはわからず unknown になる
  const color: ColorFamily = mask ? 'mask' : await colorFamily(ctx, dict.get('ColorSpace'), resources)
  const bpc = Number(await doc.get(dict.get('BitsPerComponent'))) || (mask ? 1 : 8)
  ctx.facts.images.push({ label, pxWidth, pxHeight, color, bitsPerComponent: bpc, ...placementOf(ctm, pxWidth, pxHeight) })
}

/** BI 〜 ID 〜 EI のインライン画像。辞書を読み、バイナリの中身は EI まで読み飛ばす */
async function inlineImage(ctx: Ctx, lx: Lexer, ctm: Matrix, resources: PdfDict | undefined) {
  const dict: PdfDict = new Map()
  for (;;) {
    const k = lx.next(true)
    if (k === undefined) return
    if (isOperator(k) && k.op === 'ID') break
    if (!isName(k)) continue
    const v = lx.next(true)
    if (!isOperator(v) && v !== undefined) dict.set(k.name, v)
  }
  lx.pos++ // ID の後の空白1文字
  const b = lx.bytes
  const isWhite = (c: number | undefined) => c === undefined || c === 32 || c === 10 || c === 13 || c === 9 || c === 0
  for (let i = lx.pos; i < b.length - 1; i++) {
    if (b[i] === 0x45 && b[i + 1] === 0x49 && isWhite(b[i - 1]) && isWhite(b[i + 2])) {
      lx.pos = i + 2
      break
    }
    if (i === b.length - 2) lx.pos = b.length
  }
  const pick = (a: string, b2: string) => dict.get(a) ?? dict.get(b2)
  const pxWidth = Number(pick('W', 'Width')) || 0
  const pxHeight = Number(pick('H', 'Height')) || 0
  const mask = pick('IM', 'ImageMask') === true
  const color: ColorFamily = mask ? 'mask' : await colorFamily(ctx, pick('CS', 'ColorSpace'), resources)
  const bpc = Number(pick('BPC', 'BitsPerComponent')) || (mask ? 1 : 8)
  ctx.facts.images.push({ label: 'インライン', pxWidth, pxHeight, color, bitsPerComponent: bpc, ...placementOf(ctm, pxWidth, pxHeight) })
}

async function fontInfo(doc: PdfDocument, v: PdfValue | undefined): Promise<FontInfo | undefined> {
  const font = await doc.getDict(v)
  if (!font) return undefined
  const subtype = (await doc.get(font.get('Subtype'))) as PdfValue
  const sub = isName(subtype) ? subtype.name : ''
  const base = await doc.get(font.get('BaseFont'))
  const baseName = isName(base) ? displayName(base.name) : ''
  // Type3 は字形を PDF の中に図形として持っているので、常に埋め込み済みと同じ
  if (sub === 'Type3') return { name: baseName || '（Type3）', subtype: sub, embedded: true }
  let desc = await doc.getDict(font.get('FontDescriptor'))
  if (sub === 'Type0') {
    const desc0 = await doc.get(font.get('DescendantFonts'))
    const d = Array.isArray(desc0) ? await doc.getDict(desc0[0]) : undefined
    desc = await doc.getDict(d?.get('FontDescriptor'))
  }
  const embedded = !!desc && (desc.has('FontFile') || desc.has('FontFile2') || desc.has('FontFile3'))
  // 欧文の標準14書体（Helvetica など）も、印刷所の出力機に同じ書体がある保証はないので未埋め込みとして扱う
  return { name: baseName.replace(/^[A-Z]{6}\+/, ''), subtype: sub, embedded }
}

export const boxWidthMm = (b: Box) => (b.x1 - b.x0) / PT_PER_MM
export const boxHeightMm = (b: Box) => (b.y1 - b.y0) / PT_PER_MM
