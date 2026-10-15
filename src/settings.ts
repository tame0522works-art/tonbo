// 画面の設定（印刷所・判型・刷り色・とじ方・表紙の用紙など）と、その引き継ぎ方
import type { CheckOptions } from './check/rules.ts'
import { PRINTERS } from './specs/index.ts'
import type { PrinterSpec } from './specs/types.ts'

/** 本文か表紙か（part）はファイルごとに持つので、設定には含めない */
export type Settings = Omit<CheckOptions, 'printer' | 'part'> & { printerId: string }

export function printerOf(s: Settings): PrinterSpec {
  return PRINTERS.find((p) => p.id === s.printerId)!
}

export function initialSettings(): Settings {
  return { printerId: PRINTERS[0].id, formatId: 'A5', ink: 'mono', binding: 'perfect', paperId: PRINTERS[0].spine.value.papers[0]?.id }
}

/** 印刷所を変える。判型と用紙は、同じものが新しい印刷所にもあれば引き継ぐ */
export function withPrinter(s: Settings, printerId: string): Settings {
  const next = PRINTERS.find((p) => p.id === printerId)!
  const formatId = next.formats.some((f) => f.id === s.formatId) ? s.formatId : next.formats[0].id
  const paperId = next.spine.value.papers.some((x) => x.id === s.paperId) ? s.paperId : next.spine.value.papers[0]?.id
  // 手入力の背幅は、印刷所が変われば意味が変わるので消す
  return { ...s, printerId, formatId, paperId, spineMm: undefined }
}

/**
 * 見本を開くときの設定。見本は A5 で作ってある。
 * 表紙の見本は「本文 100 ページ・上質90kg」の本の表紙を、背幅 4mm で作ってしまった想定
 */
export function sampleSettings(s: Settings, part: 'body' | 'cover'): Settings {
  const printer = printerOf(s)
  const next: Settings = { ...s, formatId: printer.formats.some((f) => f.id === 'A5') ? 'A5' : s.formatId }
  if (part === 'cover') {
    next.bodyPages = 100
    next.paperId = printer.spine.value.papers.find((x) => x.id === 'jouhou90')?.id ?? s.paperId
    next.spineMm = undefined
  }
  return next
}

// ---- 端末に覚える ----

/**
 * 覚えるのは、本が変わっても同じことが多い項目だけ（印刷所・判型・刷り色・とじ方・本文の用紙）。
 * 本文のページ数と手入力の背幅は本ごとに違い、前の本の値が残ると誤った判定になるので覚えない
 */
const STORAGE_KEY = 'tonbo:settings'
const STORAGE_VERSION = 1

export function serializeSettings(s: Settings): string {
  const { printerId, formatId, ink, binding, paperId } = s
  return JSON.stringify({ v: STORAGE_VERSION, printerId, formatId, ink, binding, paperId })
}

/**
 * 覚えた設定を戻す。ブラウザの保存領域は書き換えられうる外からの入力なので、項目ごとに確かめ、
 * 読めない項目や、仕様データから消えた印刷所・判型・用紙は初期値にする
 */
export function restoreSettings(raw: string | null): Settings {
  const base = initialSettings()
  let saved: Record<string, unknown>
  try {
    const v: unknown = raw ? JSON.parse(raw) : null
    if (!v || typeof v !== 'object' || (v as { v?: unknown }).v !== STORAGE_VERSION) return base
    saved = v as Record<string, unknown>
  } catch {
    return base
  }
  const printer = PRINTERS.find((p) => p.id === saved.printerId)
  if (!printer) return base
  const s: Settings = withPrinter(base, printer.id)
  if (printer.formats.some((f) => f.id === saved.formatId)) s.formatId = saved.formatId as string
  if (saved.ink === 'mono' || saved.ink === 'color') s.ink = saved.ink
  if (saved.binding === 'perfect' || saved.binding === 'saddle') s.binding = saved.binding
  if (printer.spine.value.papers.some((x) => x.id === saved.paperId)) s.paperId = saved.paperId as string
  return s
}

/** プライベートモードなどで保存領域が使えないときは、覚えないだけにする */
export function readSavedSettings(): Settings {
  try {
    return restoreSettings(localStorage.getItem(STORAGE_KEY))
  } catch {
    return initialSettings()
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, serializeSettings(s))
  } catch {
    // 保存できなくても、この画面を開いているあいだは今の設定で動く
  }
}
