// 仕様データの出典ページ（各印刷所の公式サイト）が変わっていないかを確かめる。
// GitHub Actions で週に1回動かし（.github/workflows/sources.yml）、変わっていれば Issue で知らせる。
//
//   npm run sources              記録（tools/sources-baseline.json）と比べ、変わったページを sources-report.md に書く
//   npm run sources -- --update  今のページの状態を記録し直す（変化を確かめ、仕様に反映したあとに使う）
//   npm run sources -- --probe   記録を使わず、各ページを2回ずつ取って、取るたびに変わる部分がないかを確かめる
//
// 比べるのは、開けるか（HTTP の状態）・転送先・本文の文字・載っている画像の一覧。
// 本文の文字は、スクリプトやスタイル、タグを除いて空白をそろえたもので比べる。
// しまや出版は仕様を画像で載せているので、画像の差し替えも見る。
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { PRINTERS } from '../src/specs/index.ts'

const BASELINE = 'tools/sources-baseline.json'
const REPORT = 'sources-report.md'
const USER_AGENT = 'tonbo-source-check (+https://github.com/tame0522works-art/tonbo)'
/** 相手のサーバーに負担をかけないよう、1ページずつ間を空けて取る */
const INTERVAL_MS = 1500

type Snapshot = { status: number; finalUrl: string; textHash: string; textLength: number; imagesHash: string; images: number; error?: string }
type Baseline = { checkedAt: string; pages: Record<string, Snapshot> }

/** どの印刷所の、どの出典キーで使われているか（報告に書く） */
function sourceList(): { url: string; usedBy: string[] }[] {
  const map = new Map<string, string[]>()
  for (const p of PRINTERS) for (const [key, url] of Object.entries(p.sources)) map.set(url, [...(map.get(url) ?? []), `${p.name} ${key}`])
  return [...map].map(([url, usedBy]) => ({ url, usedBy })).sort((a, b) => a.url.localeCompare(b.url))
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** ページの文字コードは、応答の Content-Type、なければ HTML の meta で決める */
function decode(bytes: Uint8Array, contentType: string | null): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048))
  const charset = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? 'utf-8'
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** 本文の文字（スクリプト・スタイル・コメント・タグを除き、空白をそろえる） */
export function pageText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, ' ')
    .trim()
}

/** 載っている画像の一覧（絶対 URL、重複なし、並べ替え済み） */
export function pageImages(html: string, base: string): string[] {
  const out = new Set<string>()
  for (const m of html.matchAll(/<img\b[^>]*?\ssrc=["']([^"']+)["']/gi)) {
    try {
      out.add(new URL(m[1], base).href)
    } catch {
      // 読めない URL は数えない
    }
  }
  return [...out].sort()
}

async function snapshot(url: string): Promise<Snapshot> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(30_000) })
    const html = decode(new Uint8Array(await res.arrayBuffer()), res.headers.get('content-type'))
    const text = pageText(html)
    const images = pageImages(html, res.url)
    return { status: res.status, finalUrl: res.url, textHash: hash(text), textLength: text.length, imagesHash: hash(images.join('\n')), images: images.length }
  } catch (e) {
    return { status: 0, finalUrl: '', textHash: '', textLength: 0, imagesHash: '', images: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 記録と比べて、変わったところを日本語で並べる（変わっていなければ空） */
function differences(before: Snapshot | undefined, now: Snapshot): string[] {
  if (now.error) return [`開けませんでした（${now.error}）`]
  if (now.status !== 200) return [`開けませんでした（HTTP ${now.status}）`]
  if (!before) return ['記録がありません（新しく加えた出典）']
  const out: string[] = []
  if (before.finalUrl !== now.finalUrl) out.push(`転送先が変わりました（${before.finalUrl} → ${now.finalUrl}）`)
  if (before.textHash !== now.textHash) out.push(`本文の文字が変わりました（${before.textLength} → ${now.textLength} 文字）`)
  if (before.imagesHash !== now.imagesHash) out.push(`載っている画像が変わりました（${before.images} → ${now.images} 枚）`)
  return out
}

async function main() {
  const mode = process.argv.includes('--update') ? 'update' : process.argv.includes('--probe') ? 'probe' : 'check'
  const list = sourceList()
  const today = new Date().toISOString().slice(0, 10)

  if (mode === 'probe') {
    // 同じページを時間を空けて2回取り、取るたびに変わる部分（日付・広告など）がないかを見る
    let unstable = 0
    for (const { url } of list) {
      const a = await snapshot(url)
      await sleep(INTERVAL_MS)
      const b = await snapshot(url)
      await sleep(INTERVAL_MS)
      const diff = differences(a, b)
      if (diff.length) unstable++
      console.log(`${diff.length ? '✗' : '✓'} ${a.status} 文字 ${a.textLength} 画像 ${a.images} ${url}${diff.length ? `\n    ${diff.join(' / ')}` : ''}`)
    }
    console.log(unstable ? `\n取るたびに変わるページが ${unstable} 件あります` : '\nどのページも、取るたびに変わる部分はありませんでした')
    return
  }

  const baseline: Baseline = mode === 'update' ? { checkedAt: today, pages: {} } : JSON.parse(readFileSync(BASELINE, 'utf8'))
  const changed: { url: string; usedBy: string[]; diff: string[] }[] = []
  for (const { url, usedBy } of list) {
    const now = await snapshot(url)
    await sleep(INTERVAL_MS)
    if (mode === 'update') {
      if (now.error || now.status !== 200) throw new Error(`${url} を開けないので記録できません（${now.error ?? `HTTP ${now.status}`}）`)
      baseline.pages[url] = now
      console.log(`  記録 ${url}`)
      continue
    }
    const diff = differences(baseline.pages[url], now)
    console.log(`${diff.length ? '✗' : '✓'} ${url}${diff.length ? `\n    ${diff.join(' / ')}` : ''}`)
    if (diff.length) changed.push({ url, usedBy, diff })
  }

  if (mode === 'update') {
    writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + '\n')
    console.log(`\n${BASELINE} を記録し直しました（${list.length} ページ）`)
    return
  }

  const removed = Object.keys(baseline.pages).filter((u) => !list.some((x) => x.url === u))
  if (changed.length === 0) {
    writeFileSync(REPORT, '')
    console.log(`\n出典ページ ${list.length} 件に変化はありませんでした（記録: ${baseline.checkedAt}）`)
    return
  }
  const lines = [
    `仕様データの出典ページ ${list.length} 件のうち、${changed.length} 件が記録（${baseline.checkedAt}）から変わっています（${today} に確認）。`,
    '',
    '印刷所の仕様が変わっていないかを確かめ、変わっていれば `src/specs/` と `docs/specs-research.md` を直してください。',
    '確かめ終えたら `npm run sources -- --update` で記録し直し、仕様の `checkedAt` も更新してください。',
    '',
    ...changed.flatMap((c) => [`- ${c.url}`, `  - 使っている所: ${c.usedBy.join('、')}`, ...c.diff.map((d) => `  - ${d}`)]),
    ...(removed.length ? ['', `記録にあるが、今の仕様データでは使っていない出典: ${removed.join('、')}`] : []),
  ]
  writeFileSync(REPORT, lines.join('\n') + '\n')
  console.log(`\n${changed.length} 件変わっています（${REPORT}）`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
