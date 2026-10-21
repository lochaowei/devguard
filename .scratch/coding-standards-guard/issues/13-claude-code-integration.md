# Claude Code 防線整合設計

Type: grilling
Status: resolved
Blocked by: 07

## Question

第二道防線的具體設計是什麼？已確定：hook 以 exec form 呼叫 `<cli> hook claude-post-edit`，並用 `SessionStart` hook 執行 `<cli> doctor --quiet`。尚待決定：

- **事前**：每種語言的標準如何告知 Claude（`.claude/rules/*.md` 的 `paths` 篩選，或 plugin 內的 skill），以及這些內容是否由 CLI 從標準產生。
- **事中**：PostToolUse hook 只檢查被編輯的檔案還是整個專案；失敗訊息的格式與長度（上限 10,000 字元）；Claude 透過 Bash 改的檔案不會觸發 PostToolUse，要不要用 `Stop` 補檢查。
- **診斷**：slash command 的名稱與輸出格式。
- **團隊安裝**：plugin 與 marketplace 怎麼打包；`.claude/settings.json` 中的 `extraKnownMarketplaces` / `enabledPlugins` 由 CLI 產生，還是由開發者手動設定；如何檢查開發者尚未信任資料夾的情況。

依據：[Claude Code 擴充機制研究](04-claude-code-mechanisms.md)、[CLI 實作語言與分發方式決策](05-cli-runtime-decision.md)

## Answer

**不做 Claude Code plugin**（plugin 列為範圍外）。由 `<cli> install` 在專案中產生並提交以下 Claude Code 設定。這些檔案會在 `standard upgrade` 時一起更新，也列入一致性檢查；內容與標準不符時算錯誤，可用 `fix` 修正。
- `.claude/settings.json` 中的 hooks
- `.claude/rules/standards-<元件>.md`
- `.claude/skills/standards-doctor/SKILL.md`

**事前**
- `.claude/rules/standards-<元件>.md` 依每個元件的有效標準產生。
- frontmatter 的 `paths` 對應該元件的目錄與副檔名，所以只在 Claude 讀寫相關檔案時才載入。
- 內容是精簡的規則清單：工具、門檻、禁用清單、目前的偏離與理由，每份少於 200 行。
- 開頭標註「由 CLI 產生，請勿手動修改」。

**事中**：所有 hook 都以 exec form 呼叫 `<cli>`，並設定 `onFailure: "block"`。
- `PostToolUse`（matcher `Edit|Write`）：`<cli> hook claude-post-edit`，只對被編輯的那個檔案做 lint 與格式檢查。
- `Stop`：`<cli> hook claude-stop`，以 `git diff` 找出這一輪改過的所有檔案（包含透過 Bash 改的），執行 lint、格式與型別檢查。
- 回饋方式：exit 0 加上 JSON 的 `decision: "block"` 與 `reason`。`reason` 最多列 20 項，其餘寫「還有 N 項」，總長度少於 4,000 字元。
- 當 `stop_hook_active` 為 true 且檢查仍失敗時，就放行，並用 `systemMessage` 告知開發者剩下的問題，避免 Claude 陷入修正迴圈。
- `SessionStart`：執行 `<cli> doctor --quiet`（結果進入 Claude 的 context），並寫入 `.git/standards-guard/claude-last-seen` 時間戳記。

**診斷**
- `/standards-doctor` skill 設定 `disable-model-invocation: true`，只有開發者能呼叫。
- skill 內以 `` !`<cli> doctor --format claude` `` 嵌入檢查結果，請 Claude 說明結果，經開發者同意後再執行修正。
- `allowed-tools` 預先允許執行 `<cli>` 指令。

**環境檢查新增兩項**
- 預設標準加入「Claude Code 最低版本」（`onFailure` 需要 v2.1.295 以上），由 doctor 檢查。
- 專案有 Claude Code 設定、但從來沒有出現 `claude-last-seen` 檔案時，doctor 提示「Claude Code 的 hook 可能從未執行過，或尚未信任此資料夾」。

**各防線執行的檢查**

| 檢查 | VS Code | Claude PostToolUse | Claude Stop | git pre-commit | git pre-push（新增） |
|---|---|---|---|---|---|
| lint、格式 | 擴充套件即時顯示 | 被編輯的檔案 | 這一輪改過的檔案 | staged 檔案 | — |
| 型別檢查 | 擴充套件即時顯示 | — | 這一輪改過的檔案 | staged 檔案所屬的元件 | — |
| 依賴規則（lockfile、禁用清單） | — | — | — | 僅在依賴相關檔案被 staged 時 | — |
| 測試與覆蓋率 | 可手動執行的 task | — | — | — | 完整執行 |
| （進階）弱點掃描 | — | — | — | — | 開啟時執行 |

`<cli> check --full` 與 CI 執行全部檢查。pre-push hook 的安裝方式、既有 hook 框架的注入方式，以及環境檢查規則，都比照 pre-commit。
