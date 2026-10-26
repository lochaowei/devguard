# `devguard hook <名稱>`

給 git hook 與 Claude Code hook 呼叫的入口，平常不需要自己執行。每個名稱各自處理輸入，並回傳呼叫端預期的 exit code 與輸出格式。

這些 hook 由 [`install`](Command-install.md) 安裝。本頁的範例都以[示範專案](CLI-Reference.md#示範專案)實際執行取得。

---

## 用法

```text
devguard hook git-pre-commit|git-pre-push|claude-session-start|claude-post-edit|claude-stop [--cwd <dir>]
```

不認得的名稱以 exit `2` 結束：`不認得的 hook「nope」，可用的有 git-pre-commit|git-pre-push|claude-session-start|claude-post-edit|claude-stop`。

## 五個 hook 一覽

| 名稱 | 觸發時機 | 檢查範圍 | 輸出到 | 有問題時的效果 |
|---|---|---|---|---|
| [`git-pre-commit`](#git-pre-commit) | `git commit` | staged 的檔案：lint、format、所屬元件的 typecheck；有依賴檔被 staged 時加上依賴規則 | stderr（git 顯示給開發者） | exit `1`，**擋下 commit** |
| [`git-pre-push`](#git-pre-push) | `git push` | 預設不檢查、直接放行。設定 `DEVGUARD_PRE_PUSH=full` 時：所有元件的測試與覆蓋率；開啟 `deps.vulnScan` 的元件加上弱點掃描 | stderr | 預設 exit `0`；開啟時 exit `1`，**擋下 push** |
| [`claude-session-start`](#claude-session-start) | Claude Code 開始工作階段 | `doctor --quiet` | stdout，Claude Code 加進工作階段的 context | 只提供資訊，exit `0` |
| [`claude-post-edit`](#claude-post-edit) | Claude 用 `Edit` / `Write` 改完一個檔案 | 該檔案的 lint、format | stdout 的 JSON：`decision: "block"` | Claude 收到問題並繼續修正，exit `0` |
| [`claude-stop`](#claude-stop) | Claude 要結束這一輪 | 工作目錄中所有變更檔案的 lint、format、typecheck | stdout 的 JSON：`decision: "block"` 或 `systemMessage` | Claude 繼續修正；第二次仍失敗就放行並告訴開發者，exit `0` |

所有 hook 遇到專案工具沒有安裝時，都會把它列成一筆錯誤（附安裝指令）並繼續跑，而不是像 `check` 一樣以 exit `2` 中止。

git 執行 hook 時會匯出 `GIT_DIR`、`GIT_INDEX_FILE` 等 repo 定位變數。devguard 啟動專案工具（測試、linter、formatter、型別檢查、套件管理指令）前會移除 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、`GIT_OBJECT_DIRECTORY`、`GIT_ALTERNATE_OBJECT_DIRECTORIES`、`GIT_COMMON_DIR`、`GIT_PREFIX`，其餘環境變數照常傳遞。所以專案測試在暫存目錄裡建立的 git repo，即使在 worktree 中 push，也不會寫進你的 repo。devguard 自己的 git 指令（例如讀取 staged 版本）仍使用這些變數。

---

## `git-pre-commit`

### 執行流程

1. 以 `git diff --cached --name-status` 列出 staged 的變更。沒有 staged 任何東西就直接通過。
2. 執行 `declaration` 與 `code` 兩層，只檢查 staged 的檔案（刪除的不算）。有依賴檔（`package.json`、lockfile、`go.mod`、`pom.xml` 等）被 staged 時加上 `deps` 層。TypeScript 元件內 formatter 會處理的非原始碼檔案（`package.json`、`.md`、`.yaml` 等）也會做格式檢查。
3. 檢查的是 **staged 版本**：formatter 與單檔 linter（`ruff`、`eslint`、`prettier`、`biome`、`golangci-lint fmt`）用 `git show :<path>` 讀取 staged 內容，從 stdin 檢查。過程中不做 `git stash`。
4. 沒有 stdin 模式的工具（`tsc`、`mypy`、`pyright`、`golangci-lint run`、Java 的 wrapper）只能檢查工作目錄。檔案有未 staged 的修改時，會印出提示說明哪些工具看的是工作目錄版本。
5. 有任何發現就印出報告。有錯誤時最後再加一行 `修正程式碼：devguard fix --code <檔案…>`，並以 exit `1` 擋下 commit。

只檢查、不修正。偏離不會擋下 commit。`devguard check --staged` 執行的是同一套檢查，只是報告印到 stdout。

### 範例

```text
$ git commit -m "add mul"
標準：team@1.0.0

./ (TypeScript)
  錯誤  格式不符合 Prettier  [prettier/format] src/mul.ts:1
        可用 fix 修正：devguard fix --code src/mul.ts

1 個錯誤、0 個偏離、0 個提示
修正程式碼：devguard fix --code src/mul.ts
```

部分 staged 的檔案：

```text
$ devguard check --staged
注意：src/neg.ts 有未 staged 的修改。lint 與格式檢查用的是 staged 版本，但 tsc 沒有 stdin 模式，檢查的是工作目錄版本。
標準：team@1.0.0
…
```

---

## `git-pre-push`

### 執行流程

1. 環境變數 `DEVGUARD_PRE_PUSH` 不是 `full`（未設定或其他值）時，什麼都不跑、不印，以 exit `0` 放行。日常的 WIP push 不會被完整測試與覆蓋率計算擋住；這些由 CI 的 [`check --full`](Command-check.md) 把關。
2. 設定 `DEVGUARD_PRE_PUSH=full` 時，不管這次 push 了哪些 commit（不讀 git 傳入的 remote 與 refs），都執行 `declaration`、`tests`、`vuln` 三層，等同 `check --full` 中的測試、覆蓋率與弱點掃描。
3. 通過時什麼都不印。
4. 有錯誤時印出報告，以 exit `1` 擋下 push。

開關是開發者自己的環境變數，不寫在 `.devguard.yaml`，切換時也不需要重新執行 `install`。想讓每次 push 都先跑完整測試，可以設成使用者環境變數：

```text
# PowerShell（永久，新開的終端機生效）
[Environment]::SetEnvironmentVariable("DEVGUARD_PRE_PUSH", "full", "User")
# Git Bash（只對這次 push）
DEVGUARD_PRE_PUSH=full git push
```

### 範例

設定 `DEVGUARD_PRE_PUSH=full` 時，覆蓋率不足會擋下 push：

```text
$ DEVGUARD_PRE_PUSH=full git push origin main
標準：team@1.0.0

./ (TypeScript)
  錯誤  行覆蓋率 14.2%（1/7）低於門檻 80%  [coverage/lines]
        需手動修正：補上測試；若暫時無法達到，在 .devguard.yaml 以 {value, reason, until} 放寬 coverage.lines
  錯誤  分支覆蓋率 0%（0/4）低於門檻 80%  [coverage/branches]
        需手動修正：…
  錯誤  函式覆蓋率 33.3%（1/3）低於門檻 80%  [coverage/functions]
        需手動修正：…
  錯誤  陳述式覆蓋率 12.5%（1/8）低於門檻 80%  [coverage/statements]
        需手動修正：…

4 個錯誤、0 個偏離、0 個提示
```

---

## `claude-session-start`

### 執行流程

1. 寫入 `.git/devguard/claude-last-seen`（目前時間），讓 `doctor` 知道 Claude Code 的 hook 至少執行過一次。
2. 執行 `doctor`，只保留錯誤與偏離（等同 `--quiet`）。
3. 有問題時以 `claude` 格式印到 stdout，Claude Code 會把它加進工作階段的 context。沒有問題就不輸出。
4. 一律 exit `0`。

### 範例

```text
$ echo '{}' | devguard hook claude-session-start
devguard：0 個錯誤、1 個偏離、0 個提示
- 偏離 .devguard.yaml:6 覆蓋率門檻 (%)：80 → 10｜理由：舊程式碼的測試在 Q1 補齊｜到期：2027-03-31 [declaration/deviation]
```

---

## `claude-post-edit`

### 執行流程

1. 從 stdin 讀取 Claude Code 的 hook 輸入，取出 `tool_input.file_path`。
2. 路徑不在專案目錄內時直接通過。
3. 只對這個檔案跑 lint 與 format（不跑 typecheck，避免每次編輯都檢查整個專案）。TypeScript 元件內 formatter 會處理的非原始碼檔案（`.json`、`.md` 等）只做格式檢查。只回報程式碼問題，宣告本身的問題留給 `doctor`。
4. 有錯誤時在 stdout 印出 `{"decision":"block","reason":"…"}`，Claude Code 會把 `reason` 交給 Claude 繼續修正。
5. 一律 exit `0`。

### 範例

```text
$ echo '{"tool_name":"Write","tool_input":{"file_path":"C:\\work\\demo\\src\\sub.ts"}}' | devguard hook claude-post-edit
{"decision":"block","reason":"devguard：1 個錯誤、0 個偏離、0 個提示\n- 錯誤 src/sub.ts:1 格式不符合 Prettier [prettier/format]（修正：devguard fix --code src/sub.ts）"}
```

---

## `claude-stop`

### 執行流程

1. 用 `git status` 找出工作目錄中所有變更與新增的檔案（刪除的不算）。透過 Bash 改的檔案也會被找到。
2. 對這些檔案跑 lint、format、typecheck。TypeScript 元件內 formatter 會處理的非原始碼檔案只做格式檢查；元件只有這類檔案變更時不跑 typecheck。
3. 沒有錯誤就通過。
4. 有錯誤時，依 hook 輸入的 `stop_hook_active` 決定：
   - **`false`**（第一次）：印出 `{"decision":"block","reason":"…"}`，讓 Claude 繼續修正。
   - **`true`**（Claude 已經因為這個 hook 繼續過一次）：印出 `{"systemMessage":"…"}` 告訴開發者，並讓 Claude 結束這一輪，避免無限循環。
   - 開發者在這一輪之前留下、尚未 commit 的檔案也會被檢查；有問題時同樣最多讓 Claude 多修正一輪。
5. 一律 exit `0`。

### 範例

```text
$ echo '{}' | devguard hook claude-stop
{"decision":"block","reason":"devguard：1 個錯誤、0 個偏離、0 個提示\n- 錯誤 src/sub.ts:1 格式不符合 Prettier [prettier/format]（修正：devguard fix --code src/sub.ts）"}

$ echo '{"stop_hook_active":true}' | devguard hook claude-stop
{"systemMessage":"devguard：Claude 修正後仍有問題，已讓它結束這一輪，請自行處理。\ndevguard：1 個錯誤、0 個偏離、0 個提示\n- 錯誤 src/sub.ts:1 格式不符合 Prettier [prettier/format]（修正：devguard fix --code src/sub.ts）"}
```

---

## 常見錯誤與排解

| 現象 | 原因與處理 |
|---|---|
| 想暫時略過 git hook | `git commit --no-verify` / `git push --no-verify`。CI 仍會用 `check` 與 `check --full` 檢查 |
| pre-push 很慢 | 設定了 `DEVGUARD_PRE_PUSH=full`：它會跑所有元件的完整測試，與這次 push 的內容無關。不需要時移除這個環境變數，交給 CI 的 `check --full` |
| pre-push 沒有跑測試 | 預設就是如此。要在 push 前把關，設定 `DEVGUARD_PRE_PUSH=full`，或在 push 前自己執行 `devguard check --full` |
| pre-commit 印出的 `修正程式碼：devguard fix --code …` 列出 `node_modules/` 下的檔案 | `tsc` 檢查整個元件，依賴本身的型別錯誤也會被回報。通常表示依賴沒裝完整（例如缺 peer dependency），重新安裝依賴 |
| Claude Code 的 hook 似乎沒有執行 | 執行 `devguard doctor`。`environment/claude-never-ran` 表示還沒信任此資料夾，或 hook 從未執行過 |

---

## 相關頁面

- [`install`](Command-install.md)：安裝這些 hook
- [`check`](Command-check.md)：`check --staged` 與 `check --full`
- [`doctor`](Command-doctor.md)：確認 hook 是否安裝、是否被改過
- 規格：[SPEC §7.1、§7.3、§7.4](../../SPEC.md)
- 實作：[`src/hooks/registry.ts`](../../src/hooks/registry.ts)、[`src/hooks/pre-commit.ts`](../../src/hooks/pre-commit.ts)、[`src/hooks/pre-push.ts`](../../src/hooks/pre-push.ts)、[`src/hooks/claude.ts`](../../src/hooks/claude.ts)
