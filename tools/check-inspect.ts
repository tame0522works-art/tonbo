// ページごとの事実（枠・フォント・画像の実効解像度と色・RGB の色指定・特色）を正しく集められるかを確かめる
import assert from 'node:assert/strict'
import { boxHeightMm, boxWidthMm, inspectPdf } from '../src/pdf/inspect.ts'
import { flate, mm, PdfBuilder } from './pdf-builder.ts'

const near = (a: number, b: number, tol = 0.01, msg?: string) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} ≒ ${b}`)

for (const compressed of [false, true]) {
  const b = new PdfBuilder()
  const root = b.reserve()
  const pages = b.reserve()

  // 画像: 1. RGB 1240×1748px を A5（148×210mm）全面に → 約 212.8dpi
  //       2. ICC（N=4）の CMYK 700×700px を 50.8mm 角に → 350dpi
  //       3. Indexed（元は RGB）の 2値ではないパレット画像
  //       4. 2値の画像マスク
  const imRgb = b.add('<< /Type /XObject /Subtype /Image /Width 1240 /Height 1748 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode >>', 'x')
  const icc = b.add('<< /N 4 >>', 'icc')
  const imCmyk = b.add(`<< /Type /XObject /Subtype /Image /Width 700 /Height 700 /ColorSpace [/ICCBased ${icc} 0 R] /BitsPerComponent 8 >>`, 'x')
  const imIdx = b.add('<< /Type /XObject /Subtype /Image /Width 100 /Height 100 /ColorSpace [/Indexed /DeviceRGB 1 <000000FFFFFF>] /BitsPerComponent 8 >>', 'x')
  const imMask = b.add('<< /Type /XObject /Subtype /Image /Width 1200 /Height 1200 /ImageMask true >>', 'x')
  // 部品（Form XObject）の中で半分に縮めて置いた CMYK 画像 → 解像度は倍の 700dpi になる
  const form = b.add(
    `<< /Type /XObject /Subtype /Form /BBox [0 0 1000 1000] /Matrix [0.5 0 0 0.5 0 0] /Resources << /XObject << /ImC ${imCmyk} 0 R >> >> /Filter /FlateDecode >>`,
    flate('q 144 0 0 144 0 0 cm /ImC Do Q'),
  )
  // フォント: 埋め込みあり（Type0 → CIDFont → FontFile2）、なし（TrueType）、使われていない（未埋め込みでも数えない）、Type3
  const ff = b.add('<< >>', 'font')
  const descE = b.add(`<< /Type /FontDescriptor /FontName /ABCDEF+GenShin /FontFile2 ${ff} 0 R >>`)
  const cid = b.add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+GenShin /FontDescriptor ${descE} 0 R >>`)
  const fEmb = b.add(`<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+GenShin /DescendantFonts [${cid} 0 R] /Encoding /Identity-H >>`)
  const descN = b.add('<< /Type /FontDescriptor /FontName /MS-Mincho >>')
  const fNot = b.add(`<< /Type /Font /Subtype /TrueType /BaseFont /MS-Mincho /FontDescriptor ${descN} 0 R >>`)
  const fUnused = b.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const fT3 = b.add('<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1 1] /FontMatrix [1 0 0 1 0 0] /CharProcs << >> >>')

  const w = mm(148)
  const h = mm(210)
  const content1 = [
    `q ${w} 0 0 ${h} 0 0 cm /ImR Do Q`,
    `q 144 0 0 144 10 10 cm /ImC Do Q`,
    `q 72 0 0 72 0 0 cm /ImI Do Q`,
    `q 288 0 0 288 0 0 cm /ImM Do Q`,
    `/Fm Do`,
    `BT /F1 10 Tf 1 0 0 rg (a) Tj /F2 10 Tf (b) Tj /F4 10 Tf (c) Tj ET`,
    `0 0 1 RG 0 0 m 10 10 l S`,
    `/CS0 cs 0.5 scn 0 0 10 10 re f`,
    `/CS1 cs 1 0 0 scn 0 0 5 5 re f`,
    // 色を選んだだけで何も描かなければ数えない
    `q 0 1 0 rg Q`,
    // インライン画像（RGB 30×30px を 72pt 角に → 30dpi）。中身に EI に似たバイトが入っていても読み飛ばせる
    'BI /W 30 /H 30 /CS /RGB /BPC 8 ID \x00EIx\x01\x02 EI',
    'q 72 0 0 72 0 0 cm BI /W 30 /H 30 /CS /RGB /BPC 8 ID \x00\x01 EI Q',
  ].join('\n')
  const c1 = b.add('<< /Filter /FlateDecode >>', flate(content1))
  const res = `<< /XObject << /ImR ${imRgb} 0 R /ImC ${imCmyk} 0 R /ImI ${imIdx} 0 R /ImM ${imMask} 0 R /Fm ${form} 0 R >>
    /Font << /F1 ${fEmb} 0 R /F2 ${fNot} 0 R /F3 ${fUnused} 0 R /F4 ${fT3} 0 R >>
    /ColorSpace << /CS0 [/Separation /#E7#89#B9#E8#89#B2 /DeviceCMYK 0 0 R] /CS1 [/ICCBased ${b.add('<< /N 3 >>', 'icc')} 0 R] >> >>`
  // 1ページ目: A5 の仕上がりに 3mm の塗り足し。MediaBox と Resources は親の Pages から受け継ぐ
  const p1 = b.add(
    `<< /Type /Page /Parent ${pages} 0 R /TrimBox [${mm(3)} ${mm(3)} ${mm(151)} ${mm(213)}] /BleedBox [0 0 ${mm(154)} ${mm(216)}] /Contents ${c1} 0 R >>`,
  )
  // 2ページ目: 枠の指定なし、90度回転、自分の MediaBox
  const c2 = b.add('<< >>', '0 g 0 0 10 10 re f')
  const p2 = b.add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${w} ${h}] /Rotate -90 /Resources << >> /Contents ${c2} 0 R >>`)
  b.set(root, `<< /Type /Catalog /Pages ${pages} 0 R >>`)
  b.set(pages, `<< /Type /Pages /Kids [${p1} 0 R ${p2} 0 R] /Count 2 /MediaBox [0 0 ${mm(154)} ${mm(216)}] /Resources ${res} >>`)

  const label = compressed ? '圧縮形式' : '表形式'
  const facts = await inspectPdf(b.build(root, { compressed }))
  assert.equal(facts.pages.length, 2, label)
  assert.equal(facts.repaired, false)
  const [a, z] = facts.pages

  near(boxWidthMm(a.mediaBox), 154, 0.01, label)
  near(boxHeightMm(a.mediaBox), 216, 0.01, label)
  near(boxWidthMm(a.trimBox!), 148, 0.01, label)
  near(boxWidthMm(a.bleedBox!), 154, 0.01, label)
  assert.equal(z.trimBox, undefined)
  assert.equal(z.rotate, 270)
  near(boxWidthMm(z.mediaBox), 148, 0.01)

  const byLabel = (l: string) => a.images.filter((i) => i.label === l)
  const [r] = byLabel('ImR')
  assert.equal(r.color, 'rgb')
  near(r.dpiX, 1240 / (148 / 25.4), 0.01, 'RGB 画像の横の解像度')
  near(r.dpiY, 1748 / (210 / 25.4), 0.01, 'RGB 画像の縦の解像度')
  const cmyk = byLabel('ImC')
  assert.equal(cmyk.length, 2, '直接置いた分と部品の中の分')
  assert.ok(cmyk.every((i) => i.color === 'cmyk'))
  near(cmyk[0].dpiX, 350)
  near(cmyk[1].dpiX, 700, 0.01, '部品の Matrix で半分に縮めた分')
  near(cmyk[0].bounds.x0, 10)
  assert.equal(byLabel('ImI')[0].color, 'rgb', 'Indexed は元の色空間で判断する')
  assert.equal(byLabel('ImM')[0].color, 'mask')
  const inline = byLabel('インライン')
  assert.equal(inline.length, 2, 'インライン画像の中身を読み飛ばしたあとも続きを読めている')
  assert.equal(inline[0].color, 'rgb')
  near(inline[1].dpiX, 30)

  assert.deepEqual(
    a.fonts.map((f) => [f.name, f.embedded]).sort(),
    [
      ['GenShin', true],
      ['MS-Mincho', false],
      ['（Type3）', true],
    ],
    '使われたフォントだけを、サブセット名の接頭辞を除いて数える',
  )
  // RGB で描いた回数: rg の色の文字3回・RG の色の線1回・ICC（N=3）の色の塗り1回。特色の塗りは数えない
  assert.equal(a.rgbPaintOps, 5)
  assert.deepEqual(a.spotColors, ['特色'])
  assert.deepEqual(a.unreadable, [])
  assert.equal(z.rgbPaintOps, 0)
}

// 文字の表示モード: 透明な文字（3 Tr、スキャンした PDF の検索用の文字など）だけに使われたフォントは数えない
{
  const b = new PdfBuilder()
  const root = b.reserve()
  const pages = b.reserve()
  const font = (name: string) => b.add(`<< /Type /Font /Subtype /TrueType /BaseFont /${name} >>`)
  const [fOcr, fAfterQ, fSelectedOnly, fInForm] = [font('OcrHidden'), font('AfterRestore'), font('SelectedOnly'), font('InForm')]
  // 部品の中では書体を選ばず、呼び出し側で選んだ書体のまま文字を描く
  const form = b.add('<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] >>', 'BT (x) Tj ET')
  const content = [
    'q BT 3 Tr /F1 10 Tf (hidden) Tj ET Q', // 透明な文字だけ（表示モードは BT/ET では戻らないので q/Q で囲む）
    'q 3 Tr Q BT /F2 10 Tf (shown) Tj ET', // q/Q で表示モードが 0 に戻る
    'BT /F3 10 Tf ET', // 選んだだけで描かない
    'BT /F4 10 Tf ET /Fm Do', // 部品が受け継いで描く
  ].join('\n')
  const c = b.add('<< >>', content)
  const p = b.add(
    `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 100 100] /Contents ${c} 0 R /Resources << /Font << /F1 ${fOcr} 0 R /F2 ${fAfterQ} 0 R /F3 ${fSelectedOnly} 0 R /F4 ${fInForm} 0 R >> /XObject << /Fm ${form} 0 R >> >> >>`,
  )
  b.set(root, `<< /Type /Catalog /Pages ${pages} 0 R >>`)
  b.set(pages, `<< /Type /Pages /Kids [${p} 0 R] /Count 1 >>`)
  const f = await inspectPdf(b.build(root))
  assert.deepEqual(f.pages[0].fonts.map((x) => x.name).sort(), ['AfterRestore', 'InForm'])
}

console.log('check:inspect ok')
