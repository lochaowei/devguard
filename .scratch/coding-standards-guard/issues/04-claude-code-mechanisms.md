# Claude Code 擴充機制研究

Type: research
Status: resolved
Blocked by:

## Question

第二道防線能用 Claude Code 的哪些機制實現「事前 / 事中 / 診斷」三個角色？整理：

- Plugin 的打包、發佈（marketplace）與安裝方式；團隊如何統一安裝
- Hooks：PostToolUse / PreToolUse / Stop 等事件、matcher、如何把檢查失敗回饋給 Claude 讓它自行修正、exit code 語意、在 Windows 上執行的 shell
- Skills、slash commands、CLAUDE.md 在「告知專案標準」上的分工
- 專案層 `.claude/settings.json` 與使用者層設定的優先序；如何偵測某個 hook / plugin 是否已啟用（環境檢查）

產出：機制清單與限制，供 Claude Code 整合細節的後續票使用。

## Answer

- 事前：CLAUDE.md（建議性 context）+ `.claude/rules/*.md` 的 `paths` frontmatter 可依副檔名注入各語言標準；plugin 根目錄 CLAUDE.md 不載入，plugin 內須用 skill。
- 事中：`PostToolUse`（matcher `Edit|Write`，路徑在 `tool_input.file_path`）以 exit 2 + stderr 或 `decision:"block"`/`additionalContext`（上限 10,000 字元）回饋 Claude；無法撤銷寫入；Bash 改檔不觸發，可用 `Stop`/`PostToolBatch` 補。
- 診斷：skill 即 slash command（`disable-model-invocation: true`，可用 `` !`cmd` `` 嵌入 CLI 輸出）。
- 發佈：plugin + marketplace；團隊用 `.claude/settings.json` 的 `extraKnownMarketplaces`+`enabledPlugins`（需 workspace trust），全組織用 managed settings。偵測：`claude plugin list --json`、`/status`、`/hooks`、`--debug`。
- Windows：hook 預設 Git Bash，無則 PowerShell；exec form（`args`）需真 `.exe`，`.cmd` shim 不行 → 用 `node`+腳本或原生 CLI 最穩。
- 優先序：managed > `--settings` > local > project > user；清單與 hooks 跨層合併。

[研究結果](../research/04-claude-code-mechanisms.md)

## Answer

- 事前：CLAUDE.md（建議性 context）+ `.claude/rules/*.md` 的 `paths` frontmatter 可依副檔名注入各語言標準；plugin 根目錄 CLAUDE.md 不載入，plugin 內須用 skill。
- 事中：`PostToolUse`（matcher `Edit|Write`，路徑在 `tool_input.file_path`）以 exit 2 + stderr 或 `decision:"block"`/`additionalContext`（上限 10,000 字元）回饋 Claude；無法撤銷寫入；Bash 改檔不觸發，可用 `Stop`/`PostToolBatch` 補。
- 診斷：skill 即 slash command（`disable-model-invocation: true`，可用 `` !`cmd` `` 嵌入 CLI 輸出）。
- 發佈：plugin + marketplace；團隊用 `.claude/settings.json` 的 `extraKnownMarketplaces`+`enabledPlugins`（需 workspace trust），全組織用 managed settings。偵測：`claude plugin list --json`、`/status`、`/hooks`、`--debug`。
- Windows：hook 預設 Git Bash，無則 PowerShell；exec form（`args`）需真 `.exe`，`.cmd` shim 不行 → 用 `node`+腳本或原生 CLI 最穩。
- 優先序：managed > `--settings` > local > project > user；清單與 hooks 跨層合併。

[研究結果](../research/04-claude-code-mechanisms.md)
