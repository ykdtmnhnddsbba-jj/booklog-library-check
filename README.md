# booklog-library-check

ブクログの「読みたい・積読・未設定」の本が、池田町図書館・神戸町立図書館にあるか（貸出可か）を調べて、GitHub Pagesに表示します。

## 仕組み
- **本の一覧**: `data/shelf.json`（ブクログの本棚の書き出し）。ブクログはGitHubのサーバーからのアクセスをボット判定ではじくため、ふだん使っているブラウザで書き出して置く（手順は公開ページの `tools.html`、コードは `tools/export-shelf.js`）。本を追加したときだけ更新すればよい。
- **貸出状況**: GitHub Actions（`.github/workflows/update.yml`）が3時間おきと、`shelf.json` を更新したときに `scripts/update.mjs` を実行
  1. `data/shelf.json` を読む
  2. カーリルAPIで所蔵・貸出状況を取得。「蔵書なし」だった本は `noneRecheckDays`（7日）の間は再確認せず前回結果を再利用
  3. `data.json` と `web/` のページをGitHub Pagesに公開
- ページの「貸出状況を最新に更新」は、ブラウザからカーリルへ直接問い合わせる（APIキーはその端末のブラウザにだけ保存）

## 設定
- `config.json`: 図書館（カーリルのsystemid）、対象の読書状況（1=読みたい, 4=積読, 0=未設定）
- リポジトリのSecrets: `CALIL_APPKEY`（カーリルのAPIキー）
- Settings → Pages → Source: **GitHub Actions**

## 手動実行
Actions タブ → update → Run workflow
