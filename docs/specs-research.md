# 印刷所の入稿仕様の調査メモ

調査日: 2026-10-14。各社の公式サイトに書かれている値だけを採り、書かれていない項目は「記載なし」とした。
`src/specs/` の仕様データはこのメモから作る。値を変えるときは、先にこのメモと出典を更新する。

各社とも、PDF の TrimBox / BleedBox についての指定はない。総インク量の上限を書いているのは日光企画（PP 加工時）だけ。
しまや出版は仕様の多くを画像で載せているので、その画像を読んで値を採った（出典に「画像」と付けたもの）。

## 日光企画

| 項目 | 本文 | 表紙 | 出典 |
|---|---|---|---|
| 判型 | A5・B5・B6・新書・文庫（トンボの配布あり）。A4 は口絵・チラシ用のみ | 同左 | T |
| 仕上がりサイズ（mm） | 本文には記載なし。テンプレートから読み取り: A5 148×210、B5 182×257、B6 128×182、新書 105×175、文庫 105×148（下の注） | 記載なし | T |
| 塗り足し | 天地左右 各3mm。クリスタのトンボを使う場合は「3mmでも5mmでもOK」 | 3mm、全体の幅に背幅を足す | Q, T |
| 解像度 | フルカラー 350dpi、グレースケール 600dpi、モノクロ2階調 600dpi。最低値は記載なし | フルカラー 350dpi | Q, T |
| カラーモード | モノクロ原稿にカラーが混じっていればグレーに変換 | オフセットは RGB 非対応で CMYK に変換（色の変化は了承事項）。オンデマンドの一部用紙は疑似 RGB 可 | Q, N |
| PDF | 受付（表示崩れは免責）。規格の指定なし。Word からの PDF はフォント埋め込みで可。Times New Roman と Arial は未埋め込みでも不備としない | 同左 | Q, N |
| トンボ | 推奨。なければ「本のサイズ+各3mm」のキャンバスの中央合わせで処理 | 同左 | Q, T |
| 画像形式 | PSD・TIFF・PDF・ai。JPG・PNG・BMP は印刷できるが非推奨 | 同左 | Q |
| ページ数の単位 | 料金表は A5・文庫・新書が 8p、B5 が 4p 刻み（表紙4pを含む） | — | K |
| ノンブル | 全ページ必須。仕上がり内（塗り足し部分は不可）。奇数ページ始まり、漢数字不可、ファイル名と一致 | 不要 | Q, N |
| 背幅 | 表紙込みページ数 × 用紙の厚み。上質70kg 0.050、上質90kg 0.063、上質110kg 0.075 など。カバーは +1mm | — | S, Q |
| 総インク量 | — | マット PP・ベルベット PP 使用時は 350% 以下 | O1, K |

- T: https://www.nikko-pc.com/site/home-hd-2/home-tombo/
- Q: https://www.nikko-pc.com/site/home-hd-2/home-qa/
- N: https://www.nikko-pc.com/site/home-hd-2/home-ng/
- S: https://www.nikko-pc.com/site/home-hd-2/home-sehaba/
- K: https://www.nikko-pc.com/site/home-hd-2/kihon/
- O1: https://www.nikko-pc.com/site/service/service-off-01

日光企画の判型の寸法（2026-10-14 確認）: トンボのページで配布している本文用テンプレート（モノクロ、各判型の zip に PSD が1枚、2011年作成、600dpi）のガイド線を読んだ。
ガイドは2組あり、内側が仕上がり、外側が塗り足し（どの判型も各辺 3mm）。換算値は 0.1mm 未満の誤差で上の寸法に一致した。
新書の 105×175mm は他の3社のいずれとも違う。

## 緑陽社

| 項目 | 本文 | 表紙 | 出典 |
|---|---|---|---|
| 判型（mm） | B5 182×257、A5 148×210、B6 128×182、新書 114×182、文庫 105×148。A4 210×297 はオールカラーセットのみ | B5 263×(370+背幅)、A5 216×(302+背幅) | B, A4 |
| 塗り足し | 各3mm（端に絵柄のない小説は不要）。安全域は断ち切りから 2mm、ノドは 10mm 以内を避ける | 3mm | B |
| 解像度（推奨） | カラー 350、グレー 600（300 も可）、2階調 600 か 1200。最低値は記載なし | カラー 350。色刷り・多色は 600 か 1200 | PS, IL |
| カラーモード | スミ刷りはグレーか2階調。RGB は変換する | RGB・CMYK とも可（RGB 推奨）。プロファイルなしは AdobeRGB 扱い | B, F98, F41, PS |
| PDF | InDesign からは PDF/X-4:2008（日本）。ダウンサンプルなし、ZIP 圧縮。トンボ・ページ情報なしで裁ち落とし設定を使う。単ページで、できれば1ファイル。フォントは埋め込み | 同左 | ID, B |
| トンボ | 不要 | 不要 | PS, ID |
| 画像形式 | PSD（推奨）・TIFF・PNG・JPG・EPS | 同左 | PS |
| ページ数の単位 | 無線とじ 2p、中とじ 4p（表紙4p込み） | — | M01 |
| ノンブル | 全ページ必須。高さ 2mm 以上・K100%。隠しノンブル可（仕上がり線より内側） | — | B, F61 |
| 背幅 | 0.05 × 本文ページ数 × 紙係数 + 0.4（mm）。上質70kg 0.97、上質90kg 1.26、上質110kg 1.5 など | — | SH |
| 総インク量 | 記載なし | 記載なし | 2C |

- B: https://www.ryokuyou.co.jp/doujin/manual/basic.html
- A4: https://www.ryokuyou.co.jp/doujin/set/a4allcolor.html
- PS: https://www.ryokuyou.co.jp/doujin/manual/photoshop.html
- IL: https://www.ryokuyou.co.jp/doujin/manual/illustrator.html
- ID: https://www.ryokuyou.co.jp/doujin/manual/indesign.html
- F41: https://www.ryokuyou.co.jp/doujin/faq/faq41.html
- F61: https://www.ryokuyou.co.jp/doujin/faq/faq61.html
- F98: https://www.ryokuyou.co.jp/doujin/faq/faq98.html
- M01: https://www.ryokuyou.co.jp/doujin/set/m01.html
- SH: https://www.ryokuyou.co.jp/doujin/sehaba
- 2C: https://www.ryokuyou.co.jp/doujin/manual/2c.html

緑陽社の背幅の式は計算ツールの設定値から読んだ。ツール内にある別の式（ラベルが -no-use）は使われていないと判断して採らなかった。

## ポプルス

| 項目 | 本文 | 表紙 | 出典 |
|---|---|---|---|
| 判型（mm） | 文庫 105×148、新書 107×175、B6 128×182、A5 148×210、B5 182×257、A4 210×297 | 同じ6サイズ | KH, HY |
| 塗り足し | 3mm。安全域は 3mm 以上、ノドは 7mm 内側（100p 超は 15〜20mm） | 3mm | KH, HG, CV |
| 解像度 | カラー 350 推奨（300 以上推奨、200〜300 でも印刷可）。モノクロ 600。網点ありは 600 か 1200 必須、網点なしのグレーは 300〜350 でも可 | カラー 350 | KH, QA, SG |
| カラーモード | モノクロ本文はグレー・2値・RGB の混在可 | RGB のまま推奨（sRGB）。CMYK と混在可 | QA, KH |
| PDF | PDF1.3 以降。フォントはすべて埋め込みかアウトライン化。画像圧縮オフ | 同左 | KH, SG |
| トンボ | 不要（原寸+断ち切りで中央に置けば） | 同左 | KH, QA |
| 画像形式 | 表は PSD・PNG・PDF・Word。Q&A では PNG・JPG 可。TIFF は記載なし | 同左 | KH, QA |
| ページ数の単位 | 平とじ 10p 以上の 2 の倍数、中とじ 4 の倍数 8〜40p | — | ST |
| ノンブル | データ原稿はファイル名で順番がわかれば不要。入れるなら仕上がりから 3mm 以上内側（ノドは 6mm 以上）、隠しノンブルはノド側 | — | QA, SG |
| 背幅 | 全ページ数（表紙・口絵込み）÷ 係数。上質90k 16.5、上質70k 21.5、上質110k・コミック紙 13.5 など | — | HY |
| 黒 | K10% 以下・K90% 以上は再現できないことがある。PDF の黒は CMYK 各100% を推奨 | — | QA, HB |

- KH: https://www2.popls.co.jp/pop/genkou/kihon.html
- HY: https://www2.popls.co.jp/pop/genkou/hyoushi.html
- HG: https://www2.popls.co.jp/pop/genkou/hon_gazou.html
- HB: https://www2.popls.co.jp/pop/genkou/hon_bunsho.html
- CV: https://www2.popls.co.jp/pop/genkou/cover.html
- SG: https://www2.popls.co.jp/pop/genkou/saigo.html
- QA: https://www2.popls.co.jp/pop/genkou/q_and_a.html
- ST: https://www2.popls.co.jp/pop/book/standard.html

## しまや出版

| 項目 | 本文 | 表紙 | 出典 |
|---|---|---|---|
| 判型（mm） | A4 210×297、B5 182×257、A5 148×210、B6 128×182、新書 107×172、文庫 105×148 | 背幅の取り方は4パターン | DG（画像）, BS, BG |
| 塗り足し | 各3mm（MediBang のページだけ「3〜5mm」） | 3mm | DG（画像）, MB |
| 解像度 | カラー 350、グレー 350〜600、2階調 600〜1200。最低値は記載なし | フルカラー 350 | PS, DG（画像） |
| カラーモード | グレーは 15〜80% がきれいに出る範囲 | CMYK を依頼。RGB は変換するので色が変わる | DG（画像）, PS |
| PDF | PDF1.3〜1.7、X-1a:2001 JPN を推奨。PDF/A 不可。フォントはすべて埋め込み（サブセット100%）。ダウンサンプルなし | 同左 | PDF |
| トンボ | Photoshop では任意、Illustrator ではトリムマーク | 同左 | PS, AI |
| 画像形式 | PSD・TIFF・EPS。PNG・JPEG は記載なし | 同左 | AP, PS |
| ページ数の単位 | 一般的な規定は記載なし | — | QA |
| ノンブル | 全ページ必須（仕上がりから 3〜5mm 内側）。隠しノンブル可（ノド側） | — | DG（画像）, KG |
| 背幅 | 早見表のみ（本文ページ数で引く、カバーは +1mm）。100p で上質70k 4.8mm、上質90k 6.3mm、上質110k 7.5mm | — | SB |

- DG: https://www.shimaya.net/howto/data-genkou.html
- PS: https://www.shimaya.net/howto/ps.html
- AI: https://www.shimaya.net/howto/ai.html
- AP: https://www.shimaya.net/howto/application.html
- PDF: https://www.shimaya.net/howto/pdf.html
- SB: https://www.shimaya.net/howto/sehaba.html
- QA: https://www.shimaya.net/support/q&a.html
- KG: https://www.shimaya.net/howto/kamigenkou.html
- MB: https://www.shimaya.net/howto/medibang.html
- BS: https://www.shimaya.net/doujinshi/basic.html
- BG: https://www.shimaya.net/bungei/bungei-besic.html

## 設計に効く食い違い

- 新書の寸法が社ごとに違う（日光企画 105×175 / 緑陽社 114×182 / ポプルス 107×175 / しまや 107×172）。判型名から寸法を決めず、社ごとに持つ。
- RGB の扱いが正反対（緑陽社・ポプルスは歓迎、日光企画オフセット・しまやは変換）。「RGB＝エラー」と決め打ちしない。
- ノンブルはポプルスだけ不要。日光企画だけ奇数始まり必須。
- 背幅の式が4社とも違い、表紙をページ数に含めるかも違う。
- 最低解像度はどの社も書いていない。推奨値を下回ったら「注意」にとどめ、エラーにはしない。

## 確認しきれなかったこと

- しまや出版のページ数の単位、PNG / JPEG の可否
- ポプルスの TIFF、JPG（表と Q&A で矛盾）
- 日光企画の PDF 規格とフォント埋め込みの一般規定
