# booklog-library-check

ブクログの「読みたい・積読・未設定」の本が、池田町図書館・神戸町立図書館にあるか（貸出可か）を調べて、GitHub Pagesに表示します。

## 仕組み
- GitHub Actions（`.github/workflows/update.yml`）が3時間おきに `scripts/update.mjs` を実行
  1. ブクログの公開本棚を全件読む（`config.json` の `booklogUser`）
  2. カーリルAPIで所蔵・貸出状況を取得。「蔵書なし」だった本は `noneRecheckDays`（7日）の間は再確認せず前回結果を再利用
  3. `data.json` と `web/index.html` をGitHub Pagesに公開
- ページの「貸出状況を最新に更新」は、ブラウザからカーリルへ直接問い合わせる（APIキーはその端末のブラウザにだけ保存）

## 設定
- `config.json`: ブクログID、図書館（カーリルのsystemid）、対象の読書状況
- リポジトリのSecrets: `CALIL_APPKEY`（カーリルのAPIキー）
- Settings → Pages → Source: **GitHub Actions**

## 手動実行
Actions タブ → update → Run workflow
