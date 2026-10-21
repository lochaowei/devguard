# pre-commit 框架決策

Type: grilling
Status: resolved
Blocked by: 02

> 已併入 [CLI 實作語言與分發方式決策](05-cli-runtime-decision.md)，在該票一起決定。

## Question

依據「pre-commit 框架比較研究」的結果，決定第三道防線使用的 hook 框架，以及「hook 已安裝」的環境檢查方式。

## Answer

已併入 [CLI 實作語言與分發方式決策](05-cli-runtime-decision.md) 一起決定。結論：不採用任何 hook 框架，由 CLI 自己安裝一行 POSIX sh 的 hook；專案若已在用 pre-commit、husky 或 lefthook，就在該框架的設定中注入一條呼叫 CLI 的項目。
