# `devguard install`

一次建好三道防線：產生 `fix` 會產生的所有設定（包括 `.vscode/`）、初次建立 Claude Code 設定（`.claude/`），並安裝 git `pre-commit` 與 `pre-push` hook。

導入專案時，在 [`draft`](Command-draft.md) 產生並確認宣告之後執行一次。之後設定有變動，用 [`fix`](Command-fix.md) 維持即可。

本頁的範例都以[示範專案](CLI-Reference.md#示範專案)實際執行取得。

---

## 用法與旗標

```text
devguard install [--yes] [--cwd <dir>]
```

| 旗標 | 作用 |
|---|---|
| `--yes` | 不詢問，預覽後直接套用 |
| `--cwd <dir>` | 專案根目錄 |

互動規則與 `fix` 相同：互動式終端機會詢問；非互動環境沒有 `--yes` 只預覽並以 exit `1` 結束。見 [fix 的互動規則](Command-fix.md#互動規則)。

---

## 執行流程

1. **規劃 git hook**
   1. 偵測既有的 hook 框架，依序找 `.pre-commit-config.yaml`（pre-commit）、`lefthook.yml` / `.yaml` / `.toml` / `.json` / `.jsonc`（也找 `.lefthook.*`、`.config/lefthook.*`）、`.husky/` 目錄（husky）。
   2. **有框架**：不寫 hook 檔，而是在框架設定中加入呼叫 `devguard hook git-pre-commit` 與 `devguard hook git-pre-push` 的項目。已經有的項目不重複加。

      | 框架 | 加入的內容 |
      |---|---|
      | pre-commit | `repos` 中加一個 `repo: local`，hook id 為 `devguard`（pre-commit 階段）與 `devguard-pre-push`，`language: unsupported`、`always_run: true` |
      | lefthook | `pre-commit.jobs` / `pre-push.jobs` 各加一個 `name: devguard`（原本用 `commands` 寫法的則加在 `commands.devguard`） |
      | husky | 在 `.husky/pre-commit`、`.husky/pre-push` 結尾加一行呼叫 devguard 的指令 |

   3. **沒有框架**：寫入 git 實際讀取的 hook 檔（`git rev-parse --git-path hooks/<名稱>`，通常是 `.git/hooks/`；有設定 `core.hooksPath` 時就是那個目錄）。
      - 檔案不存在，或是 devguard 產生的：寫入或更新。
      - 檔案存在但不是 devguard 產生的：**不覆寫**，只印出要自己加進去的那一行。
      - `core.hooksPath` 指向 `/dev/null` 或 `nul`（停用所有 hook）：不寫 hook 檔，只印出衝突。
   4. 檢查 `core.hooksPath` 有沒有衝突，有的話印出來。例如用 pre-commit 框架時設了 `core.hooksPath`（pre-commit 會拒絕安裝），或用 husky 時沒有指向 `.husky/_`。
2. **規劃設定**：與 `fix` 相同的可修正檢查層，差別是 Claude Code 層會**建立**整套 `.claude/` 設定（`fix` 只更新已存在的）。
3. 合併兩份計畫，依互動規則預覽並套用。

### 產生的 hook 檔

```sh
#!/bin/sh
# 由 CLI 產生（devguard），請勿手動修改；執行 devguard fix 重新產生
# devguard-hook pre-commit sha256=62296ca6…
command -v devguard >/dev/null 2>&1 || { echo 'devguard：找不到 CLI（devguard），已擋下這次 git commit。安裝：…；要暫時略過檢查可加上 --no-verify' >&2; exit 1; }; exec devguard hook git-pre-commit "$@"
```

- 由 Git for Windows 的 `sh` 執行，只有一行 POSIX sh。
- 第三行的 `sha256` 是檔案其餘內容的 checksum。[`doctor`](Command-doctor.md) 用它判斷 hook 有沒有被改過，`fix` 用它決定要不要重新產生。
- PATH 上找不到 `devguard` 時會**擋下** commit / push 並印出安裝方式，不會默默放行。
- `pre-push` hook 一律安裝，但預設不跑任何檢查：完整測試、覆蓋率與弱點掃描只在開發者設定 `DEVGUARD_PRE_PUSH=full` 時執行，否則交給 CI 的 `check --full`。切換時不需要重新執行 `install`。見 [`hook git-pre-push`](Command-hook.md#git-pre-push)。

### 產生的 Claude Code 設定

| 檔案 | 內容 |
|---|---|
| `.claude/settings.json` | 註冊三個 hook：`SessionStart` → `claude-session-start`、`PostToolUse`（matcher `Edit\|Write`）→ `claude-post-edit`、`Stop` → `claude-stop`。前兩個設定 `onFailure: "block"`；`Stop` 不設定（`onFailure` 對 `Stop` 無效），舊版產生的 `Stop` 若帶有 `onFailure`，`install` 會移除 |
| `.claude/rules/standards-<元件>-<語言>.md` | 以 frontmatter `paths` 綁定元件的檔案；列出元件的標準項目與目前的偏離 |
| `.claude/skills/standards-doctor/SKILL.md` | `/standards-doctor` skill：嵌入 `devguard doctor --format claude --exit-zero` 的結果，開發者同意後才執行 `fix --yes` |

三個 hook 的行為見 [`hook`](Command-hook.md)。

產生的 `.claude/` 檔案已經符合 Prettier 的格式（JSON 依宣告的 `format.printWidth` 決定陣列是否排成一行），用 Prettier 格式化也不會改變內容，不需要加進 `.prettierignore`。

---

## 輸出與 exit code

| Exit code | 情況 |
|---|---|
| `0` | 已套用，或沒有需要寫入的檔案 |
| `1` | 有需要寫入的檔案但沒有套用（拒絕、非互動環境沒有 `--yes`） |
| `2` | 沒有 hook 框架且不是 git repo：`<dir> 不是 git repo，無法安裝 git hook`；或其他 CLI 失敗 |

---

## 範例

```text
$ devguard install
.claude/settings.json：新增，修改 CLI 管理的設定
+{
+  "hooks": {
+    "SessionStart": [
…
.claude/rules/standards-root-typescript.md：新增，重新產生（由 CLI 產生）
+---
+paths:
+  - "**/*.{ts,tsx,mts,cts}"
+---
+
+<!-- 由 CLI 產生（devguard），請勿手動修改；執行 devguard fix 重新產生 -->
+
+# ./ (TypeScript) 的標準（team@1.0.0）
…
.claude/skills/standards-doctor/SKILL.md：新增，重新產生（由 CLI 產生）
…
.git/hooks/pre-commit：新增，重新產生（由 CLI 產生）
…
.git/hooks/pre-push：新增，重新產生（由 CLI 產生）
…
非互動環境：只預覽，沒有套用。加上 --yes 才會套用。
$ devguard install --yes
…
已套用。
```

`.git/hooks/` 不在版本控制中，每位開發者 clone 後都要自己執行一次 `devguard install`。`.claude/` 與 `.vscode/` 則要提交到 git。

---

## 常見錯誤與排解

| 現象 | 原因與處理 |
|---|---|
| `這個 hook 不是 devguard 產生的，不會覆寫；請在其中加上：…` | 已經有手寫或其他工具的 hook 檔。把印出的那一行加進去，或改用 hook 框架 |
| `core.hooksPath = … ：pre-commit 在 core.hooksPath 有設定時拒絕安裝 hook` | 照訊息移除 `core.hooksPath`，再執行 `pre-commit install` 與 `pre-commit install --hook-type pre-push` |
| `core.hooksPath 未設定，husky 的 hook 沒有安裝；請執行 npx husky` | husky 的 hook 要靠 `core.hooksPath` 生效。執行 `npx husky` |
| 用 pre-commit 框架，`doctor` 仍說 hook 沒有安裝 | 框架設定中有項目還不夠，要執行 `pre-commit install`（以及 `--hook-type pre-push`）把 hook 寫進 hooks 目錄 |
| commit 時出現 `devguard：找不到 CLI（devguard），已擋下這次 git commit` | `devguard.exe` 不在 PATH 上。照訊息安裝；緊急時可用 `git commit --no-verify` 暫時略過 |

---

## 相關頁面

- [`hook`](Command-hook.md)：安裝好的 hook 被觸發時做什麼
- [`fix`](Command-fix.md)：之後維持設定
- [`doctor`](Command-doctor.md)：確認 hook 與 Claude Code 是否真的生效
- [快速開始](Quick-Start.md)：導入流程
- 規格：[SPEC §7.2、§7.3、§7.4](../../SPEC.md)
- 實作：[`src/hooks/install.ts`](../../src/hooks/install.ts)、[`src/hooks/frameworks.ts`](../../src/hooks/frameworks.ts)（框架偵測與注入）、[`src/hooks/file.ts`](../../src/hooks/file.ts)（hook 檔與 checksum）、[`src/claude/setup.ts`](../../src/claude/setup.ts)
