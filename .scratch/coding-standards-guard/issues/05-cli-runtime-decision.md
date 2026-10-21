# CLI 實作語言與分發方式決策

Type: grilling
Status: resolved
Blocked by: 01, 02

## Question

依據「CLI 實作語言與 Windows 分發選項研究」的結果，決定核心 CLI 的實作語言、Windows 上的安裝 / 更新方式，以及三道防線呼叫它的方式。

（已併入「pre-commit 框架決策」：兩者高度耦合——選 pre-commit 等於每台機器都有 Python——故一起決定第三道防線的 hook 框架與「hook 已安裝」的環境檢查方式。）

## Answer

**CLI 形式與分發**
- 以 **TypeScript** 撰寫，用 **Bun `--compile`** 打包成單一 `.exe`（windows-x64 / arm64），這是唯一的發佈形式。exe 需做程式碼簽章，避免防毒誤判。
- 主要分發管道是**團隊自架的 Scoop bucket**（不需管理員權限；Scoop 的 shim 是真正的 `.exe`，Claude Code hook 可直接呼叫），內部 release 頁提供 exe 直接下載作為備用。專案要求哪個版本、如何升級，交給「預設標準的版本發佈與專案升級方式」決定。

**三道防線如何呼叫**
- 三道防線都用名稱呼叫 PATH 上的 `<cli>`，不經 shell 包裝；CLI 為每道防線提供專用子指令（例如 `hook git-pre-commit`、`hook claude-post-edit`），各自的輸入格式與 exit code 由 CLI 內部處理，三邊的設定都只剩一行。
  - VS Code：`tasks.json` 使用 `"type": "process"`，搭配 problem matcher。
  - Claude Code：hook 以 exec form 直接執行。
  - git hook：一行 `exec <cli> check --staged` 的 POSIX sh 腳本。

**第三道防線（git hook）**
- 不使用 pre-commit、lefthook、husky 等框架，**由 CLI 自己安裝 hook**。若專案已在用其中一種框架，就在該框架的設定中注入一條呼叫 CLI 的項目，不覆寫它的 hook（husky 與 pre-commit 會在 `core.hooksPath` 上衝突）。
  - pre-commit：一條 `language: unsupported` 的 local hook。
  - husky：在 `.husky/pre-commit` 加一行。
  - lefthook：加一個 job。
- **找不到 CLI 就擋下 commit**，訊息附上安裝指令，並提示可用 `--no-verify` 暫時略過。
- **部分 staged 的檔案**：檢查工作目錄中的版本並印出警告，不暫存、也不還原任何檔案。
- **hook 只做檢查、不自動修正**：失敗時印出 `<cli> fix <files>`，修正只透過明確執行的 `<cli> fix` 進行。

**環境檢查**
- 判斷「hook 已安裝」：
  1. 讀取 `core.hooksPath` 及其設定來源。
  2. 若專案使用既有框架，確認其設定中有呼叫 CLI 的項目；否則確認 hook 檔案存在、有 CLI 標記且 checksum 正確。
  3. `core.hooksPath` 指向 `/dev/null` 或不存在的目錄時，回報為錯誤。
- 確認 `<cli>` 在 PATH 上，而且是正確版本。

**讓開發者真的安裝 hook**
- VS Code 用 `runOn: folderOpen` 的任務、Claude Code 用 `SessionStart` hook，兩者都執行 `<cli> doctor --quiet`。
- doctor 只回報問題並附上修正指令（例如 `<cli> install`），不自動安裝；安裝由開發者執行，或經開發者同意後由 Claude 代為執行。

研究依據：[01 研究結果](../research/01-cli-runtime-options.md)、[02 研究結果](../research/02-precommit-framework-options.md)

### 修訂（2026-10-22）

公司環境不允許下載外部檔案，因此 Scoop bucket 與 exe 的下載網址都必須指向公司內部。

### 修訂（2026-10-22，來自[Claude Code 防線整合設計](13-claude-code-integration.md)）

第三道防線新增 **pre-push** hook，負責完整的測試、覆蓋率，以及開啟時的弱點掃描。它的安裝方式、注入既有 hook 框架的方式，以及「已安裝」的環境檢查，都比照 pre-commit。

### 修訂（2026-10-22，來自[fix 行為與檢查報告格式](17-fix-and-report-format.md)）

git hook 失敗時印出的修正指令改為 `<cli> fix --code <files>`（`fix` 只修設定，`fix --code` 修程式碼）。
