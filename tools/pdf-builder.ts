// 確認用の PDF を手で組み立てる。実在の作成ソフトが出す形（表形式の xref、xref stream と ObjStm、追記、壊れた xref）を再現するため
import { deflateSync } from 'node:zlib'

export type BuildOptions = {
  /** xref を stream 形式にし、stream 以外のオブジェクトを ObjStm にまとめる（PDF 1.5〜の作成ソフトがよく出す形） */
  compressed?: boolean
  /** xref の位置を全部ずらし、壊れたファイルを再現する */
  breakXref?: boolean
  /** trailer（stream 形式なら XRef の辞書）に足す項目。例: '/Encrypt 9 0 R' */
  trailerExtra?: string
}

type Obj = { body: string; stream?: Uint8Array }

export class PdfBuilder {
  private readonly objs: Obj[] = []

  /** オブジェクトを足して番号を返す。stream を渡すと Length は自動で入る */
  add(body: string, stream?: Uint8Array | string): number {
    this.objs.push({ body, stream: typeof stream === 'string' ? Buffer.from(stream, 'latin1') : stream })
    return this.objs.length
  }

  /** 番号だけ先に取り、中身は後で set する（ページと親の Pages が互いを指すため） */
  reserve(): number {
    this.objs.push({ body: 'null' })
    return this.objs.length
  }

  set(num: number, body: string, stream?: Uint8Array | string): void {
    this.objs[num - 1] = { body, stream: typeof stream === 'string' ? Buffer.from(stream, 'latin1') : stream }
  }

  build(root: number, opts: BuildOptions = {}): Uint8Array {
    const parts: Buffer[] = []
    let length = 0
    const push = (p: string | Uint8Array) => {
      const b = typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p)
      parts.push(b)
      length += b.length
    }
    push('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')
    const offsets = new Map<number, number>()
    const inStream = new Map<number, [number, number]>()
    const writeObj = (n: number, o: Obj) => {
      offsets.set(n, length)
      if (o.stream) {
        const dict = o.body.replace(/>>\s*$/, ` /Length ${o.stream.length} >>`)
        push(`${n} 0 obj\n${dict}\nstream\n`)
        push(o.stream)
        push('\nendstream\nendobj\n')
      } else push(`${n} 0 obj\n${o.body}\nendobj\n`)
    }
    let size = this.objs.length + 1
    if (opts.compressed) {
      const packed = this.objs.map((o, i) => ({ n: i + 1, o })).filter((x) => !x.o.stream)
      const stmNum = size++
      let head = ''
      let body = ''
      packed.forEach(({ n, o }, i) => {
        head += `${n} ${body.length} `
        body += o.body + '\n'
        inStream.set(n, [stmNum, i])
      })
      this.objs.forEach((o, i) => o.stream && writeObj(i + 1, o))
      const data = deflateSync(Buffer.from(head + body, 'latin1'))
      writeObj(stmNum, { body: `<< /Type /ObjStm /N ${packed.length} /First ${head.length} /Filter /FlateDecode >>`, stream: data })
      const xrefNum = size++
      // 各行は 種類1バイト・位置4バイト・番号2バイト。PNG の Up 予測子で圧縮する（実在の作成ソフトと同じ）
      const rows: number[][] = []
      for (let n = 0; n < size; n++) {
        if (n === xrefNum) rows.push([1, ...be(length, 4), 0, 0])
        else if (offsets.has(n)) rows.push([1, ...be(offsets.get(n)!, 4), 0, 0])
        else if (inStream.has(n)) rows.push([2, ...be(inStream.get(n)![0], 4), ...be(inStream.get(n)![1], 2)])
        else rows.push([0, 0, 0, 0, 0, 255, 255])
      }
      const predicted: number[] = []
      rows.forEach((r, i) => predicted.push(2, ...r.map((v, j) => (v - (i > 0 ? rows[i - 1][j] : 0)) & 0xff)))
      const xrefAt = length
      writeObj(xrefNum, {
        body: `<< /Type /XRef /Size ${size} /W [1 4 2] /Root ${root} 0 R ${opts.trailerExtra ?? ''} /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 7 >> >>`,
        stream: deflateSync(Buffer.from(predicted)),
      })
      push(`startxref\n${xrefAt}\n%%EOF\n`)
    } else {
      this.objs.forEach((o, i) => writeObj(i + 1, o))
      const xrefAt = length
      const shift = opts.breakXref ? 37 : 0
      let table = `xref\n0 ${size}\n0000000000 65535 f \n`
      for (let n = 1; n < size; n++) table += `${String(offsets.get(n)! + shift).padStart(10, '0')} 00000 n \n`
      push(table + `trailer\n<< /Size ${size} /Root ${root} 0 R ${opts.trailerExtra ?? ''} >>\nstartxref\n${xrefAt}\n%%EOF\n`)
    }
    return Buffer.concat(parts)
  }
}

function be(v: number, n: number): number[] {
  const out: number[] = []
  for (let i = n - 1; i >= 0; i--) out.push(Math.floor(v / 256 ** i) & 0xff)
  return out
}

/** 追記（インクリメンタル保存）を再現する。元のファイルの後ろに、差し替えたオブジェクトと /Prev つきの xref を足す */
export function appendUpdate(original: Uint8Array, root: number, size: number, replace: Map<number, string>): Uint8Array {
  const text = Buffer.from(original).toString('latin1')
  const prev = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1])
  let out = text
  const offsets = new Map<number, number>()
  for (const [n, body] of replace) {
    offsets.set(n, out.length)
    out += `${n} 0 obj\n${body}\nendobj\n`
  }
  const xrefAt = out.length
  out += 'xref\n0 1\n0000000000 65535 f \n'
  for (const [n, off] of offsets) out += `${n} 1\n${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${size} /Root ${root} 0 R /Prev ${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

export const flate = (s: string | Uint8Array) => deflateSync(typeof s === 'string' ? Buffer.from(s, 'latin1') : s)

export const mm = (v: number) => ((v * 72) / 25.4).toFixed(3)
