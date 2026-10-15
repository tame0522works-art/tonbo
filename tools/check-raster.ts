// PNG / JPEG のヘッダの読み取りと、画像原稿の大きさの決め方・印刷所ごとの形式の扱いを確かめる
import assert from 'node:assert/strict'
import { crc32, deflateSync } from 'node:zlib'
import type { CheckOptions } from '../src/check/rules.ts'
import { checkRasters, sortByName, type RasterFile } from '../src/raster/facts.ts'
import { inspectRaster } from '../src/raster/inspect.ts'
import { PRINTERS } from '../src/specs/index.ts'

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])))
  return Buffer.concat([head, data, crc])
}

/** 画素は中身を問わないので、1行ぶんだけの IDAT を付ける（ヘッダの読み取りは IDAT の手前で終わる） */
function png(w: number, h: number, colorType: number, bitDepth: number, dpi?: number, extra: Buffer[] = []): Uint8Array {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = bitDepth
  ihdr[9] = colorType
  const parts: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra]
  if (dpi) {
    const phys = Buffer.alloc(9)
    phys.writeUInt32BE(Math.round(dpi / 0.0254), 0)
    phys.writeUInt32BE(Math.round(dpi / 0.0254), 4)
    phys[8] = 1
    parts.push(chunk('pHYs', phys))
  }
  parts.push(chunk('IDAT', deflateSync(Buffer.alloc(1))), chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(parts)
}

function segment(marker: number, data: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0])
  head.writeUInt16BE(data.length + 2, 2)
  return Buffer.concat([head, data])
}

function jpeg(w: number, h: number, comps: number, jfif?: { units: number; x: number }, exifDpi?: number): Uint8Array {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])]
  if (jfif) {
    const d = Buffer.alloc(14)
    d.write('JFIF\0', 0, 'latin1')
    d[5] = 1
    d[6] = 2
    d[7] = jfif.units
    d.writeUInt16BE(jfif.x, 8)
    d.writeUInt16BE(jfif.x, 10)
    parts.push(segment(0xe0, d))
  }
  if (exifDpi) {
    // リトルエンディアンの TIFF。IFD0 に XResolution・YResolution（有理数）と ResolutionUnit（2 = インチ）
    const t = Buffer.alloc(8 + 2 + 3 * 12 + 4 + 16)
    t.write('II', 0, 'latin1')
    t.writeUInt16LE(42, 2)
    t.writeUInt32LE(8, 4)
    t.writeUInt16LE(3, 8)
    const rationalAt = 8 + 2 + 36 + 4
    const entry = (i: number, tag: number, type: number, value: number) => {
      const e = 10 + i * 12
      t.writeUInt16LE(tag, e)
      t.writeUInt16LE(type, e + 2)
      t.writeUInt32LE(1, e + 4)
      t.writeUInt32LE(value, e + 8)
    }
    entry(0, 0x011a, 5, rationalAt)
    entry(1, 0x011b, 5, rationalAt + 8)
    entry(2, 0x0128, 3, 2)
    for (const at of [rationalAt, rationalAt + 8]) {
      t.writeUInt32LE(exifDpi * 10, at)
      t.writeUInt32LE(10, at + 4)
    }
    parts.push(segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t])))
  }
  const sof = Buffer.alloc(6 + comps * 3)
  sof[0] = 8
  sof.writeUInt16BE(h, 1)
  sof.writeUInt16BE(w, 3)
  sof[5] = comps
  parts.push(segment(0xc0, sof), Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9]))
  return Buffer.concat(parts)
}

// --- ヘッダの読み取り ---
{
  const m = inspectRaster(png(2122, 2976, 2, 8, 350))
  assert.equal(m.format, 'png')
  assert.deepEqual([m.pxWidth, m.pxHeight, m.color, m.alpha], [2122, 2976, 'rgb', false])
  assert.ok(Math.abs(m.dpi!.x - 350) < 0.05)
  assert.equal(inspectRaster(png(10, 10, 0, 1)).color, 'mono')
  assert.equal(inspectRaster(png(10, 10, 0, 8)).color, 'gray')
  assert.equal(inspectRaster(png(10, 10, 6, 8)).alpha, true)
  assert.equal(inspectRaster(png(10, 10, 2, 8, undefined, [chunk('iCCP', Buffer.from('x\0\0'))])).icc, true)
  assert.equal(inspectRaster(png(10, 10, 2, 8)).dpi, undefined)
  // パレット画像は PLTE の中身で決める: 灰色だけ → gray、白と黒だけ → mono、色があれば rgb
  const plte = (...rgb: number[]) => chunk('PLTE', Buffer.from(rgb))
  assert.equal(inspectRaster(png(10, 10, 3, 8, undefined, [plte(0, 0, 0, 128, 128, 128, 255, 255, 255)])).color, 'gray')
  assert.equal(inspectRaster(png(10, 10, 3, 1, undefined, [plte(0, 0, 0, 255, 255, 255)])).color, 'mono')
  assert.equal(inspectRaster(png(10, 10, 3, 8, undefined, [plte(0, 0, 0, 255, 0, 0)])).color, 'rgb')

  const j = inspectRaster(jpeg(2122, 2976, 4, { units: 1, x: 350 }))
  assert.deepEqual([j.format, j.pxWidth, j.pxHeight, j.color, j.dpi?.x, j.dpi?.source], ['jpeg', 2122, 2976, 'cmyk', 350, 'JFIF'])
  // JFIF の単位 0 は縦横比だけなので、Exif の解像度を使う
  const e = inspectRaster(jpeg(100, 100, 3, { units: 0, x: 1 }, 350))
  assert.deepEqual([e.color, e.dpi?.x, e.dpi?.source], ['rgb', 350, 'Exif'])
  // 単位が cm（2）なら dpi に直す
  assert.ok(Math.abs(inspectRaster(jpeg(100, 100, 1, { units: 2, x: 138 })).dpi!.x - 350.52) < 0.01)
  assert.throws(() => inspectRaster(new Uint8Array([1, 2, 3])))
}

// --- 判定 ---
const spec = (id: string) => PRINTERS.find((p) => p.id === id)!
const opts = (over: Partial<CheckOptions> = {}): CheckOptions => ({ printer: spec('ryokuyou'), formatId: 'A5', part: 'body', ink: 'mono', binding: 'perfect', ...over })
const file = (name: string, bytes: Uint8Array): RasterFile => ({ name, meta: inspectRaster(bytes) })
// ページ数の単位は PDF と同じ判定なので、ここでは除いて比べる
const codes = (files: RasterFile[], o = opts()) =>
  checkRasters(files, o)
    .findings.map((f) => f.code)
    .filter((c) => !c.startsWith('page-unit'))

// 塗り足し込み A5（154×216mm）を 350dpi のグレーで作った2ページ: ノンブルは確かめられないことだけ伝える
const gray350 = png(2122, 2976, 0, 8, 350)
assert.deepEqual(codes([file('1.png', gray350), file('2.png', gray350)]), ['dpi-gray', 'nombre-raster'])
// （緑陽社のグレーの推奨は 600dpi なので、350dpi は「注意」になる）
const mono600 = png(3638, 5102, 0, 1, 600)
assert.deepEqual(codes([file('1.png', mono600), file('2.png', mono600)]), ['nombre-raster'])

// 解像度の情報が 72dpi でも、縦横比が合えばその大きさとみなして解像度を逆算する
{
  const r = checkRasters([file('a.png', png(3638, 5102, 0, 1, 72)), file('b.png', mono600)], opts())
  assert.deepEqual(r.findings.filter((f) => !f.code.startsWith('page-unit')).map((f) => [f.code, f.pages]), [
    ['raster-dpi-inferred', [1]],
    ['nombre-raster', []],
  ])
  assert.ok(Math.abs(r.facts.pages[0].images[0].dpiX - 600) < 1)
}
// 縦横比も合わなければ「大きさが合わない」の1件にし、PDF 用の大きさの指摘は重ねない
assert.deepEqual(codes([file('1.png', png(2000, 2000, 0, 1)), file('2.png', mono600)]), ['raster-size', 'nombre-raster'])

// 形式の扱い: 日光企画は PNG・JPEG とも非推奨、しまや出版は記載なし、緑陽社は受け付ける
{
  const cmyk = file('1.jpg', jpeg(2122, 2976, 4, { units: 1, x: 350 }))
  const bodyColor = (id: string) => opts({ printer: spec(id), ink: 'color' })
  assert.deepEqual(codes([cmyk], bodyColor('nikko')), ['raster-format-jpeg'])
  const level = (id: string) => checkRasters([cmyk], bodyColor(id)).findings.find((f) => f.code === 'raster-format-jpeg')?.level
  assert.equal(level('nikko'), 'warn')
  assert.deepEqual(codes([cmyk], bodyColor('shimaya')), ['raster-format-jpeg'])
  assert.equal(level('shimaya'), 'info')
  assert.deepEqual(codes([cmyk], bodyColor('ryokuyou')), [])
}

// 透明・RGB
assert.deepEqual(codes([file('1.png', png(2122, 2976, 6, 8, 350))], opts({ ink: 'color' })), ['raster-alpha', 'rgb-accepted'])
assert.deepEqual(codes([file('1.png', png(2122, 2976, 2, 8, 350))], opts()), ['rgb-in-mono'])
// 白黒の漫画をパレット形式で保存した PNG は、モノクロ本文でも RGB の指摘を出さない（600dpi のモノクロ2階調として合格）
assert.deepEqual(
  codes([file('1.png', png(3638, 5102, 3, 1, 600, [chunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255]))]))], opts()),
  [],
)

// 表紙: 背幅がわかれば表紙の大きさで判断する（緑陽社 上質90kg 100ページ → 背幅 6.7mm、塗り足し込み 308.7×216mm）
{
  const coverOpts = opts({ part: 'cover', paperId: 'jouhou90', bodyPages: 100 })
  const px = (mm: number) => Math.round((mm / 25.4) * 350)
  const cover = file('cover.png', png(px(308.7), px(216), 2, 8, 350))
  assert.deepEqual(codes([cover], coverOpts), ['rgb-accepted'])
  // 背幅がわからなければ、表紙として合う大きさを決められない
  assert.deepEqual(codes([cover], opts({ part: 'cover' })), ['cover-spine-unknown', 'rgb-accepted'])
}

// ファイル名の順は数字を数として比べる
assert.deepEqual(
  sortByName([{ name: '10.png' }, { name: '2.png' }, { name: '1.png' }, { name: 'p003.jpg' }]).map((f) => f.name),
  ['1.png', '2.png', '10.png', 'p003.jpg'],
)

console.log('check:raster ok')
