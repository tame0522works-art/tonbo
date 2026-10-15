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
  /** 表紙を含めるかが公式サイトに書かれていない。判定では両方の数え方を試し、結果が変わるときはそう伝える（includesCover は使わない） */
  coverCountUnknown?: boolean
  /** true なら入稿の条件、false なら料金表の刻み（外れても入稿はできるが、料金は一つ上になる） */
  strict: boolean
}

export type NombreRule = {
  required: boolean
  /** 最初のページを奇数で始める */
  oddStart?: boolean
  /** 漢数字は不可 */
  noKanji?: boolean
  /** 仕上がりの内側に入れる（塗り足し部分は不可） */
  insideTrim?: boolean
  /** 文字の高さの下限（mm） */
  minHeightMm?: number
}

/**
 * 背幅の求め方。印刷所ごとに式が違うので、次のどれかで表す（pages は数え方 includesCover に従ったページ数）
 * - linear … perPage × pages × 用紙の値 + constant（日光企画は用紙の厚み、緑陽社は紙係数）
 * - divide … pages ÷ 用紙の値（ポプルス）
 * - table  … 式が公開されておらず早見表だけ（しまや出版）。計算せず、利用者に早見表の値を入れてもらう
 */
export type SpineRule = {
  method: 'linear' | 'divide' | 'table'
  perPage?: number
  constant?: number
  includesCover: boolean
  papers: { id: string; label: string; value: number }[]
  /** 早見表の URL（table のとき） */
  tableUrl?: string
}

/** 画像原稿の形式の扱い。discouraged は「印刷はできるが推奨しない」 */
export type ImageFormatPolicy = 'accepted' | 'discouraged' | 'unspecified'

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
  /** body はスミ刷り（モノクロ）本文、cover はフルカラー（表紙・カラー本文）での RGB の扱い */
  rgb: { body: Sourced<RgbPolicy>; cover: Sourced<RgbPolicy> }
  /** 埋め込まれていなくても不備としないと明記されたフォント（名前の一部で照合する） */
  fontEmbedExempt?: Sourced<string[]>
  pageUnit: { perfect?: Sourced<PageUnit>; saddle?: Sourced<PageUnit> }
  nombre: Sourced<NombreRule>
  spine: Sourced<SpineRule>
  imageFormats: { png: Sourced<ImageFormatPolicy>; jpeg: Sourced<ImageFormatPolicy> }
}
