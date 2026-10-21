# 研究：Claude Code 擴充機制（第二道防線的實現素材）

對應票：[04-claude-code-mechanisms](../issues/04-claude-code-mechanisms.md)
查證日期：2026-10-22，來源皆為 code.claude.com 官方文件（版本號以文件所載為準）。本文只整理機制與限制，不做最終設計決定。

---

## 1. 三個角色與可用機制對照

| 角色 | 主要機制 | 次要／替代機制 |
| :- | :- | :- |
| 事前（告知標準） | `CLAUDE.md`、`.claude/rules/*.md`（可依 `paths` 依檔案類型載入）、skill | `AGENTS.md`、`SessionStart` hook 的 `additionalContext` |
| 事中（跑檢查並回饋） | `PostToolUse` hook（matcher `Edit\|Write`） | `PostToolBatch`、`Stop` hook（收尾前整體檢查）、`PreToolUse`（阻擋）、async hook |
| 診斷 | slash command（= skill，`disable-model-invocation: true`） | skill 內 `` !`cmd` `` 動態注入 CLI 輸出 |
| 打包發佈 | plugin + marketplace | 直接提交 `.claude/settings.json` + `.claude/skills/` |

---

## 2. Plugin：打包、發佈、安裝

### 2.1 目錄結構
- 清單檔 `.claude-plugin/plugin.json`（**可省略**；省略時依標準目錄載入）。唯一必填欄位 `name`（kebab-case，所有元件以它為命名空間，例如 `/my-plugin:check`）。
- 標準目錄（皆在 plugin 根目錄，不在 `.claude-plugin/` 內）：`skills/<name>/SKILL.md`、`commands/`（舊式，新 plugin 建議用 skills）、`agents/`、`hooks/hooks.json`、`.mcp.json`、`.lsp.json`、`bin/`（啟用時加入 Bash 工具的 `PATH`）、`settings.json`。
- **plugin 根目錄的 `CLAUDE.md` 不會被載入**為 context，`claude plugin validate` 會警告；要放入 context 的指示必須做成 skill。
- 所有元件路徑須以 `./` 開頭、不得以 `..` 逃出 plugin 根目錄。
- `hooks/hooks.json` 須包一層頂層 `"hooks"` 鍵；manifest 的 `hooks` 欄位會與它**合併**。
- 可宣告 `.lsp.json`（如 `gopls`），其 `diagnostics` 預設 `true`，會在編輯後把診斷推進 context ——這是另一條「事中回饋」路徑。
- `userConfig`：啟用時向使用者詢問設定值；hook 程序可從環境變數 `CLAUDE_PLUGIN_OPTION_<KEY>` 讀取。shell-form hook 不可直接寫 `${user_config.*}`。

### 2.2 路徑變數
| 變數 | 意義 |
| :- | :- |
| `${CLAUDE_PLUGIN_ROOT}` | plugin 已安裝版本的絕對路徑；**更新時會改變**，不可寫入狀態 |
| `${CLAUDE_PLUGIN_DATA}` | `~/.claude/plugins/data/<id>/`，跨更新保留（放 node_modules、快取） |
| `${CLAUDE_PROJECT_DIR}` | 專案根目錄 |

- 這些變數**不會**出現在 Claude 透過 Bash 工具執行的命令環境中；在 skill 內文中要寫 `${...}` 讓 Claude Code 在載入時代換。
- Windows 上代換後的路徑使用正斜線。

### 2.3 Marketplace
- 一個目錄／repo，含 `.claude-plugin/marketplace.json`（必填 `name`、`owner`、`plugins[]`；每個 entry 需 `name` 與 `source`）。
- `source` 型別：相對路徑（`./plugins/x`）、`github`、`git-subdir`（monorepo 子目錄）、`url`、`archive`、`npm`、`command`。git 型可用 `ref` / `sha` 固定版本。
- `plugin.json` 的 `version` 一旦設定，使用者會停在該版本直到你改版號。
- 安裝 ID：`<entry-name>@<marketplace-name>`；entry 名與 manifest 名要一致，否則易出錯。
- 指令：`claude plugin marketplace add <owner/repo | path>`、`claude plugin install x@mkt [--scope user|project|local]`、`claude plugin validate <dir> [--strict]`（CI 用；exit 0/1，非預期錯誤 2）。
- 私有 repo：clone 用使用者本機 git 的既有憑證，**不會提示輸入**；CI 需設定 credential helper（GitHub Actions：`GH_TOKEN` + `gh auth setup-git`）。

### 2.4 團隊統一安裝
兩種範圍：

**(a) 每個 repo（提交 `.claude/settings.json`）**
```json
{
  "extraKnownMarketplaces": {
    "our-mkt": { "source": { "source": "github", "repo": "our-org/our-mkt" } }
  },
  "enabledPlugins": { "standards-guard@our-mkt": true }
}
```
- `extraKnownMarketplaces` 只在使用者**接受該資料夾的 workspace trust 對話框後**才生效；未信任時**靜默忽略、不顯示訊息**。
- 以相對路徑列在 marketplace 中的 plugin，marketplace 生效後即可從其副本載入；**指向外部來源（如 plugin 自己的 GitHub repo）的 plugin 不會只因 repo 設定就安裝**，使用者會看到 `Plugin "<name>" is enabled in project settings but isn't installed`，需自行執行 `claude plugin install <name>@<mkt> --scope project`。
- `-p`／CI：`extraKnownMarketplaces` 只在已信任資料夾生效；安裝在背景進行，第一輪可能缺 plugin，可設 `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1` 等待。

**(b) 全組織（managed settings）**
- 同樣兩個鍵放在 managed settings（claude.ai 後台 server-managed、MDM、或系統路徑 `managed-settings.json`）。下次 session 開始時自動註冊並安裝；使用者在自己層級停用**無效**。
- Windows 的 MDM：整份 JSON 以字串存在 registry value。
- 限制來源：`strictKnownMarketplaces`（白名單）、`blockedMarketplaces`、`disableSideloadFlags`、`allowManagedHooksOnly`、`strictPluginOnlyCustomization`。
- 更新策略：marketplace entry 的 `autoUpdate`；`DISABLE_AUTOUPDATER` 會一併關閉 plugin 自動更新。

---

## 3. Hooks

### 3.1 事件（與本案相關者）
- `PreToolUse`：工具執行前，可阻擋或改寫輸入。
- `PostToolUse`：工具**成功**執行後；輸入含 `tool_input`（檔案工具路徑在 `tool_input.file_path`）與 `tool_response`。每個工具呼叫觸發一次，平行工具呼叫會**併發**觸發。
- `PostToolBatch`：一批工具呼叫全部完成後、下一次送模型前觸發一次；無 matcher；輸入 `tool_calls[]`。適合「同一批多檔編輯只檢查一次」。
- `Stop`：Claude 每次回應結束時（不只是任務完成）；使用者中斷時不觸發。
- `SessionStart`：可注入 context、寫 `$CLAUDE_ENV_FILE` 設環境變數。
- `FileChanged`：任何來源改檔後觸發，**不能阻擋**。
- `ConfigChange`：設定檔變更時（matcher：`user_settings`/`project_settings`/`local_settings`/`policy_settings`/`skills`）。

### 3.2 Matcher
- `*`、空字串或省略：全部。
- 只含字母數字、`_`、`-`、空白、`,`、`|`：**精確比對**或清單，如 `Edit|Write`。
- 含其他字元：視為**未錨定的 JavaScript regex**（`Edit.*` 也會匹配 `NotebookEdit`，要精確用 `^Edit$`）。
- handler 層的 `if` 欄位用權限規則語法，如 `"Edit(*.ts)"`、`"Edit(src/**)"`，只接受一條規則，屬 best-effort 過濾。→ 可用來依副檔名分流語言。

### 3.3 Hook 類型
`command`（stdin 收 JSON）、`http`、`mcp_tool`、`prompt`（模型單輪判斷）、`agent`（實驗性）。
預設逾時：command/http/mcp_tool 600 秒；prompt 30 秒；agent 60 秒；可用 `timeout`（秒）覆寫。

### 3.4 Exit code 語意
| exit | 意義 |
| :- | :- |
| 0 | 成功；stdout 若為單一 JSON 物件則解析，否則當純文字 |
| 2 | 可阻擋事件上的阻擋錯誤，**stderr 回饋為原因** |
| 其他 | 非阻擋錯誤，動作繼續；只顯示 stderr 第一行通知 |

各事件 exit 2 行為：
- `PreToolUse`：阻擋該工具呼叫。
- `PostToolUse`：**無法復原**已執行的工具；**把 stderr 顯示給 Claude**（可當成回饋讓它修正）。
- `Stop`：阻止 Claude 停下，對話繼續。
- exit 1 不是阻擋。exit 2 即使同時輸出 JSON 也仍會阻擋。官方建議每個 hook 只選一種方式（exit 2 + stderr，或 exit 0 + JSON）。

### 3.5 JSON 輸出（回饋給 Claude 的結構化方式）
- 通用：`continue`（false 則整個停止）、`stopReason`、`systemMessage`（給使用者看的警告）。
- `PostToolUse`：頂層 `decision: "block"` + `reason` → reason 附在工具結果旁給 Claude，Claude 仍看得到原輸出；`hookSpecificOutput.additionalContext` → 附加到 context；`updatedToolOutput` → 取代 Claude 看到的輸出（不改變已執行的事實）。
- `additionalContext` 上限 10,000 字元；超過會寫入檔案，Claude 只收到 2,000 字元預覽。→ 檢查報告給 Claude 的格式要精簡。
- `additionalContext` 以 system reminder 形式注入，Claude 當作純文字閱讀。
- stdout 必須只有 JSON；shell profile 中無條件的 `echo` 會讓 JSON 解析失敗（官方 troubleshooting 明列）。

### 3.6 Stop hook 防無限迴圈
- 輸入含 `stop_hook_active`（已因 stop hook 繼續時為 true），應據此放行。
- 內建上限：連續 8 次 stop hook 讓回合繼續後，強制結束（呼叫工具會重置計數；`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` 可調）。

### 3.7 其他執行特性
- 同一事件的多個匹配 hook **平行執行**；多個 `PreToolUse` 回傳 `updatedInput` 時順序不定。
- 各層級的 hooks **合併**；相同 handler 出現在多個設定檔只跑一次，plugin／skill 的副本各自獨立。
- `async: true`：背景執行，不能阻擋；結果於下一輪送達（`asyncRewake` + exit 2 可立即喚醒）。適合跑較慢的完整測試。
- `onFailure: "block"`（需 v2.1.295+）：hook 本身失敗（找不到腳本、逾時、非 0/2 exit、輸出無效）時阻擋動作；否則失敗會**默默放行**。
- 設定檔修改有 file watcher，`hooks` 編輯可在執行中 session 生效。
- Hook 只能透過 stdout/stderr/exit code 溝通，**不能觸發 slash command 或工具呼叫**。
- Hooks 不是硬性安全邊界（官方明言）。

### 3.8 Workspace trust
- 互動式 session：在接受 workspace trust 對話框前，**所有**設定檔（含使用者自己的）hooks 都會被暫緩。
- `-p`／SDK：視為已信任，repo 內 `.claude/settings.json` 的 hooks 會直接執行。

### 3.9 Windows 注意事項（重點）
- command hook 的 `shell` 欄位：`"bash"`（預設）或 `"powershell"`。**Windows 上預設 Git Bash；未安裝 Git Bash 時改用 PowerShell**。可用 `CLAUDE_CODE_GIT_BASH_PATH` 指定 Git Bash 位置。
- `"shell": "powershell"` 自動偵測 `pwsh.exe`（PS 7+），否則退回 `powershell.exe`（5.1）。
- PowerShell shell-form 中寫 `${CLAUDE_PROJECT_DIR}` 或 `$env:CLAUDE_PROJECT_DIR`；Claude Code 會把 `${CLAUDE_...}` 改寫成 `${env:NAME}`（雙引號內有效、單引號內無效）。**不要寫裸 `$CLAUDE_PROJECT_DIR`**（PowerShell 解析為 `$null`）。
- **Exec form**（設定 `args` 時）：不經 shell，直接 spawn `command`。Windows 上 `command` 必須是真正的 `.exe`；`node_modules/.bin` 裡 npm/npx/eslint 的 `.cmd`/`.bat` shim **無法以 exec form 執行**，要改成 `node` + 腳本路徑，或用 shell form。
- 若 PreToolUse/PermissionRequest hook 在沒有 Git Bash 時失敗，錯誤訊息含 `blocking because Git Bash wasn't found ...`。
- 官方範例的 bash 腳本會把 `tool_input.file_path` 的反斜線正規化為正斜線再比對 → Windows 上的檔案路徑會帶反斜線。
- 官方範例大量依賴 `jq`；Windows 未必安裝，文件建議改用 Python/Node 解析 JSON。
- → 推論（非文件結論）：以一支跨平台 CLI（真正的 `.exe` 或 `node` 腳本）做 exec-form hook，可同時避開 Git Bash 有無、jq、`.cmd` shim、引號與路徑分隔符問題。

### 3.10 除錯
- `/hooks`：唯讀瀏覽每個 hook 的來源與完整命令。
- `claude --debug`（log 在 `~/.claude/debug/<session-id>.txt`，不印到終端）或 `--debug-file <path>`；v2.1.296+ 每個 hook 結束會留 `Hooks: PostToolUse:Write [...] finished with status 0 (31ms)` 行。
- `CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose` 看 matcher 細節。

---

## 4. 告知標準：CLAUDE.md、rules、skills、slash commands 的分工

### 4.1 CLAUDE.md
- 位置：managed（Windows `C:\Program Files\ClaudeCode\CLAUDE.md`，不可排除）、使用者 `~/.claude/CLAUDE.md`、專案 `./CLAUDE.md` 或 `./.claude/CLAUDE.md`、個人 `./CLAUDE.local.md`。
- 工作目錄及其上層的檔案在啟動時載入，**串接而非覆蓋**（由根到工作目錄的順序）；子目錄的 CLAUDE.md 在 Claude 讀寫該子目錄檔案時才載入 → 適合 monorepo 各語言子目錄。
- `@path` 匯入，最多 4 層；匯入**不減少** context 成本。專案外的匯入首次需使用者核准。
- 建議每檔 < 200 行。
- **官方明言：CLAUDE.md 是 context，不是強制設定**；要強制阻擋需用 hook。
- 若 repo 只有 `AGENTS.md` 而無 CLAUDE.md，Claude Code（v2.1.277+）會讀 `AGENTS.md`；兩者都有時只讀 CLAUDE.md（可在 CLAUDE.md 中 `@AGENTS.md` 匯入）。

### 4.2 `.claude/rules/`
- 遞迴載入所有 `.md`；frontmatter `paths:`（glob，支援 `{ts,tsx}`）的規則只在 Claude Read/Write/Edit 符合檔案時載入。→ 天然適合「依語言注入對應標準」。
- 支援 symlink；指向工作目錄外的 symlink 視同外部匯入，需核准；UNC 網路路徑不跟隨。
- 使用者層 `~/.claude/rules/` 適用所有專案。

### 4.3 Skills 與 slash commands
- 位置：個人 `~/.claude/skills/`、專案 `.claude/skills/`、plugin `skills/`（呼叫名 `/plugin:skill`）。
- `.claude/commands/x.md` 與 `.claude/skills/x/SKILL.md` 都會產生 `/x`，行為相同；commands 已併入 skills。
- 載入時機：`description` 常駐 context（與 `when_to_use` 合計截斷於 1,536 字元），本體只在被呼叫時載入。
- `disable-model-invocation: true`：只有使用者可呼叫（適合「診斷」slash command）。`user-invocable: false`：只有 Claude 會自動用。
- `allowed-tools`：該輪免詢問可用的工具（可預先允許跑 CLI）。
- `` !`command` ``：在送給 Claude 前先執行命令並代換輸出（例如把 CLI 的檢查報告直接嵌入）；命令失敗會中止整個 skill；被 deny 或需詢問的命令（非 auto mode 且未在 `allowed-tools`）也會中止；管理者可用 `disableSkillShellExecution` 關閉。
- skill frontmatter 可帶 `hooks`、`paths`、`shell` 等欄位；skill 的 hooks 在其被呼叫後的整個 session 有效。

### 4.4 分工要點（文件陳述的定位）
- CLAUDE.md：每個 session 都要記得的事實與「一律做 X」規則。
- path-scoped rules：只對部分程式碼有效的規則。
- skill：多步驟程序或長參考資料（用到才載入）。
- hook：需要確定性、必須發生的行為。

---

## 5. 設定層級與優先序

優先序（高→低）：
1. Managed settings（server-managed／MDM／`managed-settings.json`）
2. 命令列 `--settings`
3. 專案本地 `.claude/settings.local.json`
4. 共享專案 `.claude/settings.json`
5. 使用者 `~/.claude/settings.json`（Windows：`%USERPROFILE%\.claude`，可由 `CLAUDE_CONFIG_DIR` 改位置）

- 純量鍵取最高層；**清單鍵（如 `permissions.allow`）跨層合併**；hooks 跨層合併。
- 某些鍵在 repo 檔案中無效（Scope 欄標示 User/Managed 者）；`extraKnownMarketplaces`、`permissions.allow`、多數 `env` 需 workspace trust 後才生效。
- `disableAllHooks: true` 依優先序生效，但無法從非 managed 層關掉 managed hooks。
- 設定檔為嚴格 JSON（不可有註解、尾逗號），否則啟動時報 Settings Error。
- `.claude/settings.local.json` 由 Claude Code 首次寫入時會加入全域 git excludes。

---

## 6. 環境檢查：如何偵測 hook / plugin 是否生效

| 想確認的事 | 方法 |
| :- | :- |
| 哪些設定檔被載入 | session 內 `/status` 的 `Setting sources` 行（不顯示每個鍵來自哪個檔） |
| 設定錯誤／被丟棄的項目 | `claude doctor` |
| hook 是否註冊、來源 | `/hooks`（互動式，唯讀） |
| hook 是否真的執行 | `claude --debug` / `--debug-file` 的 `Hooks: ... finished with status` 行 |
| plugin 已安裝並啟用 | `claude plugin list --json`：每筆含 `id`、`version`、`scope`、`enabled`、`installPath`（`--available` 列出未裝的） |
| plugin 元件內容 | `claude plugin details <name>` |
| CI 中 plugin 是否載入 | `claude -p --output-format stream-json --verbose`，`init` 事件的 `plugins` 列表 |
| 靜態檢查 | 直接讀取各層 settings JSON 的 `hooks`、`enabledPlugins`、`extraKnownMarketplaces`；`claude plugin validate` 驗 plugin／marketplace |

- `claude plugin list --json` 與 `--json` 結果需 v2.1.268+。
- 注意：靜態讀 settings 無法得知 workspace trust 是否已接受（trust 狀態存在 `~/.claude.json`，文件說該檔由 Claude Code 自行管理、不需編輯）——未信任時 hooks 與 `extraKnownMarketplaces` 都不生效且可能無訊息。

---

## 7. 已知限制彙整（供後續票考量）

1. `PostToolUse` 無法撤銷已寫入的檔案，只能回饋讓 Claude 自行修正。
2. 只有 Edit/Write 等檔案工具觸發 `Edit|Write` matcher；Claude 透過 Bash（如 `sed`、程式碼產生器）改檔不會觸發 → 可搭配 `Stop`/`PostToolBatch`/`FileChanged` 補漏。
3. 平行工具呼叫會併發觸發多個 PostToolUse；整專案檢查可能重複執行 → 考慮 `PostToolBatch` 或只檢查變更檔。
4. `additionalContext` 10,000 字元上限。
5. Hook 失敗預設放行（除非 `onFailure: "block"`，且需新版）。
6. Windows：Git Bash 有無決定預設 shell；`.cmd` shim 不能 exec form；路徑反斜線；`jq` 未必存在。
7. repo 層級安裝依賴 workspace trust，且外部來源 plugin 需每人手動 `install --scope project`。
8. plugin 內 `CLAUDE.md` 不載入；「事前」若走 plugin 須做成 skill，或由 CLI 產生專案的 CLAUDE.md / rules。
9. CLAUDE.md／rules 僅為建議性 context，不保證遵守。
10. 文件多處標註最低版本（v2.1.2xx），團隊的 Claude Code 版本需一併納入一致性檢查。

---

## 來源

- Hooks reference：https://code.claude.com/docs/en/hooks
- Hooks guide（含 Limitations and troubleshooting）：https://code.claude.com/docs/en/hooks-guide
- Plugin manifest reference：https://code.claude.com/docs/en/plugins-reference
- Create a marketplace：https://code.claude.com/docs/en/plugin-marketplaces
- Manage plugins for your organization：https://code.claude.com/docs/en/plugins/org
- Plugin commands reference：https://code.claude.com/docs/en/plugins/cli-reference
- Settings files and precedence：https://code.claude.com/docs/en/settings
- Memory（CLAUDE.md、rules、AGENTS.md）：https://code.claude.com/docs/en/memory
- Skills：https://code.claude.com/docs/en/skills
