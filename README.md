# starlight-review-importer

X と Bluesky からハッシュタグ `舞台創造科のレビュー` の直近 24 時間の投稿を取得し、未登録分だけを Notion の既存データソースへ追加する最小構成バッチです。

- 実行基盤: Node.js 20 / plain JavaScript / ESM
- 実行方法: GitHub Actions の日次実行、または手動実行
- 重複判定: Notion 側の既存 `作品URL` を全件取得してコード側で比較
- 永続状態: なし
- 既存レコード更新: しない。`作品URL` が一致する既存行はスキップのみ

## 追加する Notion プロパティ

このバッチが書き込むのは次の項目です。

- `作品URL` : 必須
- `更新日` : 必須
- `投稿者アカウント名` : 存在し、かつ rich_text 型なら入力
- title プロパティ: 仮タイトルを必ず入力

仮タイトルは次の形式です。

- X: `[自動取込] X 2026-04-17 @username`
- Bluesky: `[自動取込] Bluesky 2026-04-17 @handle`

`作品名` という名前の title プロパティがあればそれを使い、別名の title プロパティしかない場合はその title プロパティを使います。

## 前提条件

- Node.js 20 系
- Notion integration が対象データソースに接続済み
- X API の bearer token が利用可能
- GitHub Actions secrets を設定できること

## 必須 Secrets

GitHub の `Settings > Secrets and variables > Actions` に以下を設定します。

- `NOTION_TOKEN`
- `NOTION_DATA_SOURCE_ID`
- `X_BEARER_TOKEN`

`NOTION_DATA_SOURCE_ID` は database ID ではなく data source ID を指定してください。

## 任意 Env

- `HASHTAG`
  - 既定値: `舞台創造科のレビュー`
- `IMPORT_LOOKBACK_HOURS`
  - 既定値: `24`
- `DRY_RUN`
  - `true` にすると Notion に書き込まず、追加予定ログだけ出します
- `HTTP_TIMEOUT_MS`
  - 既定値: `15000`

## Notion 側の前提

対象データソースには最低でも次が必要です。

- `作品URL` が `url` 型
- `更新日` が `date` 型
- title プロパティが 1 つ存在すること

次は任意です。

- `投稿者アカウント名` が `rich_text` 型

`作品URL` または `更新日` が存在しない、または型が不一致の場合は明確なエラーで停止します。

## ローカル実行

PowerShell 例:

```powershell
$env:NOTION_TOKEN="secret_xxx"
$env:NOTION_DATA_SOURCE_ID="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
$env:X_BEARER_TOKEN="xxxxxxxx"
$env:HASHTAG="舞台創造科のレビュー"
$env:IMPORT_LOOKBACK_HOURS="24"
$env:DRY_RUN="true"
npm run check
npm run start
```

本番投入時は `DRY_RUN` を外すか `false` にしてください。

## GitHub Actions セットアップ

1. このリポジトリを GitHub に push します。
2. `NOTION_TOKEN` `NOTION_DATA_SOURCE_ID` `X_BEARER_TOKEN` を Actions secrets に設定します。
3. `Actions` タブで `Import review posts` workflow が見えることを確認します。

日次実行は `0 22 * * *` です。日本時間では毎日 07:00 ごろに動きます。

## 手動実行手順

1. GitHub の `Actions` タブを開きます。
2. `Import review posts` を選びます。
3. `Run workflow` を押します。
4. 必要なら以下を指定します。
   - `hashtag`
   - `lookback_hours`
   - `dry_run`
5. 実行ログを確認します。

## 実行ログで見る項目

ログには少なくとも次が出ます。

- `xFetchedCount`
- `blueskyFetchedCount`
- `notionAddedCount`
- `duplicateSkippedCount`
- エラー時の source 名付きメッセージ

Notion 追加前には `notion.record.prepare` ログが出るため、手動実行時の確認にも使えます。

## 実装の流れ

1. 起動時に Notion data source schema を取得
2. `作品URL` と `更新日` の存在と型を検証
3. Notion の既存レコードをページング取得して既存 URL を収集
4. X Recent Search API で `#舞台創造科のレビュー -is:retweet` を取得
5. Bluesky AppView `searchPosts` で `tag=舞台創造科のレビュー` を取得
6. 内部では UTC / ISO 8601 で 24 時間以内かを厳密判定
7. URL 正規化後の `作品URL` で重複を除外
8. 未登録分だけ Notion に追加

## 想定されるエラー

- `Missing required environment variable`
  - Secrets / env が不足しています
- `Notion schema error`
  - `作品URL` や `更新日` の名前や型が要件と一致していません
- `[X] HTTP 401` / `[X] HTTP 403`
  - `X_BEARER_TOKEN` が無効、または API 権限不足です
- `[Bluesky] HTTP ...`
  - Bluesky AppView 側の一時的エラーか制限です
- `[Notion create] HTTP 403` / `404`
  - integration が対象データソースに接続されていない可能性があります
- `Request timed out`
  - API 応答が遅いか、ネットワーク条件が不安定です

## 運用上の注意

- 重複判定は `作品URL` のみです。人手で URL を書き換える運用にすると再取込の原因になります。
- Bluesky は public AppView API を使うため、外部要因の制限を受けることがあります。
- X / Bluesky どちらか片方で取得に失敗しても、成功した側は追加処理を続けたうえで workflow 全体は失敗扱いにします。再実行時は URL 重複判定で二重登録を避けます。
