// 画面の色の組み合わせが、ライトモードとダークモードの両方で読める濃さ（WCAG のコントラスト比 4.5 以上）かを確かめる。
// 色は src/index.css の :root（ライト）と prefers-color-scheme: dark の中の変数から読む
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync('src/index.css', 'utf8')

function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2].toLowerCase()]))
}
const light = tokens(/:root\s*\{([^}]*)\}/.exec(css)![1])
const darkBlock = /prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)
assert.ok(darkBlock, 'ダークモードの色が見つからない')
const dark = { ...light, ...tokens(darkBlock[1]) }

/** 相対輝度（WCAG 2） */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

// [何の文字か, 文字の色, 背景の色]（変数名で書く）
const PAIRS: [string, string, string][] = [
  ['本文の文字', 'fg', 'bg'],
  ['補足の文字', 'muted', 'bg'],
  ['面の上の補足の文字', 'muted', 'surface'],
  ['面の上の文字', 'fg', 'surface'],
  ['要約・エラーの文字', 'accent', 'surface'],
  ['エラー文', 'accent', 'bg'],
  ['札「要修正」の文字', 'badge-fg', 'accent'],
  ['札「注意」の文字', 'badge-fg', 'warn'],
  ['札「参考」の文字', 'badge-fg', 'muted'],
]

const failures: string[] = []
for (const [name, theme] of [
  ['ライト', light],
  ['ダーク', dark],
] as const) {
  for (const [label, fg, bg] of PAIRS) {
    assert.ok(theme[fg] && theme[bg], `${name}モードに --${fg} か --${bg} がない`)
    const r = ratio(theme[fg], theme[bg])
    if (r < 4.5) failures.push(`${name}モードの${label}: ${r.toFixed(2)}（--${fg} ${theme[fg]} / --${bg} ${theme[bg]}）`)
  }
}
assert.deepEqual(failures, [], `コントラスト比が 4.5 に届かない組み合わせがあります:\n${failures.join('\n')}`)

console.log('check:contrast ok')
