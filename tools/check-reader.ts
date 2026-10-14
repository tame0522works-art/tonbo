// 自前の PDF 読み取りが、字句・xref の各形式・追記・壊れたファイルを正しく扱えるかを確かめる
import assert from 'node:assert/strict'
import { PdfDocument } from '../src/pdf/document.ts'
import { displayName, isDict, isName, isRef, isStream, isString, latin1, Lexer, type PdfDict } from '../src/pdf/objects.ts'
import { appendUpdate, flate, PdfBuilder } from './pdf-builder.ts'

// --- 字句 ---
{
  const lx = new Lexer(Buffer.from('<< /A 1 0 R /B [1 -2.5 .5 +3] /C (a\\(b\\)\\n\\101) /D <4142 4> /E /F#20G /H true /I null >>', 'latin1'))
  const d = lx.next() as PdfDict
  assert.ok(isDict(d))
  const a = d.get('A')
  assert.ok(isRef(a) && a.num === 1)
  assert.deepEqual(d.get('B'), [1, -2.5, 0.5, 3])
  const c = d.get('C')
  assert.ok(isString(c) && latin1(c.bytes) === 'a(b)\nA')
  const dd = d.get('D')
  assert.ok(isString(dd) && latin1(dd.bytes) === 'AB@')
  assert.ok(isName(d.get('E'), 'F G'))
  assert.equal(d.get('H'), true)
  assert.equal(d.get('I'), null)
}
{
  // 入れ子の括弧と、参照に見えて参照でない数の並び
  const lx = new Lexer(Buffer.from('(x(y)z) 1 2 3 [4 5 R 6]', 'latin1'))
  const s = lx.next()
  assert.ok(isString(s) && latin1(s.bytes) === 'x(y)z')
  assert.equal(lx.next(), 1)
  assert.equal(lx.next(), 2)
  assert.equal(lx.next(), 3)
  const arr = lx.next() as unknown[]
  assert.equal(arr.length, 2)
  assert.ok(isRef(arr[0]) && arr[0].num === 4 && arr[0].gen === 5)
}
{
  // 描画命令では演算子が返る
  const lx = new Lexer(Buffer.from('q 1 0 0 1 10 20 cm /Im0 Do Q', 'latin1'))
  const toks = []
  for (let t = lx.next(true); t !== undefined; t = lx.next(true)) toks.push(t)
  assert.deepEqual(
    toks.map((t) => (typeof t === 'object' && t && 'op' in t ? t.op : typeof t === 'number' ? t : isName(t) ? '/' + t.name : '?')),
    ['q', 1, 0, 0, 1, 10, 20, 'cm', '/Im0', 'Do', 'Q'],
  )
}
// 日本語のフォント名（UTF-8 のバイトが #xx で並ぶ）を読める
assert.equal(displayName(latin1(Buffer.from('源ノ角ゴシック', 'utf8'))), '源ノ角ゴシック')

// --- 文書 ---
function sample(): { b: PdfBuilder; root: number; pages: number } {
  const b = new PdfBuilder()
  const root = b.reserve()
  const pages = b.reserve()
  const content = b.add('<< /Filter /FlateDecode >>', flate('0 0 m 10 10 l S'))
  const page = b.add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 100 200] /Contents ${content} 0 R >>`)
  b.set(root, `<< /Type /Catalog /Pages ${pages} 0 R >>`)
  b.set(pages, `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`)
  return { b, root, pages }
}

async function pageMediaBox(doc: PdfDocument) {
  const root = (await doc.getDict(doc.trailer.get('Root')))!
  const pages = (await doc.getDict(root.get('Pages')))!
  const kids = (await doc.get(pages.get('Kids'))) as unknown[]
  const page = (await doc.getDict(kids[0] as never))!
  return { mediaBox: page.get('MediaBox'), page }
}

for (const [label, opts] of [
  ['表形式の xref', {}],
  ['xref stream と ObjStm', { compressed: true }],
] as const) {
  const { b, root } = sample()
  const doc = await PdfDocument.open(b.build(root, opts))
  assert.equal(doc.repaired, false, label)
  const { mediaBox, page } = await pageMediaBox(doc)
  assert.deepEqual(mediaBox, [0, 0, 100, 200], label)
  const c = await doc.get(page.get('Contents'))
  assert.ok(isStream(c), label)
  assert.equal(latin1(await doc.decode(c)), '0 0 m 10 10 l S', label)
}

{
  // xref の位置がずれていても、全体を走査して読める
  const { b, root } = sample()
  const doc = await PdfDocument.open(b.build(root, { breakXref: true }))
  assert.equal(doc.repaired, true)
  assert.deepEqual((await pageMediaBox(doc)).mediaBox, [0, 0, 100, 200])
}
{
  // xref の行が入れ替わり、Root が別の正しいオブジェクト（Pages）を指していても、ずれに気づいて読み直す
  const { b, root } = sample()
  const text = Buffer.from(b.build(root)).toString('latin1')
  const rows = /xref\n0 \d+\n0000000000 65535 f \n(.{20})(.{20})/s.exec(text)!
  const swapped = text.replace(rows[1] + rows[2], rows[2] + rows[1])
  const doc = await PdfDocument.open(Buffer.from(swapped, 'latin1'))
  assert.equal(doc.repaired, true)
  assert.deepEqual((await pageMediaBox(doc)).mediaBox, [0, 0, 100, 200])
}
{
  // 追記で差し替えたオブジェクトのほうが読まれる
  const { b, root, pages } = sample()
  const base = b.build(root)
  const updated = appendUpdate(base, root, 5, new Map([[4, `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 300 400] /Contents 3 0 R >>`]]))
  const doc = await PdfDocument.open(updated)
  assert.equal(doc.repaired, false)
  assert.deepEqual((await pageMediaBox(doc)).mediaBox, [0, 0, 300, 400])
}
{
  // Length が実際より短い stream でも endstream まで読む
  const b = new PdfBuilder()
  const root = b.reserve()
  const s = b.add('<< >>', 'hello world')
  b.set(root, `<< /Type /Catalog /X ${s} 0 R >>`)
  const text = Buffer.from(b.build(root)).toString('latin1').replace('/Length 11', '/Length 5 ')
  const doc = await PdfDocument.open(Buffer.from(text, 'latin1'))
  const r = await doc.getDict(doc.trailer.get('Root'))
  const st = await doc.get(r!.get('X'))
  assert.ok(isStream(st))
  assert.equal(latin1(st.raw), 'hello world')
}
await assert.rejects(PdfDocument.open(Buffer.from('not a pdf')))

console.log('check:reader ok')
