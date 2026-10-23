# 素材の配置

この文書は、このリポジトリに含まれる素材と表示方法を説明します。立ち絵は透過WebP、作品のイメージ画は縮小表示用・拡大表示用のWebPを使います。

現在は、作者が別の制作作業で生成した青娥の表情差分10枚を `assets/seiga/` に配置しています。原PNGを残し、画面では透過を保持して縮小・圧縮した768×1152のWebPを使います。画面上の大きさと下端の見せ方はCSSで調整し、名前と台詞の会話欄を下部へ重ねています。スマホでは上半身を大きく表示します。

現在の背景は `assets/study/study-v1.png` です。作者が提示した絵の建築・色調・昼光を参考に、Codex内蔵image_genで無人の書斎を生成しました。人物や文字を含まず、立ち絵と画面部品を別に重ねています。以前の `assets/lounge/lounge-v1.png` は比較用に残しています。生成条件の記録は制作資料側で管理しています。

| 画像 | 場面 |
| --- | --- |
| `assets/seiga/idle.webp` | 開始・履歴・質問中の抽選候補 |
| `assets/seiga/recommend.webp` | 作品のお薦め |
| `assets/seiga/tease.webp` | 旧来の寄り道用。現在の質問中の抽選には含めない |
| `assets/seiga/amused.webp` | 質問中の抽選候補 |
| `assets/seiga/listening.webp` | 質問中の抽選候補：耳を傾ける |
| `assets/seiga/adjusting-glasses.webp` | 質問中の抽選候補：眼鏡を直す |
| `assets/seiga/thinking.webp` | 質問中の抽選候補：思案する |
| `assets/seiga/sleeve-smile.webp` | 質問中の抽選候補：袖口で笑う |
| `assets/seiga/celebrate.webp` | 全作品を紹介した時 |
| `assets/seiga/ending.webp` | 最後の会話 |

## 差し替え方法

利用する素材の条件を確認してから配置してください。画像がない場合や読み込めない場合も、案内役の名前と台詞で動作します。

1. 透過PNGまたはWebPを `assets/seiga/` へ置く。
2. `data/presentation.json` の `narrator.images` へ画像の相対パスを書く。
3. 質問に使う表情のキーを `narrator.question_moods` に登録する。2種類以上、重複なしにする。
4. スマホ幅と作品紹介画面で、顔・髪飾り・見せたい仕草が確認できるか確かめる。

| 設定キー | 主な場面 |
| --- | --- |
| `idle` | 開始・履歴・質問中の抽選候補 |
| `recommend` | 作品のお薦め |
| `tease` | 予備。現在の質問中の抽選には含めない |
| `amused`, `listening`, `adjusting-glasses`, `thinking`, `sleeve-smile` | 質問中の抽選候補 |
| `celebrate` | 全作品を紹介した時 |
| `ending` | 最後の会話 |

例：`"idle": "assets/seiga/idle.webp"`。未登録の表情では `idle` を使い、それもない場合は文字の案内枠を使います。

通常質問と人物質問では、次の設問に進むたびに6種類から直前の絵を除いて抽選します。同じ設問の再描画や説明・履歴からの復帰では表示を維持し、待機中の自動切り替えはしません。回答内容や推薦点数は抽選に渡しません。お薦め・お祝い・最後の会話は専用の表情です。

キャンバスの大きさと顔の位置を揃え、腰から太もも上程度までを収める想定です。台詞・背景・画面部品は画像に描き込まない方が扱いやすくなります。スマホでは上端を基準にバストアップで切り取るため、下側の手などは画面に収まらない場合があります。

`assets/og-card.svg` はサイト共通の紹介画像の編集元、`assets/og-card.png` は共有カード向けの配信用画像です。画像を変更した場合はPNGとHTMLの紹介情報も揃えてください。

## 作品のイメージ画

公開用データに登録した10作品について、作者の既存イメージ画をWebPへ変換して `assets/works/` に配置しています。原画像は取り込まず、構図を切り取らずに縮小・圧縮しています。

- `{作品ID}-preview.webp`：480×720。結果カード用。約64〜98KB／枚。
- `{作品ID}.webp`：1024×1536。拡大表示用。約282〜454KB／枚。絵を押した時に読み込みます。

対応は `data/presentation.json` の `work_art_by_work` に記載します。各項目は `preview`、`full`、`width`、`height`、`alt` のみです。未登録の作品は絵なしで表示でき、小表示用画像の読み込みに失敗した場合も本文へのリンクを利用できます。現在の結果と履歴から開いた結果で共通の表示を使います。

作品カードの内側の幅が470px以上の場合は、幅190pxの絵の右にキャプション、推薦理由・本文へのリンクを置きます。470px未満の場合は、幅180pxの絵・推薦理由と本文へのリンク・キャプションの順に縦に配置します。どちらも絵の全体を表示します。拡大表示は閉じるボタン、Escキー、枠外のクリックで閉じられ、閉じた後は操作した絵へフォーカスを戻します。

画像の再生成は、Sharpを利用できるNode.js環境で次のコマンドを実行します。通常のサイトの実行・ビルドにはSharpは不要です。

```sh
node scripts/prepare-images.mjs --works-dir <作品タイトル.pngを置いたフォルダー>
```

Sharpはローカルのインストールまたは `NODE_PATH` で解決します。このスクリプトは公開用データの作品タイトルと一致するPNGだけを入力にし、立ち絵は `assets/seiga/` の原PNGから再生成します。既存のWebPと対応設定を更新するため、生成後に `node scripts/check.mjs` と実画面での確認を行ってください。

## 代理役の素材

代理役の通常立ち絵には、作者指定の生成画像を縮小・圧縮した `assets/robot/yoshika-idle.webp` を使います。左右反転済みの素材をそのまま用い、構図と透過を保持した768×768のWebPです。制作元のPNGと生成記録は制作資料側で管理します。

爆破時は同じく作者指定の生成画像を768×768の透過WebPへ変換した `assets/robot/explosion.webp` へ切り替えます。通常画像は約87KB、爆破画像は約108KBです。どちらもPC・スマホで画像全体が台詞欄に隠れないよう枠内に収め、青娥のバストアップ表示とは別の配置にしています。爆発は静止画の差し替えで表し、タイマーや専用の入力制御は追加していません。

以前の `assets/robot/idle-placeholder.svg` と `assets/robot/broken-placeholder.svg` は、未使用の仮素材として残しています。

差し替えは `data/presentation.json` の `narrator.robot.name` と `narrator.robot.images.idle` / `broken` を変更します。画像は `assets/` 内のPNG・WebP・SVGに対応し、通常と状態変化後で構図・人物の大きさを揃えます。現在は仮に「芳香ちゃんロボ」としています。追加のアニメーション素材や演出待ちは使いません。

## プロフィールリンクのアイコン

上部のX・pixivリンクには、[Simple Icons](https://github.com/simple-icons/simple-icons)の[X](https://github.com/simple-icons/simple-icons/blob/develop/icons/x.svg)・[pixiv](https://github.com/simple-icons/simple-icons/blob/develop/icons/pixiv.svg)を使っています。同ライブラリの[CC0 1.0 Universal](https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md)を確認し、SVGのパスを `index.html` に同梱しています。アイコンの取得のために外部サービスへ接続する処理はありません。
