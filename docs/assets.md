# 素材の配置

現在は、作者が別の制作作業で生成した青娥の表情差分10枚を `assets/seiga/` に配置しています。原画像の色・透明度・寸法を変更せず使い、画面上の大きさと下端の見せ方をCSSで調整します。名前と台詞の会話欄を下部へ重ね、原画像の切れ目が露出しないようにしています。スマホでは上半身を大きく表示します。

現在の背景は `assets/study/study-v1.png` です。作者が提示した絵の建築・色調・昼光を参考に、Codex内蔵image_genで無人の書斎を生成しました。人物や文字を含まず、立ち絵と画面部品を別に重ねています。以前の `assets/lounge/lounge-v1.png` は比較用に残しています。生成条件の記録は制作資料側で管理しています。

| 画像 | 場面 |
| --- | --- |
| `assets/seiga/idle.png` | 開始・履歴・質問中の抽選候補 |
| `assets/seiga/recommend.png` | 作品のお薦め |
| `assets/seiga/tease.png` | 旧来の寄り道用。現在の質問中の抽選には含めない |
| `assets/seiga/amused.png` | 質問中の抽選候補 |
| `assets/seiga/listening.png` | 質問中の抽選候補：耳を傾ける |
| `assets/seiga/adjusting-glasses.png` | 質問中の抽選候補：眼鏡を直す |
| `assets/seiga/thinking.png` | 質問中の抽選候補：思案する |
| `assets/seiga/sleeve-smile.png` | 質問中の抽選候補：袖口で笑う |
| `assets/seiga/celebrate.png` | 全作品を紹介した時 |
| `assets/seiga/ending.png` | 最後の会話 |

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

例：`"idle": "assets/seiga/idle.png"`。未登録の表情では `idle` を使い、それもない場合は文字の案内枠を使います。

通常質問と人物質問では、次の設問に進むたびに6種類から直前の絵を除いて抽選します。同じ設問の再描画や説明・履歴からの復帰では表示を維持し、待機中の自動切り替えはしません。回答内容や推薦点数は抽選に渡しません。お薦め・お祝い・最後の会話は専用の表情です。

キャンバスの大きさと顔の位置を揃え、腰から太もも上程度までを収める想定です。台詞・背景・画面部品は画像に描き込まない方が扱いやすくなります。スマホでは上端を基準にバストアップで切り取るため、下側の手などは画面に収まらない場合があります。

`assets/og-card.svg` はサイト共通の紹介画像の編集元、`assets/og-card.png` は共有カード向けの配信用画像です。画像を変更した場合はPNGとHTMLの紹介情報も揃えてください。
