/**
 * PDF ファイルから、番号を指定してオブジェクトを取り出せるようにする。
 * 相互参照（xref）は表形式と stream 形式（PDF 1.5〜）の両方を読み、/Prev で追記分もたどる。
 * xref が壊れているファイルも入稿データには珍しくないので、そのときは「n g obj」を全体から探し直す。
 */
import {
  isDict,
  isName,
  isRef,
  isStream,
  latin1,
  Lexer,
  PdfSyntaxError,
  type PdfDict,
  type PdfStream,
  type PdfValue,
} from './objects.ts'

type XrefEntry = { type: 'offset'; offset: number } | { type: 'compressed'; streamNum: number; index: number }

export class PdfDocument {
  readonly bytes: Uint8Array
  readonly trailer: PdfDict
  /** xref を読めず、全体を走査して組み立て直したか（壊れたファイルの目印として利用者にも伝える） */
  readonly repaired: boolean
  readonly version: string
  private readonly xref: Map<number, XrefEntry>
  private readonly cache = new Map<number, PdfValue>()
  private readonly objStreams = new Map<number, Map<number, PdfValue>>()

  private constructor(bytes: Uint8Array, xref: Map<number, XrefEntry>, trailer: PdfDict, repaired: boolean) {
    this.bytes = bytes
    this.xref = xref
    this.trailer = trailer
    this.repaired = repaired
    this.version = /%PDF-(\d\.\d)/.exec(latin1(bytes.subarray(0, 1024)))?.[1] ?? ''
  }

  static async open(bytes: Uint8Array): Promise<PdfDocument> {
    if (!latin1(bytes.subarray(0, 1024)).includes('%PDF-')) throw new PdfSyntaxError('PDF ファイルではない')
    try {
      const { xref, trailer } = await readXrefChain(bytes)
      // 保護（暗号化）された PDF は、文字列と stream の中身が暗号になっていて読めない。
      // 読み進めると的外れな結果になるので、ここで止めて利用者に伝える
      if (trailer.has('Encrypt')) throw new PdfEncryptedError()
      // xref の位置がずれていると、別のオブジェクトを読んでしまっても気づけない。
      // 各位置が「その番号 世代 obj」で始まっているかを先に全部確かめる（数字を2つ読むだけなので軽い）
      for (const [num, e] of xref) {
        if (e.type !== 'offset') continue
        const lx = new Lexer(bytes, e.offset)
        if (lx.next() !== num || typeof lx.next() !== 'number' || !lx.expectWord('obj')) throw new PdfSyntaxError(`${num} 番の位置がずれている`)
      }
      const doc = new PdfDocument(bytes, xref, trailer, false)
      const root = await doc.getDict(trailer.get('Root'))
      if (!root || !isName(root.get('Type'), 'Catalog')) throw new PdfSyntaxError('Root が Catalog でない')
      return doc
    } catch (e) {
      if (e instanceof PdfEncryptedError) throw e
      const { xref, trailer } = await scanObjects(bytes)
      if (trailer.has('Encrypt')) throw new PdfEncryptedError()
      return new PdfDocument(bytes, xref, trailer, true)
    }
  }

  /** 参照なら中身まで解決し、そうでなければそのまま返す */
  async get(v: PdfValue | undefined): Promise<PdfValue> {
    if (v === undefined) return null
    if (!isRef(v)) return v
    return this.object(v.num)
  }

  async getDict(v: PdfValue | undefined): Promise<PdfDict | undefined> {
    const r = await this.get(v)
    if (isDict(r)) return r
    if (isStream(r)) return r.dict
    return undefined
  }

  async object(num: number): Promise<PdfValue> {
    if (this.cache.has(num)) return this.cache.get(num)!
    const e = this.xref.get(num)
    let v: PdfValue = null
    if (e?.type === 'offset') v = await this.readAt(e.offset)
    else if (e?.type === 'compressed') v = (await this.objectStream(e.streamNum)).get(num) ?? null
    this.cache.set(num, v)
    return v
  }

  private async readAt(offset: number): Promise<PdfValue> {
    const lx = new Lexer(this.bytes, offset)
    lx.next() // 番号
    lx.next() // 世代
    if (!lx.expectWord('obj')) throw new PdfSyntaxError(`${offset} に obj がない`)
    const v = lx.next() as PdfValue
    if (isDict(v) && lx.expectWord('stream')) return { kind: 'stream', dict: v, raw: await this.streamBody(lx, v) }
    return v
  }

  private async streamBody(lx: Lexer, dict: PdfDict): Promise<Uint8Array> {
    const b = this.bytes
    // stream の直後は CRLF か LF（CR だけのファイルもある）
    let start = lx.pos
    if (b[start] === 13) start++
    if (b[start] === 10) start++
    const lenV = dict.get('Length')
    const len = isRef(lenV) ? await this.object(lenV.num) : lenV
    if (typeof len === 'number' && start + len <= b.length && endstreamFollows(b, start + len)) return b.subarray(start, start + len)
    // Length が誤っている入稿データがあるので、endstream を探して長さを決め直す
    const end = indexOf(b, 'endstream', start)
    if (end < 0) throw new PdfSyntaxError('endstream がない')
    let stop = end
    if (b[stop - 1] === 10) stop--
    if (b[stop - 1] === 13) stop--
    return b.subarray(start, stop)
  }

  private async objectStream(num: number): Promise<Map<number, PdfValue>> {
    let m = this.objStreams.get(num)
    if (m) return m
    m = new Map()
    this.objStreams.set(num, m)
    const s = await this.object(num)
    if (!isStream(s)) return m
    const data = await this.decode(s)
    const n = Number(s.dict.get('N'))
    const first = Number(s.dict.get('First'))
    const head = new Lexer(data)
    const pairs: [number, number][] = []
    for (let i = 0; i < n; i++) pairs.push([head.next() as number, head.next() as number])
    for (const [objNum, off] of pairs) {
      try {
        m.set(objNum, new Lexer(data, first + off).next() as PdfValue)
      } catch {
        m.set(objNum, null)
      }
    }
    return m
  }

  /** stream の中身をフィルターに従って展開する。画像の JPEG などは展開せず、検査に必要な分だけ扱う */
  async decode(s: PdfStream): Promise<Uint8Array> {
    const filters = await this.asArray(s.dict.get('Filter'))
    const params = await this.asArray(s.dict.get('DecodeParms') ?? s.dict.get('DP'))
    let data = s.raw
    for (const [i, f] of filters.entries()) {
      const fname = isName(f) ? f.name : ''
      const p = await this.getDict(params[i])
      if (fname === 'FlateDecode' || fname === 'Fl') data = await inflate(data)
      else if (fname === 'ASCIIHexDecode' || fname === 'AHx') data = asciiHex(data)
      else if (fname === 'ASCII85Decode' || fname === 'A85') data = ascii85(data)
      else throw new UnsupportedFilter(fname)
      if (p) data = unpredict(data, p)
    }
    return data
  }

  private async asArray(v: PdfValue | undefined): Promise<PdfValue[]> {
    const r = await this.get(v)
    if (r === null) return []
    return Array.isArray(r) ? r : [r]
  }
}

export class PdfEncryptedError extends Error {
  constructor() {
    super('保護（暗号化）のかかった PDF')
  }
}

export class UnsupportedFilter extends Error {
  readonly filter: string
  constructor(filter: string) {
    super(`未対応の圧縮形式 ${filter}`)
    this.filter = filter
  }
}

function indexOf(b: Uint8Array, s: string, from: number): number {
  const first = s.charCodeAt(0)
  outer: for (let i = b.indexOf(first, from); i >= 0 && i <= b.length - s.length; i = b.indexOf(first, i + 1)) {
    for (let j = 1; j < s.length; j++) if (b[i + j] !== s.charCodeAt(j)) continue outer
    return i
  }
  return -1
}

function lastIndexOf(b: Uint8Array, s: string): number {
  for (let i = b.length - s.length; i >= 0; i--) {
    let ok = true
    for (let j = 0; j < s.length && ok; j++) ok = b[i + j] === s.charCodeAt(j)
    if (ok) return i
  }
  return -1
}

function endstreamFollows(b: Uint8Array, at: number): boolean {
  const lx = new Lexer(b, at)
  lx.skipSpace()
  return latin1(b.subarray(lx.pos, lx.pos + 9)) === 'endstream'
}

async function readXrefChain(bytes: Uint8Array): Promise<{ xref: Map<number, XrefEntry>; trailer: PdfDict }> {
  const sx = lastIndexOf(bytes.subarray(Math.max(0, bytes.length - 2048)), 'startxref')
  if (sx < 0) throw new PdfSyntaxError('startxref がない')
  const lx = new Lexer(bytes, Math.max(0, bytes.length - 2048) + sx + 9)
  let offset = lx.next() as number
  const xref = new Map<number, XrefEntry>()
  let trailer: PdfDict | undefined
  const seen = new Set<number>()
  while (typeof offset === 'number' && !seen.has(offset)) {
    seen.add(offset)
    // 後から追記された xref が優先されるので、先に読んだ番号は上書きしない
    const part = await readXref(bytes, offset)
    for (const [k, v] of part.entries) if (!xref.has(k)) xref.set(k, v)
    trailer ??= part.trailer
    // 表形式と stream 形式を併用したファイル（ハイブリッド）は XRefStm に stream 側がある
    const stm = part.trailer.get('XRefStm')
    if (typeof stm === 'number' && !seen.has(stm)) {
      seen.add(stm)
      for (const [k, v] of (await readXref(bytes, stm)).entries) if (!xref.has(k)) xref.set(k, v)
    }
    offset = part.trailer.get('Prev') as number
  }
  if (!trailer) throw new PdfSyntaxError('trailer がない')
  return { xref, trailer }
}

async function readXref(bytes: Uint8Array, offset: number): Promise<{ entries: Map<number, XrefEntry>; trailer: PdfDict }> {
  const lx = new Lexer(bytes, offset)
  const entries = new Map<number, XrefEntry>()
  if (lx.expectWord('xref')) {
    for (;;) {
      if (lx.expectWord('trailer')) {
        const t = lx.next()
        if (!isDict(t)) throw new PdfSyntaxError('trailer が辞書でない')
        return { entries, trailer: t }
      }
      const start = lx.next()
      const count = lx.next()
      if (typeof start !== 'number' || typeof count !== 'number') throw new PdfSyntaxError('xref の見出しが読めない')
      for (let i = 0; i < count; i++) {
        const off = lx.next() as number
        lx.next()
        // 'n'（使用中）と 'f'（空き）は値として読めない語なので、1文字を直接見る
        lx.skipSpace()
        const flag = bytes[lx.pos++]
        if (flag === 0x6e /* n */ && off > 0) entries.set(start + i, { type: 'offset', offset: off })
      }
    }
  }
  // stream 形式の xref
  lx.pos = offset
  lx.next()
  lx.next()
  if (!lx.expectWord('obj')) throw new PdfSyntaxError('xref の位置に obj がない')
  const dict = lx.next()
  if (!isDict(dict) || !lx.expectWord('stream')) throw new PdfSyntaxError('xref stream が読めない')
  const len = dict.get('Length')
  let start = lx.pos
  if (bytes[start] === 13) start++
  if (bytes[start] === 10) start++
  if (typeof len !== 'number') throw new PdfSyntaxError('xref stream の Length が参照になっている')
  let data = bytes.subarray(start, start + len)
  if (isName(dict.get('Filter'), 'FlateDecode')) data = await inflate(data)
  const parms = dict.get('DecodeParms')
  if (isDict(parms)) data = unpredict(data, parms)
  const w = (dict.get('W') as number[]).map(Number)
  const size = Number(dict.get('Size'))
  const index = (dict.get('Index') as number[] | undefined) ?? [0, size]
  const rowLen = w[0] + w[1] + w[2]
  let row = 0
  for (let s = 0; s < index.length; s += 2) {
    for (let i = 0; i < index[s + 1]; i++, row++) {
      const at = row * rowLen
      if (at + rowLen > data.length) break
      const field = (from: number, n: number) => {
        let v = 0
        for (let k = 0; k < n; k++) v = v * 256 + data[at + from + k]
        return v
      }
      // W の1番目が 0 なら種類は省略されていて、既定は 1（ファイル内の位置）
      const type = w[0] === 0 ? 1 : field(0, w[0])
      const a = field(w[0], w[1])
      const b2 = field(w[0] + w[1], w[2])
      const num = index[s] + i
      if (type === 1) entries.set(num, { type: 'offset', offset: a })
      else if (type === 2) entries.set(num, { type: 'compressed', streamNum: a, index: b2 })
    }
  }
  return { entries, trailer: dict }
}

/** xref が使えないとき、「n g obj」を先頭から全部探して位置の表を作り直す */
async function scanObjects(bytes: Uint8Array): Promise<{ xref: Map<number, XrefEntry>; trailer: PdfDict }> {
  const xref = new Map<number, XrefEntry>()
  const text = latin1(bytes)
  const re = /(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const at = m.index + (m[0].length - m[0].trimStart().length)
    xref.set(Number(m[1]), { type: 'offset', offset: at })
  }
  // trailer 辞書は最後のものを使う。なければ Catalog を探して Root にする
  let trailer: PdfDict | undefined
  for (let at = text.lastIndexOf('trailer'); at >= 0 && !trailer; at = text.lastIndexOf('trailer', at - 1)) {
    try {
      const t = new Lexer(bytes, at + 7).next()
      if (isDict(t) && t.has('Root')) trailer = t
    } catch {
      // 次の候補へ
    }
  }
  // trailer の Root が走査で見つけた位置で Catalog を指していなければ、Catalog を探し直す
  if (trailer && isRef(trailer.get('Root'))) {
    const e = xref.get((trailer.get('Root') as { num: number }).num)
    let ok = false
    if (e?.type === 'offset') {
      try {
        const lx = new Lexer(bytes, e.offset)
        lx.next()
        lx.next()
        lx.expectWord('obj')
        const v = lx.next()
        ok = isDict(v) && isName(v.get('Type'), 'Catalog')
      } catch {
        // 読めなければ探し直す
      }
    }
    if (!ok && e?.type === 'offset') trailer = new Map([...trailer].filter(([k]) => k !== 'Root'))
  }
  trailer ??= new Map()
  // 圧縮されたオブジェクト（ObjStm）の中身も表に入れ、trailer がなければ Catalog を Root にする
  // 走査中に足す ObjStm 内の項目は compressed なので、この繰り返しでは飛ばされる
  for (const [num, e] of xref) {
    if (e.type !== 'offset') continue
    try {
      const lx = new Lexer(bytes, e.offset)
      lx.next()
      lx.next()
      lx.expectWord('obj')
      const v = lx.next()
      if (!isDict(v)) continue
      if (isName(v.get('Type'), 'Catalog') && !trailer.has('Root')) trailer.set('Root', { kind: 'ref', num, gen: 0 })
      if (isName(v.get('Type'), 'XRef') && v.has('Encrypt')) trailer.set('Encrypt', v.get('Encrypt')!)
      if (isName(v.get('Type'), 'ObjStm') && lx.expectWord('stream')) {
        for (const [objNum, index] of await objStmNumbers(bytes, lx.pos, v)) {
          if (!xref.has(objNum)) xref.set(objNum, { type: 'compressed', streamNum: num, index })
        }
      }
    } catch {
      // 壊れたオブジェクトは飛ばす
    }
  }
  // Catalog が ObjStm の中にしかないファイルもある
  if (!trailer.has('Root')) {
    for (const [num, e] of xref) {
      if (e.type !== 'compressed') continue
      const v = await readCompressed(bytes, xref, e)
      if (isDict(v) && isName(v.get('Type'), 'Catalog')) {
        trailer.set('Root', { kind: 'ref', num, gen: 0 })
        break
      }
    }
  }
  if (!trailer.has('Root')) throw new PdfSyntaxError('Root が見つからない')
  return { xref, trailer }
}

async function objStmBody(bytes: Uint8Array, at: number, dict: PdfDict): Promise<Uint8Array> {
  let start = at
  if (bytes[start] === 13) start++
  if (bytes[start] === 10) start++
  const end = indexOf(bytes, 'endstream', start)
  const data = bytes.subarray(start, end < 0 ? bytes.length : end)
  return isName(dict.get('Filter'), 'FlateDecode') ? inflate(data) : data
}

/** ObjStm の見出し（番号と位置の組）から、入っているオブジェクトの番号を読む */
async function objStmNumbers(bytes: Uint8Array, at: number, dict: PdfDict): Promise<[number, number][]> {
  const head = new Lexer(await objStmBody(bytes, at, dict))
  const out: [number, number][] = []
  for (let i = 0; i < Number(dict.get('N')); i++) {
    const objNum = head.next() as number
    head.next()
    out.push([objNum, i])
  }
  return out
}

async function readCompressed(bytes: Uint8Array, xref: Map<number, XrefEntry>, e: XrefEntry & { type: 'compressed' }): Promise<PdfValue> {
  const s = xref.get(e.streamNum)
  if (s?.type !== 'offset') return null
  try {
    const lx = new Lexer(bytes, s.offset)
    lx.next()
    lx.next()
    lx.expectWord('obj')
    const dict = lx.next()
    if (!isDict(dict) || !lx.expectWord('stream')) return null
    const data = await objStmBody(bytes, lx.pos, dict)
    const head = new Lexer(data)
    let off = 0
    for (let i = 0; i <= e.index; i++) {
      head.next()
      off = head.next() as number
    }
    return new Lexer(data, Number(dict.get('First')) + off).next() as PdfValue
  } catch {
    return null
  }
}

export async function inflate(data: Uint8Array): Promise<Uint8Array> {
  // 末尾が欠けた（Length が短い）圧縮データでも、展開できた分は使う
  const ds = new DecompressionStream('deflate')
  const writer = ds.writable.getWriter()
  writer.write(data as Uint8Array<ArrayBuffer>).catch(() => {})
  writer.close().catch(() => {})
  const reader = ds.readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.length
    }
  } catch {
    if (total === 0) throw new PdfSyntaxError('圧縮データを展開できない')
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

function asciiHex(data: Uint8Array): Uint8Array {
  const s = latin1(data).replace(/>.*$/s, '').replace(/[^0-9a-fA-F]/g, '')
  const even = s.length % 2 ? s + '0' : s
  const out = new Uint8Array(even.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(even.slice(i * 2, i * 2 + 2), 16)
  return out
}

function ascii85(data: Uint8Array): Uint8Array {
  const s = latin1(data).replace(/^<~/, '').replace(/~>.*$/s, '').replace(/\s/g, '')
  const out: number[] = []
  let group: number[] = []
  const flush = (n: number) => {
    while (group.length < 5) group.push(84)
    let v = 0
    for (const g of group) v = v * 85 + g
    for (let i = 0; i < n; i++) out.push((v >>> (24 - i * 8)) & 0xff)
    group = []
  }
  for (const ch of s) {
    if (ch === 'z' && group.length === 0) out.push(0, 0, 0, 0)
    else {
      group.push(ch.charCodeAt(0) - 33)
      if (group.length === 5) flush(4)
    }
  }
  if (group.length) flush(group.length - 1)
  return Uint8Array.from(out)
}

/** PNG 予測子（Predictor 10〜15）を戻す。xref stream はほぼ必ずこれで圧縮されている */
function unpredict(data: Uint8Array, p: PdfDict): Uint8Array {
  const predictor = Number(p.get('Predictor') ?? 1)
  if (predictor < 10) return data
  const colors = Number(p.get('Colors') ?? 1)
  const bpc = Number(p.get('BitsPerComponent') ?? 8)
  const columns = Number(p.get('Columns') ?? 1)
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8))
  const rowLen = Math.ceil((colors * bpc * columns) / 8)
  const rows = Math.floor(data.length / (rowLen + 1))
  const out = new Uint8Array(rows * rowLen)
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)]
    const src = r * (rowLen + 1) + 1
    const dst = r * rowLen
    for (let i = 0; i < rowLen; i++) {
      const raw = data[src + i]
      const left = i >= bpp ? out[dst + i - bpp] : 0
      const up = r > 0 ? out[dst - rowLen + i] : 0
      const upLeft = r > 0 && i >= bpp ? out[dst - rowLen + i - bpp] : 0
      let v = raw
      if (type === 1) v = raw + left
      else if (type === 2) v = raw + up
      else if (type === 3) v = raw + ((left + up) >> 1)
      else if (type === 4) {
        const pa = Math.abs(up - upLeft)
        const pb = Math.abs(left - upLeft)
        const pc = Math.abs(left + up - 2 * upLeft)
        v = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)
      }
      out[dst + i] = v & 0xff
    }
  }
  return out
}
