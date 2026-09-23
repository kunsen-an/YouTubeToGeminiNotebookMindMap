# YouTube to Gemini Notebook Mind Map

YouTube の動画ページから、チャンネル名の Gemini Notebook ノートブックへ YouTube ソースを追加し、Studio のマインドマップを起動する Manifest V3 Chrome 拡張機能です。

## 使い方

1. Chrome で `chrome://extensions/` を開きます。
2. 「デベロッパー モード」を有効にします。
3. 「パッケージ化されていない拡張機能を読み込む」から、このフォルダを選びます。
4. YouTube の動画ページを開き、拡張機能アイコンをクリックします。
5. 字幕がある動画なら「Gemini Notebookに追加」を押します。

## 実装概要

- `popup/`: YouTube 動画情報と進捗を表示するポップアップ UI。
- `content/youtube.js`: YouTube DOM、`ytInitialPlayerResponse`、oEmbedから表示タイトル、ソース照合用タイトル、チャンネル名、URL、サムネイル、字幕有無を取得。SPA遷移時は動画IDの一致を確認。
- `background.js`: Gemini Notebook タブを開く、前面化する、Content Script を呼び出す、進捗を保存する。
- `content/notebooklm.js`: Gemini Notebook の Web UI を DOM 操作で自動操作する。

## 再実装・検証用仕様

- `REQUIREMENTS_SPECIFICATION.md`: 現在と同等の拡張機能を再実装するための要求仕様の正本
- `TEST_SPECIFICATION.md`: 過去の不具合を含む自動テスト・実画面テスト仕様の正本
- `TESTING.md`: 現在同梱している自動テストの実行方法

## Gemini Notebook 操作の注意

Gemini Notebook は公式 API を使わず Web UI を操作しているため、画面構造や文言が変わると調整が必要です。主な調整箇所は `content/notebooklm.js` の以下です。

- `waitForClickableByText(...)` に渡しているボタン文言
- `waitForInput(...)` に渡している入力欄セレクタ
- `isNotebookOpen()` の画面判定文言

Angular のフォーム更新に必要な `input` / `change` イベント発火と、操作前のタブ前面化は実装済みです。

マインドマップの名前変更では、Studioの独自要素 `nb-icon-button` 内の実ボタン（open Shadow DOMを含む）を操作します。操作メニューの候補と内部ボタンの表示状態はデバッグログの `mindmap:menu-candidates` に記録します。

操作完了は固定時間では待たず、DOM変更通知、入力・クリック等の状態変更イベント、Chromeのタブ更新イベントで判定します。時間指定は異常終了の上限タイムアウトにだけ使用します。

YouTubeでタイトルまたはタイトル・サムネイルのA/Bテストが行われている場合、ブラウザ表示タイトルとGemini Notebookのソース名が異なることがあります。ポップアップとマインドマップ名にはブラウザ表示タイトル、既存ソース照合にはYouTube oEmbedの標準タイトルを使用します。

ソース一覧が仮想スクロールされる場合は一覧全体を探索します。同じ動画が過去の不具合等で複数登録されている場合も、そのうち1件だけを選択して処理を継続します。

ソース照合は動画IDを優先し、取得できない場合はタイトル全体を照合します。タイトルの先頭部分だけでは判定しません。ただし、URLが画面に公開されていない同名の別動画は、タイトルだけでは区別できません。

YouTubeホームや検索結果から動画へ移動した場合も情報取得できます。情報取得中に動画が切り替わった場合は、最大3回まで取得し直します。処理中の再実行は拒否し、ポップアップを開き直した場合も処理中の表示を復元します。
