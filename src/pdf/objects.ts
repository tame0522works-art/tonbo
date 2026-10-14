/**
 * PDF のオブジェクト（数値・文字列・名前・配列・辞書・参照・stream）を字句から組み立てる。
 * ページの描画命令（content stream）も同じ字句で書かれているので、Lexer は両方で使う。
 */

export type PdfRef = { readonly kind: 'ref'; readonly num: number; readonly gen: number }
export type PdfName = { readonly kind: 'name'; readonly name: string }
export type PdfString = { readonly kind: 'string'; readonly bytes: Uint8Array }
export type PdfDict = Map<string, PdfValue>
export type PdfStream = { readonly kind: 'stream'; readonly dict: PdfDict; readonly raw: Uint8Array }
export type PdfValue = null | boolean | number | PdfName | PdfString | PdfRef | PdfValue[] | PdfDict | PdfStream

/** 描画命令の演算子（q・cm・Do など）。オブジェクトの中には出てこない */
export type PdfOperator = { readonly kind: 'op'; readonly op: string }

export const ref = (num: number, gen: number): PdfRef => ({ kind: 'ref', num, gen })
export const name = (n: string): PdfName => ({ kind: 'name', name: n })

export const isRef = (v: unknown): v is PdfRef => typeof v === 'object' && v !== null && (v as PdfRef).kind === 'ref'
export const isName = (v: unknown, n?: string): v is PdfName =>
  typeof v === 'object' && v !== null && (v as PdfName).kind === 'name' && (n === undefined || (v as PdfName).name === n)
export const isString = (v: unknown): v is PdfString => typeof v === 'object' && v !== null && (v as PdfString).kind === 'string'
export const isStream = (v: unknown): v is PdfStream => typeof v === 'object' && v !== null && (v as PdfStream).kind === 'stream'
export const isDict = (v: unknown): v is PdfDict => v instanceof Map
export const isOperator = (v: unknown): v is PdfOperator => typeof v === 'object' && v !== null && (v as PdfOperator).kind === 'op'

const WHITE = new Set([0, 9, 10, 12, 13, 32])
const DELIM = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)))
const isRegular = (b: number) => !WHITE.has(b) && !DELIM.has(b)

export class PdfSyntaxError extends Error {}

export class Lexer {
  pos: number
  readonly bytes: Uint8Array
  constructor(bytes: Uint8Array, pos = 0) {
    this.bytes = bytes
    this.pos = pos
  }

  skipSpace(): void {
    const b = this.bytes
    while (this.pos < b.length) {
      const c = b[this.pos]
      if (WHITE.has(c)) this.pos++
      else if (c === 0x25 /* % */) {
        while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++
      } else break
    }
  }

  /** 空白や区切りまでの1語（数値・true・obj・演算子など）を ASCII で返す */
  private word(): string {
    const start = this.pos
    while (this.pos < this.bytes.length && isRegular(this.bytes[this.pos])) this.pos++
    return latin1(this.bytes.subarray(start, this.pos))
  }

  /**
   * 次の値を1つ読む。「1 0 R」は参照としてまとめる。
   * 描画命令の中では演算子も返し、オブジェクトの中では演算子が出たら構文エラーとして扱う。
   * 終わりに達したら undefined。
   */
  next(allowOperators = false): PdfValue | PdfOperator | undefined {
    this.skipSpace()
    const b = this.bytes
    if (this.pos >= b.length) return undefined
    const c = b[this.pos]
    if (c === 0x2f /* / */) {
      this.pos++
      return name(decodeName(this.word()))
    }
    if (c === 0x28 /* ( */) return this.literalString()
    if (c === 0x3c /* < */) {
      if (b[this.pos + 1] === 0x3c) {
        this.pos += 2
        return this.dict(allowOperators)
      }
      return this.hexString()
    }
    if (c === 0x5b /* [ */) {
      this.pos++
      const arr: PdfValue[] = []
      for (;;) {
        this.skipSpace()
        if (this.pos >= b.length) throw new PdfSyntaxError('配列が閉じていない')
        if (b[this.pos] === 0x5d) {
          this.pos++
          return arr
        }
        const v = this.next(allowOperators)
        if (isOperator(v)) throw new PdfSyntaxError(`配列の中に演算子 ${v.op}`)
        arr.push(v as PdfValue)
      }
    }
    if (c === 0x5d || c === 0x3e || c === 0x29 || c === 0x7b || c === 0x7d) {
      // 対応の取れない閉じ括弧などは1文字の演算子として返し、呼び出し側に判断させる
      this.pos++
      if (allowOperators) return { kind: 'op', op: String.fromCharCode(c) }
      throw new PdfSyntaxError(`予期しない文字 ${String.fromCharCode(c)}`)
    }
    const w = this.word()
    if (w === '') {
      this.pos++
      throw new PdfSyntaxError(`読めない文字 0x${c.toString(16)}`)
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) {
      const n = Number(w)
      // 「整数 整数 R」なら参照。先読みして違えば位置を戻す
      if (/^\d+$/.test(w)) {
        const save = this.pos
        this.skipSpace()
        const w2 = this.word()
        if (/^\d+$/.test(w2)) {
          this.skipSpace()
          if (this.bytes[this.pos] === 0x52 /* R */ && !isRegular(this.bytes[this.pos + 1] ?? 32)) {
            this.pos++
            return ref(n, Number(w2))
          }
        }
        this.pos = save
      }
      return n
    }
    // 「--1」のような壊れた数値を書く作成ソフトがあるので、数値として読めるものは読む
    if (/^[+-]+\d/.test(w)) return Number(w.replace(/^[+-]+(?=[+-])/, '')) || 0
    if (w === 'true') return true
    if (w === 'false') return false
    if (w === 'null') return null
    if (allowOperators) return { kind: 'op', op: w }
    throw new PdfSyntaxError(`予期しない語 ${w}`)
  }

  private dict(allowOperators: boolean): PdfDict {
    const d: PdfDict = new Map()
    for (;;) {
      this.skipSpace()
      if (this.pos >= this.bytes.length) throw new PdfSyntaxError('辞書が閉じていない')
      if (this.bytes[this.pos] === 0x3e && this.bytes[this.pos + 1] === 0x3e) {
        this.pos += 2
        return d
      }
      const key = this.next(allowOperators)
      if (!isName(key)) throw new PdfSyntaxError('辞書のキーが名前でない')
      this.skipSpace()
      // 値が欠けた「/Key >>」を書く作成ソフトがあるので、null として扱う
      if (this.bytes[this.pos] === 0x3e && this.bytes[this.pos + 1] === 0x3e) {
        d.set(key.name, null)
        continue
      }
      const v = this.next(allowOperators)
      if (isOperator(v)) throw new PdfSyntaxError(`辞書の中に演算子 ${v.op}`)
      d.set(key.name, v as PdfValue)
    }
  }

  private literalString(): PdfString {
    const b = this.bytes
    this.pos++
    const out: number[] = []
    let depth = 1
    while (this.pos < b.length) {
      const c = b[this.pos++]
      if (c === 0x5c /* \ */) {
        const e = b[this.pos++]
        const simple: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c }
        if (e in simple) out.push(simple[e])
        else if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30
          for (let i = 0; i < 2 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37; i++) v = v * 8 + (b[this.pos++] - 0x30)
          out.push(v & 0xff)
        } else if (e === 13) {
          if (b[this.pos] === 10) this.pos++
        } else if (e !== 10) out.push(e)
      } else if (c === 0x28) {
        depth++
        out.push(c)
      } else if (c === 0x29) {
        if (--depth === 0) return { kind: 'string', bytes: Uint8Array.from(out) }
        out.push(c)
      } else out.push(c)
    }
    throw new PdfSyntaxError('文字列が閉じていない')
  }

  private hexString(): PdfString {
    const b = this.bytes
    this.pos++
    const digits: number[] = []
    while (this.pos < b.length && b[this.pos] !== 0x3e) {
      const v = hexValue(b[this.pos++])
      if (v >= 0) digits.push(v)
    }
    this.pos++
    if (digits.length % 2) digits.push(0)
    const out = new Uint8Array(digits.length / 2)
    for (let i = 0; i < out.length; i++) out[i] = (digits[i * 2] << 4) | digits[i * 2 + 1]
    return { kind: 'string', bytes: out }
  }

  /** 次が指定の語（obj・stream など）なら読み進めて true */
  expectWord(w: string): boolean {
    this.skipSpace()
    const save = this.pos
    if (this.word() === w) return true
    this.pos = save
    return false
  }
}

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30
  if (c >= 0x41 && c <= 0x46) return c - 0x37
  if (c >= 0x61 && c <= 0x66) return c - 0x57
  return -1
}

function decodeName(raw: string): string {
  // 名前の中の #xx は1バイト。日本語のフォント名は UTF-8 や Shift_JIS のバイトが #xx で並ぶことがある
  if (!raw.includes('#')) return raw
  const bytes: number[] = []
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '#' && i + 2 < raw.length && hexValue(raw.charCodeAt(i + 1)) >= 0 && hexValue(raw.charCodeAt(i + 2)) >= 0) {
      bytes.push(parseInt(raw.slice(i + 1, i + 3), 16))
      i += 2
    } else bytes.push(raw.charCodeAt(i))
  }
  return latin1(Uint8Array.from(bytes))
}

export function latin1(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return s
}

/** フォント名など、#xx でバイトが並んだ名前を人が読める文字にする（UTF-8 として読めなければそのまま） */
export function displayName(n: string): string {
  if (!/[\x80-\xff]/.test(n)) return n
  const bytes = Uint8Array.from(n, (ch) => ch.charCodeAt(0))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    try {
      return new TextDecoder('shift_jis', { fatal: true }).decode(bytes)
    } catch {
      return n
    }
  }
}
