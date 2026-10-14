// 画面の「見本で試す」で開く、わざと不備を入れた A5 本文の PDF を書き出す。
// 公開版は通信を CSP で禁止しているので、見本は fetch せずビルド時に JS へ埋め込む（src に置くのはそのため）
import { mkdirSync, writeFileSync } from 'node:fs'
import { flate, mm, PdfBuilder } from './pdf-builder.ts'

const b = new PdfBuilder()
const root = b.reserve()
const pages = b.reserve()

// 300×300px の RGB のグラデーションを 80mm 角に置く → 約 95dpi（解像度不足・RGB）
const px = 300
const rgb = new Uint8Array(px * px * 3)
for (let y = 0; y < px; y++) {
  for (let x = 0; x < px; x++) {
    const i = (y * px + x) * 3
    rgb[i] = 230
    rgb[i + 1] = Math.round(80 + (x / px) * 120)
    rgb[i + 2] = Math.round(60 + (y / px) * 160)
  }
}
const image = b.add(`<< /Type /XObject /Subtype /Image /Width ${px} /Height ${px} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode >>`, flate(rgb))
// 埋め込まれていない和文フォント（文字は表示の確認用に欧文だけ書く）
const font = b.add('<< /Type /Font /Subtype /TrueType /BaseFont /MS-Mincho /FirstChar 32 /LastChar 126 /Encoding /WinAnsiEncoding >>')

// ノンブルは1・2ページにだけ入れ、3ページ目は入れ忘れたことにする（仕上がりの下端から 8mm、左右の中央）
const nombre = (n: number) => `0 g BT /F1 9 Tf ${mm(3 + 72)} ${mm(3 + 8)} Td (${n}) Tj ET`

const bleedW = mm(154)
const bleedH = mm(216)
const res = `<< /XObject << /Im0 ${image} 0 R >> /Font << /F1 ${font} 0 R >> >>`
const p1 = b.add(
  `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${bleedW} ${bleedH}] /Resources ${res} /Contents ${b.add(
    '<< >>',
    `q ${mm(80)} 0 0 ${mm(80)} ${mm(37)} ${mm(90)} cm /Im0 Do Q\n0 g BT /F1 14 Tf ${mm(37)} ${mm(60)} Td (tonbo sample - page 1) Tj ET
${nombre(1)}`,
  )} 0 R >>`,
)
const p2 = b.add(
  `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${bleedW} ${bleedH}] /Resources ${res} /Contents ${b.add(
    '<< >>',
    `0.9 0.2 0.3 rg ${mm(20)} ${mm(150)} ${mm(114)} ${mm(30)} re f\n0 g BT /F1 14 Tf ${mm(20)} ${mm(120)} Td (RGB red box above) Tj ET
${nombre(2)}`,
  )} 0 R >>`,
)
// 3ページ目だけ塗り足しのない大きさ
const p3 = b.add(
  `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${mm(148)} ${mm(210)}] /Resources ${res} /Contents ${b.add(
    '<< >>',
    `0 g BT /F1 14 Tf ${mm(20)} ${mm(100)} Td (no bleed on this page) Tj ET`,
  )} 0 R >>`,
)
b.set(root, `<< /Type /Catalog /Pages ${pages} 0 R >>`)
b.set(pages, `<< /Type /Pages /Kids [${p1} 0 R ${p2} 0 R ${p3} 0 R] /Count 3 >>`)

mkdirSync('src/samples', { recursive: true })
writeFileSync('src/samples/sample-a5-ng.pdf', b.build(root, { compressed: true }))
console.log('src/samples/sample-a5-ng.pdf')
