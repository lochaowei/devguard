# `devguard fix`

修正 `check` 報告中標為「可用 fix 修正」的問題。有兩種模式：

- **`devguard fix`**：修正**設定**，包括工具設定檔、`.vscode/`、`.claude/`，以及被改過的 devguard git hook。
- **`devguard fix --code [檔案…]`**：修正**程式碼**，執行 formatter 與可自動修正的 lint。

兩種模式都是先預覽、確認後才寫入。

本頁的範例都以[示範專案](CLI-Reference.md#示範專案)實際執行取得。

---

## 用法與旗標

```text
devguard fix [--yes] [--cwd <dir>]
devguard fix --code [檔案…] [--yes] [--cwd <dir>]
```

| 旗標 / 參數 | 作用 |
|---|---|
| `--code` | 修正程式碼而不是設定 |
| `[檔案…]` | 只有 `--code` 可以指定；只修正這些檔案 |
| `--yes` | 不詢問，預覽後直接套用 |
| `--cwd <dir>` | 專案根目錄 |

`devguard fix <檔案>`（沒有 `--code`）會以 exit `2` 結束：`只有 fix --code 可以指定檔案`。

---

## 互動規則

`fix`、`fix --code`、[`install`](Command-install.md) 共用同一套規則（[`previewThenApply`](../../src/fix/interaction.ts)）：

| 執行環境 | 行為 | Exit code |
|---|---|---|
| 互動式終端機（stdin 與 stdout 都是 TTY） | 印出預覽，問 `要套用以上修改嗎？[y/N]`；回答以 `y` 開頭才套用 | 套用 `0`；拒絕 `1` |
| 加上 `--yes` | 印出預覽後直接套用 | `0` |
| 非互動環境（CI、pipe、Claude Code）且沒有 `--yes` | 只預覽，印出 `非互動環境：只預覽，沒有套用。加上 --yes 才會套用。` | `1` |
| 沒有任何需要寫入的檔案 | 只印出預覽（可能只有要手動套用的片段） | `0` |

---

## `fix`：修正設定

### 執行流程

1. 執行可修正的檢查層（`FIX_LAYERS`）：`declaration`、`settings-python`、`settings-go`、`settings-java`、`settings-typescript`、`gitattributes`、`mirrors`、`claude-code`、`vscode`。
2. 宣告不存在或無法解析時，印出宣告的錯誤並以 exit `1` 結束。沒有宣告就無法判斷要修成什麼樣子，請先執行 [`draft`](Command-draft.md)。
3. 收集每筆 finding 附帶的修補（repair），依**檔案類別**決定怎麼處理（見下表）。
4. 檢查 devguard 自己的 git hook（`pre-commit`、`pre-push`）：被改過的才重新產生，並保留原本呼叫 CLI 的指令。從未安裝的 hook 交給 `install`；別人寫的 hook 不碰。
5. 依互動規則預覽並套用。

| 檔案類別 | 對象 | `fix` 的處理 |
|---|---|---|
| `generated`：CLI 全權產生 | `checkstyle.xml`、`pmd-ruleset.xml`（與 `pmd.xml`、`config/pmd/*.xml`）、`dependency-check-suppressions.xml`、`.mvn/settings.xml`、`.mvn/maven.config`、`.claude/rules/*`、`.claude/skills/standards-doctor/*`、`.githooks/*`、git hook 檔 | 整份重新產生，檔頭加上 `由 CLI 產生（devguard），請勿手動修改` |
| `managed`：結構化的共用檔 | `pyproject.toml`、`.golangci.yml`、`tsconfig.json`、`.prettierrc`、`biome.json`、`package.json`、`.gitattributes`、`.npmrc`、`.vscode/*.json`、`.claude/settings.json` 等 | 只改 CLI 管理的 key，保留註解、空行與欄位順序 |
| `snippet`：建置檔與程式碼形式的設定 | `pom.xml`、`build.gradle(.kts)`、`eslint.config.js`、`vitest.config.ts` 等 | **不寫入**，只印出要手動套用的片段 |
| `user`：使用者層級設定 | repo 以外的路徑，例如 `~/.m2/settings.xml` | **不寫入**，只印出修改說明 |

`check` 的報告會說明每筆問題屬於哪一種：`可用 fix 修正：devguard fix（…）` 表示 `fix` 會自動寫入；`（devguard fix 會印出要套用的片段，不會自動修改）` 表示屬於 `snippet` 或 `user`。

**`.vscode/` 與 `.claude/` 的差別：** `.vscode/` 完全不存在時，`fix` 會產生整套設定，即使 `check` 沒有報告。`.claude/` 則只更新已經存在的設定，要初次建立請用 [`install`](Command-install.md)。

### 範例

```text
$ devguard fix
tsconfig.json：修改 CLI 管理的設定
+{
+  "compilerOptions": {
+    "strict": true,
+    "target": "es2022",
+    "module": "nodenext",
+    "noUncheckedIndexedAccess": true,
+    "noImplicitOverride": true,
+    "noFallthroughCasesInSwitch": true
+  },
+  "include": ["src"]
+}
-{ "compilerOptions": { "strict": true, "target": "es2022", "module": "nodenext" }, "include": ["src"] }

.prettierrc：新增，修改 CLI 管理的設定
+{
+  "printWidth": 120,
+  "endOfLine": "lf"
+}

.gitattributes：新增，修改 CLI 管理的設定
+* text=auto eol=lf

.npmrc：新增，修改 CLI 管理的設定
+registry=https://nexus.example.internal/repository/npm-proxy/

.vscode/settings.json：新增，修改 CLI 管理的設定
…
非互動環境：只預覽，沒有套用。加上 --yes 才會套用。
$ echo $?
1
$ devguard fix --yes
…
已套用。
```

被改過的 git hook 會恢復成 devguard 產生的版本：

```text
$ devguard fix
.git/hooks/pre-push：重新產生（由 CLI 產生）
 # devguard-hook pre-push sha256=f37fd2be…
 command -v devguard >/dev/null 2>&1 || { … }; exec devguard hook git-pre-push "$@"
-echo hi
非互動環境：只預覽，沒有套用。加上 --yes 才會套用。
```

---

## `fix --code`：修正程式碼

### 執行流程

1. 解析宣告，對範圍內的檔案跑程式碼檢查（lint、format、typecheck）。
2. 挑出標為可自動修正的問題，依元件規劃要執行的修正步驟。例如 TypeScript 是 `eslint --fix`，接著 `prettier --write`。
3. 依互動規則預覽並套用。某個步驟失敗時會記成一筆問題，其餘步驟照常執行。
4. 套用後**再檢查一次**，列出剩下的問題，例如型別錯誤或無法自動修正的 lint。

| Exit code | 情況 |
|---|---|
| `0` | 套用後沒有剩下錯誤，或本來就沒有可修正的問題且沒有錯誤 |
| `1` | 有可修正的問題但沒有套用（拒絕、非互動環境沒有 `--yes`），或修正後仍有錯誤 |

### 範例

```text
$ devguard fix --code src/mul.ts
將自動修正以下程式碼問題：

./ (TypeScript)  在 repo 根目錄 執行：
  eslint --fix --no-warn-ignored src/mul.ts
  prettier --write --log-level warn src/mul.ts
  - src/mul.ts:1  格式不符合 Prettier  [prettier/format]

非互動環境：只預覽，沒有套用。加上 --yes 才會套用。

$ devguard fix --code src/mul.ts --yes
將自動修正以下程式碼問題：
…
已套用。

修正後再次檢查，剩餘的程式碼問題：

通過：沒有錯誤、偏離或提示
```

---

## 常見錯誤與排解

| 現象 | 原因與處理 |
|---|---|
| 在 Claude Code 或 CI 中執行 `fix`，exit `1` 且沒有寫入 | 非互動環境需要 `--yes` |
| `fix` 之後 `npm install` 連不上 `nexus.example.internal` | `fix` 依標準寫入 `.npmrc` 的內部鏡像網址。標準中的網址是範例值，正式導入前要換成公司的鏡像，或在宣告的 `mirrors.*` 覆寫 |
| `fix` 之後 `check` 仍報 `settings/missing-file`（`eslint.config.js`、`vitest.config.ts`） | 程式碼形式的設定檔屬於 `snippet`，`fix` 只印出片段，要自己建立或修改 |
| 用 Prettier 格式化 `.claude/` 後，`check` 報 `settings/claude-code` 不一致；不格式化又報 `prettier/format` | devguard 產生的 `.claude/` 檔案與 Prettier 格式不同。暫時把 `.claude/` 加進 `.prettierignore`，再執行 `devguard fix --yes` 恢復成產生的內容。追蹤：[#42](https://github.com/lochaowei/devguard/issues/42) |
| 改了 `.devguard.yaml` 之後 `check` 報 `.claude/rules/…` 不一致 | rules 檔會列出元件的標準與偏離，宣告改了就要重新產生。執行 `devguard fix --yes` |

---

## 相關頁面

- [`check`](Command-check.md)：哪些問題可以用 `fix` 修正
- [`install`](Command-install.md)：初次產生各防線設定與 git hook
- [專案宣告](Project-Declaration.md)：`fix` 依宣告決定要修成什麼樣子
- 規格：[SPEC §9](../../SPEC.md)
- 實作：[`src/fix/run.ts`](../../src/fix/run.ts)（設定修正）、[`src/fix/code.ts`](../../src/fix/code.ts)（程式碼修正）、[`src/fix/category.ts`](../../src/fix/category.ts)（檔案類別）、[`src/fix/interaction.ts`](../../src/fix/interaction.ts)（互動規則）、[`src/fix/plan.ts`](../../src/fix/plan.ts)
