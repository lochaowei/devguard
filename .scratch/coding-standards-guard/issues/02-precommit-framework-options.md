# pre-commit 框架比較研究（多語言 + Windows）

Type: research
Status: resolved
Blocked by:

## Question

第三道防線該用哪個 hook 框架？比較 pre-commit（Python framework）、lefthook、husky（+ lint-staged），以及「CLI 自己安裝 `.git/hooks`」的做法，針對：

- 在 Windows 上的安裝與執行穩定度（需要的 runtime、shell、路徑 / 換行問題）
- 多語言 repo 與 monorepo（依目錄跑不同語言工具）的支援
- 只檢查 staged 檔案的能力
- 工具版本鎖定能力（能否與 IDE / Claude Code 使用同一版本，支撐一致性檢查）
- 如何偵測「hook 已安裝」（環境檢查）
- Java（Maven/Gradle）專案的整合方式

產出：事實比較表與取捨，供「pre-commit 框架決策」使用。

## Answer

- 三者產生的 hook 都是 POSIX sh/bash，Windows 依賴 Git for Windows 的 sh；`core.hooksPath` 是硬衝突點（husky 會設定它，pre-commit 遇到就拒絕安裝），環境檢查必須看它。
- pre-commit：staged-only 內建最完整（stash 未 staged 變更），但需 Python、hook 寫死直譯器路徑，工具裝在自己的快取，與 IDE 不同份；無原生 Java 支援。
- lefthook：單一執行檔（winget/scoop/npm/go/pipx），`root`+`glob` 支援 monorepo，指令沿用專案依賴而能與 IDE 同版本；文件未說明部分 staged 檔案處理，找不到執行檔預設放行；`check-install` 只比 checksum。
- husky+lint-staged：lint-staged 的部分 staged 處理與 monorepo 最近設定都成熟，但 Java/Go/Python repo 要多帶 Node。
- CLI 自裝 hook：版本權威與檢查集中，但 staged-only、切塊、平行、共存都要自己實作。

[研究結果](../research/02-precommit-framework-options.md)
