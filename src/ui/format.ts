/** 1, 2, 3, 5 → 「1〜3, 5」 */
export function pageRanges(pages: number[]): string {
  const s = [...pages].sort((a, b) => a - b)
  const out: string[] = []
  for (let i = 0; i < s.length; i++) {
    let j = i
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++
    out.push(j > i ? `${s[i]}〜${s[j]}` : `${s[i]}`)
    i = j
  }
  return out.join(', ')
}
