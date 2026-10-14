// 検査にかかる時間を測る（README の「検査の実測」）。`npm run bench` で実行する。
// 手元の原稿は載せられないので、同じ形の PDF をここで組み立てて測る。毎回同じ中身になるよう乱数の種を固定している。
// ブラウザではなく Node で測る（自前の読み取り・判定は同じコードで、pdf.js は Node 用の版を使う）。
import { checkDocument } from '../src/check/rules.ts'
import { extractTexts } from '../src/check/text.ts'
import { inspectPdf } from '../src/pdf/inspect.ts'
import { PRINTERS } from '../src/specs/index.ts'
import { flate, mm, PdfBuilder } from './pdf-builder.ts'

const RUNS = 5

let seed = 11
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647

/** 小説の本文: 1ページに 18 行の文と下の余白のノンブル。書体は1つ（埋め込みなし） */
function novel(pages: number): Uint8Array {
  const b = new PdfBuilder()
  const root = b.reserve()
  const parent = b.reserve()
  const font = b.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const kids: number[] = []
  for (let n = 1; n <= pages; n++) {
    let ops = 'BT /F1 9 Tf 14 TL ' + `${mm(20)} ${mm(190)} Td `
    for (let line = 0; line < 18; line++) {
      const words = Array.from({ length: 9 }, () => 'lorem ipsum dolor sit amet'.split(' ')[Math.floor(rnd() * 5)]).join(' ')
      ops += `(${words} ${n * 100 + line}) Tj T* `
    }
    ops += `ET BT /F1 8 Tf ${mm(77)} ${mm(11)} Td (${n}) Tj ET`
    const c = b.add('<< /Filter /FlateDecode >>', flate(ops))
    kids.push(b.add(`<< /Type /Page /Parent ${parent} 0 R /MediaBox [0 0 ${mm(154)} ${mm(216)}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c} 0 R >>`))
  }
  b.set(root, `<< /Type /Catalog /Pages ${parent} 0 R >>`)
  b.set(parent, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${pages} >>`)
  return b.build(root, { compressed: true })
}

/**
 * 漫画の本文: 1ページに1枚、塗り足し込み A5 全面のグレースケール画像（600dpi 相当の画素数）。
 * 画像の中身は検査では展開しないので、1MB の乱数を JPEG のつもりで埋め込み、ファイルの大きさだけ実物に近づける
 */
function comic(pages: number): Uint8Array {
  const b = new PdfBuilder()
  const root = b.reserve()
  const parent = b.reserve()
  const kids: number[] = []
  const data = new Uint8Array(1024 * 1024)
  for (let n = 1; n <= pages; n++) {
    for (let i = 0; i < data.length; i += 4) data[i] = Math.floor(rnd() * 256)
    const im = b.add('<< /Type /XObject /Subtype /Image /Width 3638 /Height 5102 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode >>', data.slice())
    const c = b.add('<< >>', `q ${mm(154)} 0 0 ${mm(216)} 0 0 cm /Im0 Do Q`)
    kids.push(b.add(`<< /Type /Page /Parent ${parent} 0 R /MediaBox [0 0 ${mm(154)} ${mm(216)}] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${c} 0 R >>`))
  }
  b.set(root, `<< /Type /Catalog /Pages ${parent} 0 R >>`)
  b.set(parent, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${pages} >>`)
  return b.build(root, { compressed: true })
}

async function median(fn: () => Promise<unknown>): Promise<{ med: number; min: number; max: number }> {
  await fn() // 1回空打ちして、読み込みや最適化の影響を除く
  const t: number[] = []
  for (let i = 0; i < RUNS; i++) {
    const s = performance.now()
    await fn()
    t.push(performance.now() - s)
  }
  t.sort((a, b) => a - b)
  return { med: t[Math.floor(RUNS / 2)], min: t[0], max: t[RUNS - 1] }
}

const fmt = (r: { med: number; min: number; max: number }) => `${Math.round(r.med)} ms（${Math.round(r.min)}〜${Math.round(r.max)}）`

async function main() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const opts = { printer: PRINTERS.find((p) => p.id === 'ryokuyou')!, formatId: 'A5', part: 'body' as const, ink: 'mono' as const, binding: 'perfect' as const }
  const cases: [string, Uint8Array][] = [
    ['小説 A5 100ページ', novel(100)],
    ['小説 A5 300ページ', novel(300)],
    ['漫画 A5 40ページ（画像 1MB × 40）', comic(40)],
  ]
  console.log('| 原稿 | ファイル | 構造の読み取り | 文字の取り出し（pdf.js） | 判定 |')
  console.log('|---|---|---|---|---|')
  for (const [label, bytes] of cases) {
    const read = await median(() => inspectPdf(bytes))
    const facts = await inspectPdf(bytes)
    let texts: Awaited<ReturnType<typeof extractTexts>> = []
    const text = await median(async () => {
      const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 })
      texts = await extractTexts((await task.promise) as never)
      await task.destroy()
    })
    const judge = await median(async () => checkDocument(facts, opts, texts))
    const size = bytes.length >= 1024 * 1024 ? `${(bytes.length / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes.length / 1024)} KB`
    console.log(`| ${label} | ${size} | ${fmt(read)} | ${fmt(text)} | ${fmt(judge)} |`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
