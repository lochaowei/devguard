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
| 有檔案因為路徑上有檔案而不是目錄而無法寫入（見[下方](#路徑上有檔案而不是目錄)） | 其他檔案照上面的規則處理 | `1`，即使其他檔案已套用 |

---

## `fix`：修正設定

### 執行流程

1. 執行可修正的檢查層（`FIX_LAYERS`）：`declaration`、`settings-python`、`settings-go`、`settings-java`、`settings-typescript`、`gitattributes`、`claude-code`、`vscode`。
2. 宣告不存在或無法解析時，印出宣告的錯誤並以 exit `1` 結束。沒有宣告就無法判斷要修成什麼樣子，請先執行 [`draft`](Command-draft.md)。
3. 收集每筆 finding 附帶的修補（repair），依**檔案類別**決定怎麼處理（見下表）。
4. 檢查 devguard 自己的 git hook（`pre-commit`、`pre-push`）：被改過的才重新產生，並保留原本呼叫 CLI 的指令。從未安裝的 hook 交給 `install`；別人寫的 hook 不碰。
5. 依互動規則預覽並套用。
6. 這次套用在 `.gitattributes` 新增了 `* text=auto eol=lf`，而且工作目錄有在 git 裡是 LF、checkout 成 CRLF 的檔案（`i/lf w/crlf`）時，最後印出重新 checkout 的提示：先警告下面的指令會丟掉未提交的修改（包括 `fix` 剛寫入的檔案），請先 commit 或 stash，再列出 `git rm --cached -r -q .` 與 `git reset --hard`（一行一個指令，PowerShell 與 Git Bash 都能照著執行）。`.gitattributes` 已經有這條規則、或工作目錄沒有這種檔案時不印。`fix` **不會**自己重新 checkout，也不碰 git index。原因見 [check 頁的工作目錄是 CRLF](Command-check.md#工作目錄是-crlf)。
7. 這次套用建立了 Python 元件的 `pyproject.toml`，而元件目錄有 `requirements.txt` 時，最後印出一行：`requirements.txt` 的執行期依賴還沒有匯入，請執行 `uv add -r requirements.txt`（子目錄元件為 `cd <目錄> && uv add -r requirements.txt`），把它們加進 `pyproject.toml` 與 `uv.lock`。`fix` 建立的 `pyproject.toml` 只有 `[tool.*]`，不匯入就產生的 `uv.lock` 只鎖定開發工具，`check` 會回報 `deps/requirements-unlocked`。`fix` **不會**自己執行這個指令。

| 檔案類別 | 對象 | `fix` 的處理 |
|---|---|---|
| `generated`：CLI 全權產生 | `pmd-ruleset.xml`（與 `pmd.xml`、`config/pmd/*.xml`）、`.claude/rules/*`、`.claude/skills/standards-doctor/*`、`.githooks/*`、git hook 檔 | 整份重新產生，檔頭加上 `由 CLI 產生（devguard），請勿手動修改`。檔案存在但**不是 devguard 產生的**（非空白、沒有這個檔頭）時**不寫入**，見下方說明 |
| `managed`：結構化的共用檔 | `pyproject.toml`、golangci 設定檔（golangci-lint 採用的 `.golangci.json` / `.toml` / `.yaml` / `.yml`，沒有時建立 `.golangci.yml`：在 `go.work` 所在目錄（模組在它的 `use` 清單中時），否則在最上層的 Go 元件目錄，多個模組共用這一份（#88））、`tsconfig.json`、`.prettierrc`、`biome.json`、`package.json`、`.gitattributes`、`.npmrc`、`.vscode/*.json`、`.claude/settings.json` 等 | 只改 CLI 管理的 key，保留註解、空行、欄位順序與換行字元（原本是 CRLF 就寫 CRLF，新建的檔案用 LF）。YAML 檔中修改沒有碰到的行逐字不變，包括 `[revive]` 或 `[ revive ]` 的寫法與行尾註解前的對齊空白 |
| `snippet`：建置檔與程式碼形式的設定 | `pom.xml`、`build.gradle(.kts)`、`eslint.config.js`、`vitest.config.ts` 等 | **不寫入**，只印出要手動套用的片段 |
| `user`：使用者層級設定 | repo 以外的路徑，例如 `~/.m2/settings.xml` | **不寫入**，只印出修改說明 |

修改 TOML 共用檔（例如 `pyproject.toml`）時，`fix` 會先確認修改後的內容仍是合法的 TOML。不合法時該檔**不寫入**，改為印出 `pyproject.toml：錯誤：修改後不是合法的 TOML，不會修改；請自行套用` 與要套用的修改；同一次的其他檔案照常處理，這不會讓 `fix` 失敗：其他檔案寫入成功時 exit code 仍是 `0`。

沿用上層設定的 Python 子元件（元件目錄沒有自己的 `pyproject.toml`、`ruff.toml` 或 `pyrightconfig.json`，工具讀的是上層目錄的那一份）：`fix` 不修改上層的共用設定，也不在子元件目錄建立新的設定檔（#106）。子元件的標準與那份設定不一致時，`check` 回報不附自動修正的 finding，例如 `需手動修正：pyproject.toml 是上層共用的設定，devguard fix 不修改它：請調整 docs/ (Python) 在宣告中的 overrides，或直接修改 pyproject.toml（也會影響其他使用它的元件）`。擁有那份設定的上層元件，`fix` 照常修改。

### 路徑上有檔案而不是目錄

預覽前，`fix` 會檢查每個要寫入的檔案：上層路徑中已經存在、卻不是目錄的項目（例如 `.claude/skills` 是一般檔案）會讓那個檔案無法寫入。這種檔案**不寫入**，改為印出一筆錯誤；其他檔案（包括 git hook）照常預覽與套用，最後以 exit `1` 結束，即使其他檔案已經套用（`已套用。` 之後仍是 `1`）：

```text
.claude/skills/standards-doctor/SKILL.md：錯誤：路徑上有檔案而不是目錄，無法寫入；請自行處理
    .claude/skills 是檔案，不是目錄
```

最常見的原因是 Windows 上未展開的 git symlink：Git for Windows 預設 `core.symlinks=false`，在 git 中是 symlink 的路徑會 checkout 成內容為目標路徑（例如 `../.agents/skills`）的一般檔案。這個檔案在 git index 中是 symlink（mode `120000`）時，訊息會多兩行說明，並提示讓系統允許建立 symlink（Windows：開啟開發人員模式）、執行 `git config core.symlinks true`，再重新 checkout 該路徑。devguard 不會跟隨或解析這種檔案，也不會把檔案改寫到 symlink 指向的位置。[`install`](Command-install.md) 與 [`standard upgrade --apply`](Command-standard-upgrade.md) 也是如此。

`generated` 類的檔案已經存在、內容不是空白、卻沒有 `由 CLI 產生` 檔頭時，表示是專案自己寫的。`fix` 不會覆寫它，加上 `--yes` 也一樣，只印出要加入的內容，其他檔案照常處理：

- PMD ruleset：印出缺少或要換掉的 `<rule>`：`CognitiveComplexity`、`CyclomaticComplexity` 與（標準有禁用 API 時）`BannedApis`，內含宣告的值。
- `.claude/rules/*`、`/standards-doctor` skill：印出完整的產生內容，請自行比對。

```text
$ devguard fix --yes
pmd-ruleset.xml：這份檔案不是 devguard 產生的，不會覆寫；請自行加入以下內容
    加在 ruleset 底下：
    <rule ref="category/java/design.xml/CognitiveComplexity">
      <properties>
        <property name="reportLevel" value="16"/>
      </properties>
    </rule>
    加在 ruleset 底下：
    <rule ref="category/java/design.xml/CyclomaticComplexity">
      <properties>
        <property name="methodReportLevel" value="11"/>
      </properties>
    </rule>
    （BannedApis 規則同樣印出，此處省略）
```

**建立 `tsconfig.json` 時排除子元件：** TypeScript 元件沒有 `tsconfig.json`、底下又有其他 TypeScript 元件（例如宣告了 monorepo 根目錄 `./` 與 `packages/*`）時，`fix` 建立的 `tsconfig.json` 加上 `exclude`，列出子元件的目錄與 `node_modules`，讓 `tsc` 不把子元件與依賴的檔案算進這個元件（#125）。沒有子元件時不寫 `exclude`。

檔案不存在、空白，或帶有 `由 CLI 產生` 檔頭時，照常整份重新產生。要讓 devguard 接手一份自己寫的檔案，請刪除它再執行 `fix`。

`check` 的報告會說明每筆問題屬於哪一種：`可用 fix 修正：devguard fix（…）` 表示 `fix` 會自動寫入；`（devguard fix 會印出要套用的片段，不會自動修改）` 表示屬於 `snippet` 或 `user`，或是不是 devguard 產生的 `generated` 檔案。

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
2. 挑出標為可自動修正的問題，依元件規劃要執行的修正步驟。例如 TypeScript 是 `eslint --fix`，接著 `prettier --write`。指定的檔案中，TypeScript 元件內的非原始碼檔案（`.mjs`、`.json`、`.md` 等）也交給 lint 修正與 formatter，由工具決定是否處理（`prettier --write --ignore-unknown`，Biome 加上 `--files-ignore-unknown=true`）。
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
| `fix` 印出 `錯誤：路徑上有檔案而不是目錄，無法寫入`，exit `1` | 上層路徑中有一般檔案佔住目錄的位置，常見於 Windows 上未展開的 git symlink（例如 `.claude/skills`）。其他檔案已照常寫入；照訊息處理該路徑後再執行一次。見[路徑上有檔案而不是目錄](#路徑上有檔案而不是目錄) |
| `fix` 加上 `* text=auto eol=lf` 之後，`check` 仍把幾乎每個檔案報成第 1 行格式錯誤 | 工作目錄的檔案是 CRLF，`.gitattributes` 只影響之後 checkout 的檔案。先 commit 或 stash，再照 `fix` 印出的指令重新 checkout（見 [check 頁的工作目錄是 CRLF](Command-check.md#工作目錄是-crlf)） |
| 安裝套件時連不上 `nexus.example.internal` | 舊版 devguard 的 `fix` 會把標準中的範例鏡像網址寫進專案：`.npmrc` 的 `registry=`、`pyproject.toml` 的 `[[tool.uv.index]]` / `[[tool.poetry.source]]`（`name = "nexus"`）、`.mvn/settings.xml` 與 `.mvn/maven.config`。現在 devguard 不再寫入任何套件來源（#65、#64），套件來源交給使用者層級的設定；請自行刪除這些設定 |
| `fix` 印出 `錯誤：修改後不是合法的 TOML，不會修改；請自行套用` | 標準要求的 key 與檔案現有的寫法衝突，例如標準要求 `[tool.x]` 表格，但檔案中 `x` 已經是一般的值。檔案沒有被修改，請依印出的內容自行調整 |
| `fix` 之後 `check` 仍報 `settings/missing-file`（`eslint.config.js`、`vitest.config.ts`） | 程式碼形式的設定檔屬於 `snippet`，`fix` 只印出片段，要自己建立或修改 |
| `fix` 印出 `這份檔案不是 devguard 產生的，不會覆寫` | 這份 PMD ruleset 或 `.claude/` 檔案沒有 `由 CLI 產生` 檔頭，devguard 不會蓋掉專案自己的設定。請把印出的片段加進檔案；或刪除檔案，讓 `fix` 重新產生 |
| 改了 `.devguard.yaml` 之後 `check` 報 `.claude/rules/…` 不一致 | rules 檔會列出元件的標準與偏離，宣告改了就要重新產生。執行 `devguard fix --yes` |

---

## 相關頁面

- [`check`](Command-check.md)：哪些問題可以用 `fix` 修正
- [`install`](Command-install.md)：初次產生各防線設定與 git hook
- [專案宣告](Project-Declaration.md)：`fix` 依宣告決定要修成什麼樣子
- 規格：[SPEC §9](../../SPEC.md)
- 實作：[`src/fix/run.ts`](../../src/fix/run.ts)（設定修正）、[`src/fix/code.ts`](../../src/fix/code.ts)（程式碼修正）、[`src/fix/category.ts`](../../src/fix/category.ts)（檔案類別）、[`src/fix/interaction.ts`](../../src/fix/interaction.ts)（互動規則）、[`src/fix/plan.ts`](../../src/fix/plan.ts)
