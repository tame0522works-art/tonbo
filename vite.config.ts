import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { defineConfig, type Plugin } from 'vite'

/**
 * 公開版に Content Security Policy を入れ、「入稿データを端末の外に出さない」をブラウザに守らせる。
 * connect-src 'none' で fetch / XHR / WebSocket などの通信はすべて拒否される（送る処理を書いていない、だけに頼らない）。
 * GitHub Pages はレスポンスヘッダーを設定できないので <meta> で入れる（そのため frame-ancestors は使えない）。
 * 開発サーバーは更新の通知に WebSocket を使うので、ビルドのときだけ入れる。
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  // ページの表示は読み込んだファイルから作った blob: の画像を使う
  "img-src 'self' data: blob:",
  "connect-src 'none'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ')

function contentSecurityPolicy(): Plugin {
  return {
    name: 'tonbo-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      // 文字コードの指定より後ろに置く（文字コードは先頭 1024 バイト以内で宣言する必要がある）
      handler: (html) => html.replace('<meta charset="UTF-8" />', `$&\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
    },
  }
}

/** 画面に出す版の名前（ビルドした日時〈日本時間〉と、コミットの短い ID） */
function buildVersion(): string {
  const jst = new Date(Date.now() + 9 * 60 * 60_000)
  const p = (n: number) => String(n).padStart(2, '0')
  const date = `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())} ${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}`
  let sha = process.env.GITHUB_SHA?.slice(0, 7) ?? ''
  if (!sha) {
    try {
      sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    } catch {
      // git のない所でビルドしても、日時だけは出す
    }
  }
  return sha ? `${date}（${sha}）` : date
}

// GitHub Pages ではリポジトリ名の下（/tonbo/）で配信されるので、CI から BASE_PATH で渡す
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  define: { __APP_VERSION__: JSON.stringify(buildVersion()) },
  plugins: [contentSecurityPolicy(), react()],
})
