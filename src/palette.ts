/**
 * パレット（色の一覧）が RGB で書かれた画像（PNG のパレット画像、PDF の Indexed）の色を見分ける。
 * パレットの形式は RGB でも、中身が灰色だけの画像は多い（白黒の漫画をパレットで保存したものなど）ので、
 * 形式ではなく中身で判断する。
 * - 全色が R=G=B の灰色 … gray
 * - そのうち白と黒の2色だけ … mono
 * - それ以外 … rgb
 */
export function paletteColor(rgb: Uint8Array, entries = Math.floor(rgb.length / 3)): 'mono' | 'gray' | 'rgb' {
  let onlyBlackWhite = true
  for (let i = 0; i < entries; i++) {
    const r = rgb[i * 3]
    const g = rgb[i * 3 + 1]
    const b = rgb[i * 3 + 2]
    if (r !== g || g !== b) return 'rgb'
    if (r !== 0 && r !== 255) onlyBlackWhite = false
  }
  return onlyBlackWhite ? 'mono' : 'gray'
}
