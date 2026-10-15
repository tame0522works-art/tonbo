import { computeSpine } from '../check/rules.ts'
import { printerOf, withPrinter, type Settings } from '../settings.ts'
import { PRINTERS } from '../specs/index.ts'

/** 印刷所・判型・本文か表紙か などの設定欄と、背幅・判型の注記 */
export function SettingsPanel({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const printer = printerOf(settings)
  const spineCalc = computeSpine(printer, settings.paperId, settings.bodyPages)
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch })
  const formatNote = printer.formats.find((f) => f.id === settings.formatId)?.note
  return (
    <>
      <fieldset className="settings">
        <label>
          印刷所
          <select value={settings.printerId} onChange={(e) => onChange(withPrinter(settings, e.target.value))}>
            {PRINTERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          判型
          <select value={settings.formatId} onChange={(e) => set({ formatId: e.target.value })}>
            {printer.formats.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}（{f.w}×{f.h}mm）
              </option>
            ))}
          </select>
        </label>
        <label>
          ファイル
          <select value={settings.part} onChange={(e) => set({ part: e.target.value as Settings['part'] })}>
            <option value="body">本文</option>
            <option value="cover">表紙</option>
          </select>
        </label>
        {settings.part === 'body' && (
          <>
            <label>
              刷り色
              <select value={settings.ink} onChange={(e) => set({ ink: e.target.value as Settings['ink'] })}>
                <option value="mono">モノクロ</option>
                <option value="color">カラー</option>
              </select>
            </label>
            <label>
              とじ方
              <select value={settings.binding} onChange={(e) => set({ binding: e.target.value as Settings['binding'] })}>
                <option value="perfect">無線とじ（平とじ）</option>
                <option value="saddle">中とじ</option>
              </select>
            </label>
          </>
        )}
        {settings.part === 'cover' && (
          <>
            {printer.spine.value.papers.length > 0 && (
              <label>
                本文の用紙
                <select value={settings.paperId} onChange={(e) => set({ paperId: e.target.value })}>
                  {printer.spine.value.papers.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              本文のページ数
              <input
                type="number"
                min={1}
                inputMode="numeric"
                value={settings.bodyPages ?? ''}
                onChange={(e) => set({ bodyPages: e.target.value ? Number(e.target.value) : undefined })}
              />
            </label>
            <label>
              背幅（mm、手入力）
              <input
                type="number"
                min={0}
                step={0.1}
                inputMode="decimal"
                placeholder={spineCalc !== undefined ? spineCalc.toFixed(1) : ''}
                value={settings.spineMm ?? ''}
                onChange={(e) => set({ spineMm: e.target.value ? Number(e.target.value) : undefined })}
              />
            </label>
          </>
        )}
      </fieldset>
      {settings.part === 'cover' && (
        <p className="meta">
          {settings.spineMm !== undefined
            ? `入力した背幅 ${settings.spineMm}mm で確かめます。`
            : spineCalc !== undefined
              ? `計算した背幅は ${spineCalc.toFixed(2)}mm です。式: ${printer.spine.note}。`
              : printer.spine.value.method === 'table'
                ? `${printer.name}は背幅を早見表で決めます。`
                : '本文のページ数を入れると、背幅を計算して表紙の大きさを確かめます。'}
          {printer.spine.value.tableUrl && (
            <>
              {' '}
              <a href={printer.spine.value.tableUrl} target="_blank" rel="noreferrer">
                早見表を開く
              </a>
              。
            </>
          )}
          表紙は、表4・背・表1 を横に並べた1枚の PDF を想定しています（カバーは対象外）。
        </p>
      )}
      {formatNote && <p className="meta">※ {formatNote}</p>}
    </>
  )
}
