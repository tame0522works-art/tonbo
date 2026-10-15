// 画面の設定（印刷所・判型・本文か表紙か など）と、その引き継ぎ方
import type { CheckOptions } from './check/rules.ts'
import { PRINTERS } from './specs/index.ts'
import type { PrinterSpec } from './specs/types.ts'

export type Settings = Omit<CheckOptions, 'printer'> & { printerId: string }

export function printerOf(s: Settings): PrinterSpec {
  return PRINTERS.find((p) => p.id === s.printerId)!
}

export function initialSettings(): Settings {
  return { printerId: PRINTERS[0].id, formatId: 'A5', part: 'body', ink: 'mono', binding: 'perfect', paperId: PRINTERS[0].spine.value.papers[0]?.id }
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
  const next: Settings = { ...s, part, formatId: printer.formats.some((f) => f.id === 'A5') ? 'A5' : s.formatId }
  if (part === 'cover') {
    next.bodyPages = 100
    next.paperId = printer.spine.value.papers.find((x) => x.id === 'jouhou90')?.id ?? s.paperId
    next.spineMm = undefined
  }
  return next
}
