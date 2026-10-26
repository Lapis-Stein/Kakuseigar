# アクセス解析と公開集計

この文書は実装仕様、導入状況と有効化の手順です。2026-10-26に計測コードを本番公開済みです（`main` の `724f132`、[公開実行の成功記録](https://github.com/Lapis-Stein/Kakuseigar/actions/runs/40287180572)）。初回の定期集計用ワークフローはGoogleへの認証に成功しましたが、集計応答の指標型検証で停止しており、公開集計は準備中です。導入前の訪問・推薦は復元できません。

測定IDは `G-LX9EPBLR4G`、GA4プロパティIDは `560779823` です。これらは公開してよい識別子で、認証情報ではありません。プロパティのタイムゾーンは `Asia/Tokyo`、拡張計測機能はオフであることを確認済みです。

## 公開する4つの表示

| 表示 | 数えるもの |
| --- | --- |
| 来訪者カウンター | 本日と計測開始日以降の訪問回数。GA4の `sessions` を使用し、人数やページ表示回数とは区別する |
| 本日のお薦めランキング | 日本時間の本日、各回で最初に紹介した作品の回数 |
| 今までのお薦めランキング | 計測開始日以降、各回で最初に紹介した作品の回数 |
| 結果カードの足跡 | 日本時間の今月、その作品が各回の最初の一作になった回数 |

「一回」は新しく案内を始めてから遊び直すまでです。一人が遊び直すと別の回になります。再読込・続きからの再開・履歴の閲覧では、同じ推薦を加算しません。訪問の区切りはGA4のセッションに従うため、案内の回数とは一致しません。[GA4のセッション](https://support.google.com/analytics/answer/9191807?hl=ja)

ランキングは上位3位までを同率込みで表示します。更新日時と累計の開始日を添え、本日分は更新時点の速報として扱います。準備中・取得失敗・日付をまたいだ未更新の数字を0件として表示しません。前月の数字を今月の足跡に流用せず、更新から24時間を超えた場合は遅れを表示します。

## 送信する節目と項目

送信先はGoogle アナリティクスです。`src/analytics.js` が送信項目を限定します。

| イベント | 発生条件 | 固有の項目 |
| --- | --- | --- |
| `page_view` | 本番ページの読込時に1回。hashによる画面移動では送らない | ページの固定情報 |
| `play_start` | 新しい案内を始めたときに1回 | 案内共通項目 |
| `work_recommended` | その回で新しい作品を紹介したとき | 案内共通項目、`work_id`、`recommendation_index`、`recommendation_route`、`first_recommendation`、質問の概要7項目 |
| `work_opened` | 作品のpixiv本文リンクを開いたとき | `work_id`、`recommendation_context`、`link_source`。結果・履歴の場合は案内共通項目、推薦の順番・経路・初回判定、`first_work_open` も付ける |

- カスタムイベント共通：`analytics_version`、`dataset_version`、`app_version`。
- 案内共通項目：`play_start_day`（開始した日本時間の日付）、`initial_set`（開始時の質問セットID）、`total_works`（その回の対象作品数）。
- `work_id`：公開用データに存在する作品IDに `work_` を付けて送信する（例：公開ID `01` → 送信値 `work_01`）。GA4で数字だけの値が数値として扱われ、先頭の0が失われることを防ぐ。
- `recommendation_index`：その回の何作目か。1から始まる。
- `recommendation_route`：通常質問からの `ordinary`、人物質問からの `favorite`。
- `first_recommendation`：1作目なら文字列 `yes`、2作目以降は `no`。
- `recommendation_context`：結果・履歴は `recommended`、公開ランキングは `ranking`。
- `link_source`：`result`、`history`、`ranking_today`、`ranking_all_time`。
- `first_work_open`：その回で最初の本文リンク利用なら `yes`、別作品の2回目以降は `no`。ランキングには付けない。

質問の概要は、前の推薦から今回の推薦までにタブ内で貯めた件数です。初回は開始から最初の推薦までを表します。

| パラメーター | 内容 |
| --- | --- |
| `question_count` | 新しく表示した質問の総数 |
| `ordinary_question_count` | 通常質問の表示数 |
| `favorite_question_count` | 人物質問の表示数 |
| `answer_count` | 通常質問の回答操作数 |
| `skip_count` | 通常質問のスキップ数 |
| `undo_count` | 回答を戻す操作数 |
| `favorite_answer_count` | 人物質問の回答操作数 |

同じ質問の再表示は表示数に加算せず、回答し直しは操作数に含みます。各件数は最大999で打ち切ります。次の推薦に届かず離脱した区間の質問概要は送信しないため、離脱直前の設問や全利用者の総操作数は分かりません。

結果・履歴の本文リンクは、その回の同じ作品について最初の1回だけ記録します。ランキングのリンクはページ読込中、ランキング種別と作品の組み合わせごとに1回です。ランキング経由の利用を推薦後の利用に混ぜません。計測導入前の保存済み進行や、整合しない保存状態から、過去の開始・推薦を後付けで送ることはありません。

## 作者が参照する集計

| 確かめたいこと | 集計方法 |
| --- | --- |
| 訪問から案内を始めるまで | `sessions` と `play_start` の件数を並べる。同じ訪問内の遊び直しがあるため、比率を人数の割合と呼ばない |
| 開始から初回推薦まで進んだ割合 | `play_start` と `work_recommended` の `first_recommendation=yes` を比較する |
| 作品の届き方 | 作品別の初回推薦数・全推薦数・推薦順・`ordinary` / `favorite` の内訳を見る |
| 全作品の紹介まで進んだ回数 | 同じ `dataset_version` に絞り、その版の対象作品数と `recommendation_index` が等しい `work_recommended` を数える。紹介の到達であり、全作品の閲覧・読了ではない |
| 推薦後に本文へ進んだ割合 | `recommendation_context=recommended` の `work_opened` を使用。作品別では対応する推薦件数、回単位では `first_work_open=yes` と開始件数を比較する |
| 質問の負担 | 初回推薦に絞った問数・スキップ・戻る操作の合計と平均、継続区間の同じ指標を見る |
| 変更前後の違い | `initial_set`、`dataset_version`、`app_version`、`analytics_version` 別に比較する |

開始と結果が別の日になる場合があります。到達率は同じ `play_start_day`・同じ版の集団でそろえ、後から届く結果を待って判断します。GA4に個別の案内IDは送らないため、個々の回答経路の再構成や、開始・結果の完全な照合はできません。本文リンクの利用は読了・満足度・作品の評価を意味しません。

## Google側のカスタム定義

GA4「管理 → データの表示 → カスタム定義」で、次のイベントパラメーターを登録します。表示名は日本語でも構いませんが、パラメーター名は完全一致させます。

2026-10-26時点で、下表のカスタムディメンション12項目とカスタム指標8項目を登録し、管理画面で保存を確認済みです。

| 種類 | イベントパラメーター | 用途 |
| --- | --- | --- |
| イベントスコープのディメンション | `work_id`、`first_recommendation` | **公開集計に必須** |
| イベントスコープのディメンション | `recommendation_index`、`recommendation_route`、`recommendation_context`、`link_source`、`first_work_open` | 作者向けの推薦・本文リンク分析 |
| イベントスコープのディメンション | `play_start_day`、`initial_set`、`dataset_version`、`app_version`、`analytics_version` | 開始日・質問セット・版ごとの比較 |
| カスタム指標（イベント、単位「標準」） | `question_count`、`ordinary_question_count`、`favorite_question_count`、`answer_count`、`skip_count`、`undo_count`、`favorite_answer_count`、`total_works` | 問数・操作数と対象作品数 |

標準のイベント名・イベント数・セッション数・日付は重複登録しません。定義の登録直後はレポートへの反映を待つ必要があります。登録前の値を後から使える前提にせず、本番公開前に準備します。[カスタムディメンションの作成](https://support.google.com/analytics/answer/14239696?hl=ja)・[カスタム定義について](https://support.google.com/analytics/answer/14240153?hl=ja)

## 通信量とプライバシーの境界

- 質問表示・回答・スキップ・戻る操作のたびには送信しません。案内開始、新しい推薦、本文リンク利用の節目で小さな項目を送ります。
- Googleタグは本番の `https://lapis-stein.github.io/Kakuseigar/` でだけ読み込みます。ローカル確認や別ホストでは読み込みません。タグ取得・自動収集イベントも通信を使うため、通信回数やバイト数を固定とは約束しません。
- Googleタグが利用できるまでの独自イベント待機は64件までで、読込失敗後は破棄します。送信完了を待って画面や外部リンクの移動を止める処理、自前の送信再試行はありません。
- 質問文、選択した回答、人物名、回答履歴一式、配点、推薦の評価根拠、作品本文、ローカルの案内識別子は送信しません。
- 送信する `page_location` は本番入口に固定し、queryとhashを含めません。参照元はサイトのoriginまでに限定し、パスやqueryを除きます。広告ストレージ・広告ユーザーデータ・広告パーソナライズは拒否、Googleシグナルと広告パーソナライズ用シグナルは無効にします。
- GA4はCookieなどの識別子や標準の訪問情報を扱います。「個人情報が一切扱われない」「完全に匿名」とは説明しません。「この案内について」から計測を停止・再開でき、ページを再読込せずに切り替えます。
- 計測設定はまず `localStorage` に保存し、保存できない場合は `sessionStorage` に保存します。どちらにも保存できない場合は開いているページ内だけに適用します。画面に保存範囲を表示し、設定を保存できない状態で再読込して計測が再開することを避けます。案内中の重複防止にも `sessionStorage` を使います。
- 計測拒否、ブロッカー、通信失敗、保存機能の制限などで未計測・重複が起こり得ます。数字は計測できた範囲の記録です。

公開集計は同じサイトの `data/public-stats.json` をページ読込中に1回だけ取得して再利用します。画面を移るたびの取得や定期ポーリングは行いません。読込上限は32KiB、タイムアウトは7秒です。訪問者のブラウザーからGoogleの集計APIを呼び出すことはありません。

## 公開集計の取得と更新

`scripts/export-public-stats.mjs` はNode.js 22の標準機能だけで動作します。GA4 Data APIの `batchRunReports` を1回呼び、訪問2期間と初回推薦3期間、計5レポートを取得します。公開URLに完全一致するイベントだけを対象とし、推薦は `eventName=work_recommended` かつ `customEvent:first_recommendation=yes` の `eventCount` を `customEvent:work_id` ごとに集計します。[batchRunReportsの仕様](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/batchRunReports)

公開JSONはスキーマ版、状態、生成日時、日本時間の日付・月、計測開始日、訪問回数、作品ID別の初回推薦回数だけです。集計時に `work_01` などの送信値を、`data/runtime.json` の許可済みIDとの対応表で `01` などの公開IDへ戻します。未知の値やprefixなしの別表記を推測で取り込みません。GA4の生レポート、作者向けの分析、認証情報は出力しません。

認証失敗、期間・タイムゾーンの不一致、壊れた応答、行の欠落、サンプリング、しきい値による制限などでは更新を中止します。完全な正常応答で該当行がない場合だけ0件とし、全検証後にファイルを置き換えます。取得失敗で最後の正常な集計を壊さず、ワークフローも公開前に停止します。

### 初回の準備

1. カスタム定義を登録する。`PUBLIC_STATS_ENABLED` は未設定または `false` のまま、Pagesの公開元は従来の「Deploy from a branch」（`main`）を維持する。
2. 計測コードと準備中の `data/public-stats.json` を `main` に反映し、従来のPages公開で先に計測コードを本番へ出す。本番のHTMLは `src/app.js` を直接読むため、集計APIや新しい公開ワークフローの成功は必要ない。公開成功を確認し、送信を始めた**実際の日本時間の日付**を `GA4_COLLECTION_STARTED_ON` に記録する。開発日やプロパティ作成日で代用しない。
3. Google CloudでAnalytics Data API、IAM、Cloud Resource Manager、IAM Service Account Credentials、Security Token Serviceの各APIを有効にする。集計専用サービスアカウントをGA4プロパティの「閲覧者」として追加する。[Data APIの準備](https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart)・[WIFの準備](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)
4. GitHub ActionsからのWorkload Identity Federation（WIF）を設定する。発行元はGitHub Actionsとし、信頼するリポジトリを `Lapis-Stein/Kakuseigar`、ブランチを `refs/heads/main` に制限する。対応する主体にサービスアカウントの `roles/iam.workloadIdentityUser` を付与する。長期JSONキーは作らない。[Googleの認証アクションと設定手順](https://github.com/google-github-actions/auth)
5. GitHubのリポジトリ変数（Settings → Secrets and variables → Actions → Variables）を下表のとおり登録する。計測コードの本番公開後に、Pagesの公開元をGitHub Actionsへ切り替え、`github-pages` 環境が `main` からの公開を許可していることを確認する。[Pagesのワークフロー](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
6. 最後に `PUBLIC_STATS_ENABLED=true` とし、`main` の「Update public statistics」を手動実行する。成功した公開結果を確認する。GA4やカスタム定義の反映待ちで失敗した場合も、計測コードは先に公開されているため、次回の集計で再確認できる。集計失敗を無視して準備中JSONを再公開する処理は追加しない。

| リポジトリ変数 | 設定値 |
| --- | --- |
| `PUBLIC_STATS_ENABLED` | `true` |
| `GA4_PROPERTY_ID` | `560779823` |
| `GA4_COLLECTION_STARTED_ON` | `2026-10-26` |
| `GCP_WIF_PROVIDER` | `projects/757229369493/locations/global/workloadIdentityPools/github-actions/providers/kakuseigar` |
| `GCP_SERVICE_ACCOUNT` | `kakuseigar-stats-reader@kakuseigar-stats-560779823.iam.gserviceaccount.com` |

`.github/workflows/update-public-stats.yml` は `main`・有効化済み・必要変数がすべてある場合だけ実行します。毎時00分（UTC基準）に、その実行が対象とする最新の `main` を検証・テストし、集計・ビルド後にサイト全体を公開します。生成した集計をリポジトリにコミットしません。

Actionsへの移行後はpush直後の自動公開はなく、`main` の変更は次回の定期実行に含まれます。すぐに反映したい場合は、Actionsの「Update public statistics」から「Run workflow」を選び、ブランチ `main` で手動実行します。GA4からの取得に失敗した場合はその回の公開全体を中止するため、集計だけでなくアプリ本体も直前の公開内容を維持します。

GitHubの定期実行は遅延や実行の欠落があり、公開リポジトリで60日間活動がない場合は自動停止します。停止した場合はActionsで対象ワークフローを開き「Enable workflow」で再有効化し、必要に応じて手動実行します。毎時更新が永続的に保証される設計ではありません。[定期実行の制約](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)・[ワークフローの再有効化](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)

認証時は `analytics.readonly` スコープの有効期間300秒のアクセストークンを取得し、集計処理の `GOOGLE_OAUTH_ACCESS_TOKEN` にだけ渡します。認証ファイルを作らず、トークンを公開ファイル・ログ・手順書に貼りません。手動のローカル取得にも同環境変数と `GA4_PROPERTY_ID`、`GA4_COLLECTION_STARTED_ON` が必要です。

更新予定が1時間ごとでも、GA4の処理とGitHubの実行には遅れがあり、リアルタイム表示ではありません。直近の件数は後で増減する可能性があります。手動・別経路でサイトを公開する場合も、稼働中の正常な集計を初期の準備中JSONで上書きしないようにします。[GA4のデータ更新について](https://support.google.com/analytics/answer/11198161?hl=ja)

### 導入・設定記録

2026-10-26時点で、請求先を紐付けずに以下のGoogle側設定を作成・保存し、管理画面で確認しています。GitHubにも上表の5変数を登録済みです。Pagesの公開元はGitHub Actionsへ移行し、公開対象を `main` のみに設定しています。集計の定期実行は毎時00分です。

[初回の集計実行](https://github.com/Lapis-Stein/Kakuseigar/actions/runs/40287540781)はWIF認証に成功し、集計応答の指標型検証で停止しました。原因を確認中で、公開集計の更新成功はまだ確認していません。停止した実行ではサイトを再公開せず、先に公開した計測コードと準備中の集計表示を維持しています。

| 項目 | 確認した設定 |
| --- | --- |
| 専用プロジェクト | ID `kakuseigar-stats-560779823`、プロジェクト番号 `757229369493` |
| 有効化済みAPI | `analyticsdata.googleapis.com`、`iam.googleapis.com`、`cloudresourcemanager.googleapis.com`、`iamcredentials.googleapis.com`、`sts.googleapis.com` |
| サービスアカウント | 上表の `kakuseigar-stats-reader`。Cloudプロジェクトのロール付与なし、JSONキー作成なし |
| GA4側の権限 | プロパティ `560779823` の「閲覧者」。費用・収益のデータアクセスを制限 |
| WIF | プール `github-actions`、プロバイダー `kakuseigar` |
| 発行元・audience | `https://token.actions.githubusercontent.com`、既定のaudience |
| サービスアカウントへの接続 | `repository_id` が `1429572780` に一致する主体だけを選択して保存 |

保存した属性マッピングは次の2項目です。条件では受け取ったトークンの `assertion` を参照します。

```text
google.subject = assertion.sub
attribute.repository_id = assertion.repository_id
```

保存した属性条件は、対象リポジトリ・所有者・`main`・この集計ワークフロー・定期実行または手動実行に限定します。

```text
assertion.repository_id == '1429572780' &&
assertion.repository_owner_id == '319625512' &&
assertion.ref == 'refs/heads/main' &&
assertion.workflow_ref == 'Lapis-Stein/Kakuseigar/.github/workflows/update-public-stats.yml@refs/heads/main' &&
assertion.event_name in ['schedule', 'workflow_dispatch']
```

## 実装時の呼び出し口

`createAnalytics({ measurementId, canonicalUrl, datasetVersion, appVersion, workIds })` が以下を返します。`src/analytics-config.js` には公開IDと版番号だけを置きます。

| 呼び出し | 役割 |
| --- | --- |
| `sync(state)` | 保存済み案内との整合確認。過去のイベントは再送しない |
| `start(state)` | 新しい案内の開始を記録 |
| `questionShown(key, type)` | 質問の新規表示をローカル加算。`type` は `ordinary` / `favorite` |
| `questionAction(kind)` | 操作をローカル加算。`answer` / `skip` / `undo` / `favorite_answer` |
| `recommend(result)` | 新しい推薦と、その直前区間の質問概要を記録 |
| `click(workId, source, result)` | 本文リンク利用を記録。ランキングでは `result` 不要 |
| `reset()` | ローカルの案内計測状態を破棄 |
| `enabled` / `available` / `setEnabled(bool)` | 利用者の設定・送信先の適合判定・計測切替。画面側は切替後に表示だけを更新し、ページを再読込しない |
| `preferenceScope` | 設定の保存範囲。`browser` はブラウザー、`tab` はそのタブ、`page` は開いているページ内だけ |
| `preferencePersisted` | 設定を保存できたか。`page` の場合は `false` |

`createPublicStats()` の `load()` は取得結果を共有し、`counter()`、`rankings()`、`footprint(workId)` が表示を返します。コード変更後は `node --test` と `node scripts/check.mjs` で、送信項目の限定、重複防止、日付境界、集計失敗時の保持を確認します。

## 実装時の確認記録

2026-10-26の確認では、単体テスト、既存の `scripts/browser-check.mjs`、追加した `scripts/analytics-browser-check.mjs` が成功しました。これはローカルでの動作確認であり、Googleへの本番データの到着や、認証を含む定期集計の稼働確認とは区別します。
