/**
 * PNG と JPEG の画像原稿から、検査に要る情報だけをヘッダから読む（画素は展開しない）。
 * - 画素数
 * - 解像度の情報（PNG は pHYs、JPEG は JFIF と Exif）。書かれていなければ undefined
 * - 色の種類（2階調・グレー・RGB・CMYK）と透明の有無、ICC プロファイルの有無
 */

export type RasterFormat = 'png' | 'jpeg'
export type RasterColor = 'mono' | 'gray' | 'rgb' | 'cmyk' | 'indexed'

export type RasterMeta = {
  format: RasterFormat
  pxWidth: number
  pxHeight: number
  /** 画像に書かれた解像度（横・縦）。書かれていなければ undefined */
  dpi?: { x: number; y: number; source: 'pHYs' | 'JFIF' | 'Exif' }
  /** indexed は PNG のパレット画像。パレットの色は RGB なので、色の検査では RGB として扱う */
  color: RasterColor
  bitDepth: number
  alpha: boolean
  icc: boolean
}

export class RasterError extends Error {}

export function inspectRaster(b: Uint8Array): RasterMeta {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return inspectPng(b)
  if (b[0] === 0xff && b[1] === 0xd8) return inspectJpeg(b)
  throw new RasterError('PNG でも JPEG でもない')
}

const u32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
const u16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1]

function inspectPng(b: Uint8Array): RasterMeta {
  let pos = 8
  let meta: RasterMeta | undefined
  while (pos + 8 <= b.length) {
    const len = u32(b, pos)
    const type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7])
    const d = pos + 8
    if (type === 'IHDR') {
      const colorType = b[d + 9]
      const bitDepth = b[d + 8]
      // 色の種類: 0 グレー、2 RGB、3 パレット、4 グレー＋透明、6 RGB＋透明
      const color: RasterColor = colorType === 0 || colorType === 4 ? (bitDepth === 1 ? 'mono' : 'gray') : colorType === 3 ? 'indexed' : 'rgb'
      meta = { format: 'png', pxWidth: u32(b, d), pxHeight: u32(b, d + 4), color, bitDepth, alpha: colorType === 4 || colorType === 6, icc: false }
    } else if (!meta) {
      throw new RasterError('PNG の先頭に IHDR がない')
    } else if (type === 'pHYs' && b[d + 8] === 1) {
      // 単位 1 は「1メートルあたりの画素数」
      meta.dpi = { x: u32(b, d) * 0.0254, y: u32(b, d + 4) * 0.0254, source: 'pHYs' }
    } else if (type === 'iCCP') {
      meta.icc = true
    } else if (type === 'tRNS') {
      meta.alpha = true
    } else if (type === 'IDAT' || type === 'IEND') {
      // 解像度や色の情報は画素より前に置く決まりなので、ここで読み終える
      break
    }
    pos = d + len + 4
  }
  if (!meta) throw new RasterError('PNG のヘッダが読めない')
  return meta
}

function inspectJpeg(b: Uint8Array): RasterMeta {
  let pos = 2
  let size: { w: number; h: number; comps: number; precision: number } | undefined
  let jfif: RasterMeta['dpi']
  let exif: RasterMeta['dpi']
  let icc = false
  while (pos + 4 <= b.length) {
    if (b[pos] !== 0xff) {
      pos++
      continue
    }
    const marker = b[pos + 1]
    if (marker === 0xff) {
      pos++
      continue
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      pos += 2
      continue
    }
    if (marker === 0xda || marker === 0xd9) break // 画素の始まりか終わり
    const len = u16(b, pos + 2)
    const d = pos + 4
    const ascii = (at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n))
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      size = { precision: b[d], h: u16(b, d + 1), w: u16(b, d + 3), comps: b[d + 5] }
    } else if (marker === 0xe0 && ascii(d, 5) === 'JFIF\0') {
      const units = b[d + 7]
      const x = u16(b, d + 8)
      const y = u16(b, d + 10)
      // 単位 0 は縦横比だけで解像度ではない。2 は 1cm あたり
      if (units === 1) jfif = { x, y, source: 'JFIF' }
      else if (units === 2) jfif = { x: x * 2.54, y: y * 2.54, source: 'JFIF' }
    } else if (marker === 0xe1 && ascii(d, 6) === 'Exif\0\0') {
      exif = exifResolution(b.subarray(d + 6, d + len - 2))
    } else if (marker === 0xe2 && ascii(d, 12) === 'ICC_PROFILE\0') {
      icc = true
    }
    pos = d + len - 2
  }
  if (!size) throw new RasterError('JPEG の大きさが読めない')
  const color: RasterColor = size.comps === 1 ? 'gray' : size.comps === 4 ? 'cmyk' : 'rgb'
  // JFIF に単位つきの解像度があればそれを、なければ Exif を使う（Photoshop などは両方に同じ値を書く）
  return { format: 'jpeg', pxWidth: size.w, pxHeight: size.h, dpi: jfif ?? exif, color, bitDepth: size.precision, alpha: false, icc }
}

/** Exif（TIFF の形）の最初の IFD から XResolution・YResolution・ResolutionUnit を読む */
function exifResolution(t: Uint8Array): RasterMeta['dpi'] {
  if (t.length < 8) return undefined
  const le = t[0] === 0x49 // 'II' はリトルエンディアン
  const r16 = (i: number) => (le ? t[i] | (t[i + 1] << 8) : (t[i] << 8) | t[i + 1])
  const r32 = (i: number) => (le ? (t[i] | (t[i + 1] << 8) | (t[i + 2] << 16) | (t[i + 3] << 24)) >>> 0 : u32(t, i))
  const ifd = r32(4)
  if (ifd + 2 > t.length) return undefined
  const n = r16(ifd)
  let x: number | undefined
  let y: number | undefined
  let unit = 2
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12
    if (e + 12 > t.length) break
    const tag = r16(e)
    const rational = () => {
      const off = r32(e + 8)
      return off + 8 <= t.length && r32(off + 4) ? r32(off) / r32(off + 4) : undefined
    }
    if (tag === 0x011a) x = rational()
    else if (tag === 0x011b) y = rational()
    else if (tag === 0x0128) unit = r16(e + 8)
  }
  if (!x || !y || unit === 1) return undefined
  const k = unit === 3 ? 2.54 : 1
  return { x: x * k, y: y * k, source: 'Exif' }
}
