import { useRef, useState } from 'react'
import { loadFiles, release, type InputFile, type Loaded } from './load.ts'
import sampleCover from './samples/sample-a5-cover-ng.pdf?inline'
import sampleBody from './samples/sample-a5-ng.pdf?inline'
import { readSavedSettings, sampleSettings, saveSettings, type Settings } from './settings.ts'
import { PRINTERS } from './specs/index.ts'
import { Result } from './ui/Result.tsx'
import { SettingsPanel } from './ui/SettingsPanel.tsx'

export default function App() {
  const [loaded, setLoaded] = useState<Loaded[]>([])
  const [dragging, setDragging] = useState(false)
  /** 読み込み中の進み具合（読み込んでいないときは null） */
  const [progress, setProgress] = useState<string | null>(null)
  /** 読み込み中に別のファイルが入れられたら、前の読み込みの結果は捨てる。何回目の読み込みかを数えて見分ける */
  const openCount = useRef(0)
  const [settings, setSettings] = useState<Settings>(readSavedSettings)

  /** 利用者が設定欄を変えたときだけ覚える（見本を開いたときの判型の切り替えは覚えない） */
  function changeSettings(s: Settings) {
    setSettings(s)
    saveSettings(s)
  }

  async function open(files: FileList | InputFile[] | null) {
    const list = files ? Array.from(files) : []
    if (list.length === 0) return
    const me = ++openCount.current
    const isStale = () => me !== openCount.current
    // 読み込み中に古い結果を見せないよう、前の結果は先に消す
    release(loaded)
    setLoaded([])
    const results = await loadFiles(list, setProgress, isStale)
    if (!results) return
    setLoaded(results)
    setProgress(null)
  }

  function openSample(part: 'body' | 'cover') {
    setSettings(sampleSettings(settings, part))
    const dataUrl = part === 'cover' ? sampleCover : sampleBody
    const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), (c) => c.charCodeAt(0))
    const name = part === 'cover' ? '見本（A5 表紙・背幅違い）.pdf' : '見本（A5 本文・わざと不備あり）.pdf'
    void open([{ name, arrayBuffer: async () => bytes.buffer as ArrayBuffer }])
  }

  return (
    <main
      className={dragging ? 'dragging' : undefined}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void open(e.dataTransfer.files)
      }}
    >
      <header>
        <h1>tonbo</h1>
        <p>同人誌の入稿データを、印刷所の仕様に照らして確かめます。ファイルはこの端末の外に送りません。</p>
      </header>

      <SettingsPanel settings={settings} showCover={loaded.some((l) => l.kind !== 'error' && l.part === 'cover')} onChange={changeSettings} />

      <label className="drop">
        PDF、または PNG・JPEG の画像をここにドロップ、または選ぶ
        <span className="drop-note">本文と表紙を一緒に入れると、ページの形からどちらかを見分けます。画像はまとめて入れると、ファイル名の順に1冊として確かめます</span>
        <input type="file" accept="application/pdf,image/png,image/jpeg" multiple onChange={(e) => void open(e.target.files)} />
      </label>
      <p className="sample">
        手元に PDF がなければ{' '}
        <button type="button" onClick={() => openSample('body')}>
          本文の見本で試す
        </button>{' '}
        <button type="button" onClick={() => openSample('cover')}>
          表紙の見本で試す
        </button>
      </p>

      {progress && (
        <p className="progress" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          {progress}
        </p>
      )}
      {loaded.map((l, i) => (
        <Result
          key={l.fileName}
          l={l}
          settings={settings}
          onPartChange={(part) => setLoaded((all) => all.map((x, j) => (j === i && x.kind !== 'error' ? { ...x, part } : x)))}
        />
      ))}

      <footer>
        <p>
          各印刷所の公式サイトに書かれた仕様（{PRINTERS[0].checkedAt} 時点）を元にした非公式のチェックです。入稿の前に、必ず印刷所の最新の案内も確かめてください。
        </p>
        <p>選んだ印刷所や判型は、次に開いたときのために、この端末のブラウザに覚えます。</p>
        <p>版 {__APP_VERSION__}</p>
      </footer>
    </main>
  )
}
