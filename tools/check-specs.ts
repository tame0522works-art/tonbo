// 仕様データの形と、すべての値に公式サイトの出典が付いていることを確かめる
import assert from 'node:assert/strict'
import { PRINTERS } from '../src/specs/index.ts'
import type { Sourced } from '../src/specs/types.ts'

const DOMAINS: Record<string, string> = {
  nikko: 'www.nikko-pc.com',
  ryokuyou: 'www.ryokuyou.co.jp',
  popls: 'www2.popls.co.jp',
  shimaya: 'www.shimaya.net',
}

assert.equal(new Set(PRINTERS.map((p) => p.id)).size, PRINTERS.length)
for (const p of PRINTERS) {
  const where = p.name
  assert.match(p.checkedAt, /^\d{4}-\d{2}-\d{2}$/, where)
  for (const [k, url] of Object.entries(p.sources)) assert.equal(new URL(url).host, DOMAINS[p.id], `${where} の出典 ${k} が公式サイトでない`)
  const used = new Set<string>()
  const cite = (src: string[], what: string, allowEmpty = false) => {
    if (!allowEmpty) assert.ok(src.length > 0, `${where} の ${what} に出典がない`)
    for (const s of src) {
      assert.ok(s in p.sources, `${where} の ${what} の出典 ${s} が sources にない`)
      used.add(s)
    }
  }
  const sourced = (v: Sourced<unknown> | undefined, what: string) => {
    if (!v) return
    // 「記載なし」（unspecified）だけは出典を持たない
    cite(v.src, what, v.value === 'unspecified')
  }
  assert.ok(p.formats.length > 0)
  assert.equal(new Set(p.formats.map((f) => f.id)).size, p.formats.length, `${where} の判型の id が重複`)
  for (const f of p.formats) {
    assert.ok(f.w > 0 && f.h > f.w, `${where} ${f.label} の寸法`)
    cite(f.src, f.label)
  }
  sourced(p.bleedMm, '塗り足し')
  assert.ok(p.bleedMm.value > 0)
  for (const [k, r] of Object.entries(p.resolution)) {
    sourced(r, `解像度（${k}）`)
    assert.ok(r.value.recommended > 0)
    if (r.value.acceptable !== undefined) assert.ok(r.value.acceptable < r.value.recommended)
  }
  for (const [k, r] of Object.entries(p.rgb)) {
    sourced(r, `RGB（${k}）`)
    assert.ok(['accepted', 'converted', 'unspecified'].includes(r.value))
  }
  sourced(p.fontEmbedExempt, 'フォントの例外')
  for (const [k, u] of Object.entries(p.pageUnit)) {
    sourced(u, `ページ単位（${k}）`)
    assert.ok(u!.value.unit > 0)
    for (const fid of Object.keys(u!.value.byFormat ?? {})) assert.ok(p.formats.some((f) => f.id === fid), `${where} のページ単位に知らない判型 ${fid}`)
  }
  sourced(p.nombre, 'ノンブル')
  sourced(p.spine, '背幅')
  sourced(p.spread, '見開き')
  assert.ok(['single-required', 'unspecified'].includes(p.spread.value))
  for (const [k, v] of Object.entries(p.imageFormats)) {
    // 記載なし（unspecified）でも、どのページを見て記載がないと判断したかを出典に残す
    cite(v.src, `画像形式（${k}）`)
    assert.ok(['accepted', 'discouraged', 'unspecified'].includes(v.value))
  }
  const sp = p.spine.value
  assert.ok(['linear', 'divide', 'table'].includes(sp.method))
  if (sp.method === 'table') assert.ok(sp.tableUrl && sp.papers.length === 0, `${where} の早見表`)
  else assert.ok(sp.papers.length > 0 && sp.papers.every((x) => x.value > 0), `${where} の用紙`)
  if (sp.method === 'linear') assert.ok(sp.perPage! > 0 && sp.constant! >= 0)
  assert.equal(new Set(sp.papers.map((x) => x.id)).size, sp.papers.length)
  assert.equal(typeof p.nombre.value.required, 'boolean')
  for (const k of Object.keys(p.sources)) assert.ok(used.has(k), `${where} の出典 ${k} がどこからも使われていない`)
}

console.log('check:specs ok')
