/**
 * 印刷所の仕様データの形。値はどれも、公式サイトのどのページに書かれていたか（src）を持つ。
 * src は同じファイルの sources のキーで、画面の指摘には出典として URL を添える。
 * 公式サイトに書かれていない値は入れない（推測で埋めると「その印刷所の仕様」として誤って伝わるため）。
 */

export type Sourced<T> = { value: T; src: string[]; note?: string }

export type Format = {
  id: string
  label: string
  /** 仕上がりの幅と高さ（mm） */
  w: number
  h: number
  src: string[]
  note?: string
}

/** RGB で入稿したときの扱い。accepted は受け付けて推奨もしている、converted は印刷所で変換され色が変わる */
export type RgbPolicy = 'accepted' | 'converted' | 'unspecified'

export type Resolution = {
  /** 推奨値。これを下回る画像を「注意」として示す */
  recommended: number
  /** 「これでも印刷はできる」と書かれている下限（書かれていなければなし） */
  acceptable?: number
}

export type PageUnit = {
  unit: number
  /** 判型ごとに単位が違う場合 */
  byFormat?: Record<string, number>
  min?: number
  max?: number
  /** 単位に表紙の4ページを含めて数えるか */
  includesCover: boolean
  /** true なら入稿の条件、false なら料金表の刻み（外れても入稿はできるが、料金は一つ上になる） */
  strict: boolean
}

export type PrinterSpec = {
  id: string
  name: string
  /** 公式サイトで値を確かめた日 */
  checkedAt: string
  sources: Record<string, string>
  formats: Format[]
  bleedMm: Sourced<number>
  resolution: {
    color: Sourced<Resolution>
    gray: Sourced<Resolution>
    mono: Sourced<Resolution>
  }
  rgb: { body: Sourced<RgbPolicy>; cover: Sourced<RgbPolicy> }
  /** 埋め込まれていなくても不備としないと明記されたフォント（名前の一部で照合する） */
  fontEmbedExempt?: Sourced<string[]>
  pageUnit: { perfect?: Sourced<PageUnit>; saddle?: Sourced<PageUnit> }
}
