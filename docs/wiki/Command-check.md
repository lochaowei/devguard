# `devguard check`

檢查專案宣告（`.devguard.yaml`）、各工具設定檔與程式碼是否符合預設標準。只回報，不修改任何檔案。

日常開發、CI 與 VS Code 的 `standards: check` task 都用它；pre-commit hook 跑的就是 `check --staged`，pre-push hook 在開發者設定 `DEVGUARD_PRE_PUSH=full` 時跑 `check --full` 中的測試與覆蓋率部分（預設不跑）。`check --full` 本身不受這個環境變數影響，一律完整執行測試與覆蓋率，供 CI 與發佈前的本地檢查使用。

本頁的範例都以[示範專案](CLI-Reference.md#示範專案)實際執行取得。

---

## 用法與旗標

```text
devguard check [檔案…] [--staged] [--only lint|format|typecheck] [--full]
               [--format text|json|sarif|vscode|claude] [--strict] [--verbose] [--cwd <dir>]
```

| 旗標 / 參數 | 作用 |
|---|---|
| `[檔案…]` | 只檢查這些檔案的程式碼（設定檢查照常全部執行）。路徑相對於目前目錄，必須在專案目錄內 |
| `--staged` | 只檢查 staged 的檔案，與 pre-commit hook 相同 |
| `--only <類別>` | 只跑一類程式碼檢查：`lint`、`format` 或 `typecheck`；同時會跳過測試與覆蓋率 |
| `--full` | 加跑測試與覆蓋率 |
| `--format <格式>` | 輸出格式，見 [CLI-Reference](CLI-Reference.md#輸出格式--format) |
| `--strict` | 偏離也算失敗 |
| `--verbose` | 展開提示（預設只顯示提示的數量） |
| `--cwd <dir>` | 專案根目錄，預設為目前目錄 |

**不能一起用的組合**（都會以 exit `2` 結束並印出用法）：

| 組合 | 訊息 |
|---|---|
| `--full` + 檔案 | `--full 會檢查整個專案，不能同時指定檔案` |
| `--staged` + 檔案 / `--full` / `--only` | `--staged 檢查 staged 的檔案，不能與檔案、--full 或 --only 一起使用` |
| `--only` 不是三種類別之一 | `不認得的類別「test」，可用的有 lint\|format\|typecheck` |
| 檔案在專案目錄外 | `「../x.ts」不在專案目錄中` |

---

## 執行流程

`check` 依序執行 [`CHECK_LAYERS`](../../src/check.ts) 中的 15 道檢查層，把所有發現（finding）合併成一份報告。前一層解析出的宣告（`resolution`）會傳給後面各層使用。

| 順序 | 檢查層 | 分類 | 檢查內容 |
|---|---|---|---|
| 1 | `declaration` | `config` | 解析 `.devguard.yaml`、驗證標準版本、比對覆寫與偏離理由 / 到期日、檢查同語言風格一致性 |
| 2 | `uncovered-files` | `config` | 沒有被任何元件涵蓋的四語言程式檔，套用推定的預設標準並給提示 |
| 3 | `settings-python` | `config` | `pyproject.toml` 的 Ruff、mypy / pyright / basedpyright 設定 |
| 4 | `settings-go` | `config` | `go.mod` 的 Go 版本與 golangci-lint 採用的設定檔（`.golangci.json` / `.toml` / `.yaml` / `.yml`，查找順序見 [Language-Standards](Language-Standards.md)）。多個元件共用同一份設定檔時，相同的 finding 只列一次，列在回報它的元件中目錄就是設定檔所在目錄的那個下，沒有時列在其中最上層的那個下（#92） |
| 5 | `settings-java` | `config` | Maven / Gradle 建置檔、Wrapper、`checkstyle.xml`、PMD ruleset、`lombok.config` |
| 6 | `deps` | `config` | lockfile 是否已提交（Go：`go mod tidy -diff` 有 diff 回報 `deps/go-mod-untidy`；依賴還沒下載到模組快取而無法離線檢查時回報 `deps/go-modules-missing`，執行 `go mod download`；其他失敗回報 `deps/tool-failed`，#83；Python：不帶 hash 的 `requirements.txt` 列出的套件是否都在 lockfile 中，`deps/requirements-unlocked`）、直接依賴是否違反 `deps.banned` |
| 7 | `settings-typescript` | `config` | `package.json`、`tsconfig.json`、ESLint flat config、Prettier、Biome、Vitest / Jest 覆蓋率門檻 |
| 8 | `tool-versions` | `consistency` | lockfile / 建置檔鎖定的工具版本（與 PATH 上的 `golangci-lint`）是否在標準的 `tools.*` 範圍內。Python 的型別檢查器只檢查元件宣告的 `typecheck.tool` 那一個 |
| 9 | `gitattributes` | `config` | repo 根目錄 `.gitattributes` 有 `* text=auto eol=lf` |
| 10 | `working-tree-crlf` | `environment` | 工作目錄的換行字元：有追蹤中的檔案在 git 裡是 LF、在工作目錄是 CRLF 時給一筆提示，見[工作目錄是 CRLF](#工作目錄是-crlf) |
| 11 | `credentials` | `config` | 提交進 repo 的專案設定檔中沒有明碼帳密（`credentials/plaintext`）：`.npmrc` 的 `_auth`、`_authToken`、`_password` 必須引用環境變數（`${NAME}`，可加引號）；`pyproject.toml` 中任何網址（index、source、`[tool.uv.sources]`、`pkg @ https://…` 依賴）不得內含密碼或 token（只有帳號不算）；`.mvn/settings.xml` 的 `<password>`、`<passphrase>` 必須是屬性引用（`${…}`）、Maven 加密的 `{…}` 或空值。各檔案也在元件的上層目錄中查找（workspace 根目錄的 `.npmrc` 等），共用的檔案只回報一次。只回報、不印出值，`fix` 也不會改寫。套件從哪裡下載（registry、index、鏡像）不檢查，交給使用者層級的設定 |
| 12 | `claude-code` | `config` | `.claude/` 的 rules、hooks、`/standards-doctor` 與標準一致 |
| 13 | `vscode` | `config` | `.vscode/` 的 extensions、settings、tasks |
| 14 | `code` | `code` | 用各元件的工具跑 lint、format、typecheck |
| 15 | `tests` | `code` | **只在 `--full` 且沒有 `--only`**：跑測試並檢查行、分支、函式、陳述式覆蓋率 |

各種範圍選項的影響：

- **指定檔案**：設定檢查（1–12）照常跑整個專案；`code` 層只檢查這些檔案。`tsc`、`mypy`、`pyright`、`basedpyright` 這類無法只檢查單一檔案的工具，仍會檢查檔案所屬的整個元件（mypy 設定了 `files` 時依設定，見[語言標準](Language-Standards.md)）。
- **指定的檔案不是原始碼**：TypeScript 元件內的檔案（`.js`、`.mjs`、`.json`、`.md`、`.prettierrc`、`LICENSE` 等）都交給元件的 linter 與 formatter，由工具決定是否處理（ESLint `--no-warn-ignored`、Prettier `--ignore-unknown`、Biome `--files-ignore-unknown=true`），回報的問題與全專案檢查一致。工具不處理的檔案不產生 finding。只有這類檔案時，不跑型別檢查。
- **`--staged`**：只跑 `declaration`、`code` 兩層；有依賴檔（`package.json`、lockfile 等）被 staged 時再加上 `deps`。細節見 [hook 頁的 git-pre-commit](Command-hook.md#git-pre-commit)。
- **宣告的 `ignore`**：符合的檔案從檔案清單中排除，不會觸發 `uncovered-files` 提示，也不會交給 `code`、`tests` 層，即使在命令列上指定或已 staged 也一樣（格式見[專案宣告](Project-Declaration.md#排除路徑ignore)）。以整個目錄為單位執行的工具（元件的 `eslint .`、`prettier .`、`tsc`、`mypy` 等）仍依各自的設定決定範圍；元件目錄內要排除的檔案，也要在該工具的設定中排除。
- **沒有 `.devguard.yaml`**：報告 `declaration/missing` 錯誤，程式碼檢查仍以推定的預設標準執行。
- **`.vscode/` 完全不存在**：`check` 不會報告；要產生它請執行 [`fix`](Command-fix.md) 或 [`install`](Command-install.md)。已經有部分檔案時，缺少的才算錯誤。

### 工作目錄是 CRLF

Git for Windows 預設 `core.autocrlf=true`，以 LF 提交的檔案 checkout 後會變成 CRLF（`git ls-files --eol` 顯示 `i/lf w/crlf`）。這時 gofmt、gofumpt、gci、Prettier、Biome 與 `go mod tidy -diff`（`deps/go-mod-untidy`）幾乎會把每個檔案都報成第 1 行格式錯誤；pre-commit hook 檢查的是 staged（LF）的版本，所以不會。

`check` 偵測到這種檔案時，另外回報**一筆** repo 層級的提示 `environment/working-tree-crlf`，說明原因、受影響的檔案數（列出前幾個當例子），以及怎麼重新 checkout。它是提示，不影響 exit code，`text` 格式要加 `--verbose` 才展開；那些格式錯誤照常回報。不在 git repo 裡、或沒有這種檔案時不回報；以 CRLF 提交的檔案（`i/crlf`）是專案自己的選擇，也不算。`--staged` 與 pre-commit hook 不跑這一層。

只在 `.gitattributes` 加上 `* text=auto eol=lf` 不會改變已經 checkout 的檔案，要重新 checkout。下面的指令會**丟掉所有未提交的修改**（包括 `devguard fix` 剛寫入的檔案），請先 commit 或 stash，再在 repo 根目錄依序執行（PowerShell 與 Git Bash 都可以，一行一個指令）：

```text
git rm --cached -r -q .
git reset --hard
```

---

## 輸出與 exit code

`text` 格式依元件分組，每組內依「錯誤 → 偏離 → 提示」排序。每一筆都標示規則 ID、檔案與行號，下一行說明「可用 fix 修正」或「需手動修正」，以及具體的修正方式。

| Exit code | 情況 |
|---|---|
| `0` | 沒有錯誤（偏離與提示不影響） |
| `1` | 有錯誤；或加上 `--strict` 時有偏離 |
| `2` | 用法錯誤、專案的工具沒有安裝（例如 `node_modules` 中沒有 `eslint`）、或其他 CLI 本身的失敗 |

exit code 與 `--format` 無關。

---

## 範例

### 初次導入：設定與程式碼的問題一起列出

```text
$ devguard check
標準：team@1.0.0

./ (TypeScript)
  錯誤  package-lock.json 存在但沒有提交到 git  [deps/lockfile-untracked] package-lock.json
        需手動修正：git add package-lock.json
  錯誤  tsconfig noUncheckedIndexedAccess 沒有啟用  [settings/looser] tsconfig.json
        可用 fix 修正：devguard fix（在 tsconfig.json 啟用 tsconfig noUncheckedIndexedAccess）
  錯誤  找不到 Prettier 設定檔  [settings/missing-file] .prettierrc
        可用 fix 修正：devguard fix（建立 .prettierrc）
  錯誤  找不到 Vitest 設定檔（覆蓋率門檻設在 coverage.thresholds）  [settings/missing-file] vitest.config.ts
        需手動修正：建立 vitest.config.ts
  錯誤  格式不符合 Prettier  [prettier/format] tsconfig.json:1
        可用 fix 修正：devguard fix --code tsconfig.json
  …

（整體）
  錯誤  .gitattributes 沒有「* text=auto eol=lf」  [settings/gitattributes-eol] .gitattributes
        可用 fix 修正：devguard fix（在 .gitattributes 加上 * text=auto eol=lf）

11 個錯誤、0 個偏離、0 個提示
```

標「可用 fix 修正：devguard fix」的交給 [`devguard fix`](Command-fix.md)；標「devguard fix --code」的交給 [`fix --code`](Command-fix.md#fix---code修正程式碼)；其餘照訊息手動處理。

### 只檢查一個檔案、只跑一類檢查

```text
$ devguard check src/first.ts
標準：team@1.0.0

./ (TypeScript)
  錯誤  Type 'number | undefined' is not assignable to type 'number'.  [tsc/TS2322] src/first.ts:2
        需手動修正：手動修正型別錯誤

1 個錯誤、0 個偏離、0 個提示

$ devguard check src/first.ts --only lint
標準：team@1.0.0

通過：沒有錯誤、偏離或提示
```

### 偏離不會讓檢查失敗，除非加上 `--strict`

宣告中以 `{value, reason, until}` 放寬的項目會列為偏離：

```text
$ devguard check
標準：team@1.0.0

./ (TypeScript)
  偏離  覆蓋率門檻 (%)：80 → 10｜理由：舊程式碼的測試在 Q1 補齊｜到期：2027-03-31  [declaration/deviation] .devguard.yaml:6
        需手動修正

0 個錯誤、1 個偏離、0 個提示
$ echo $?
0
$ devguard check --strict > /dev/null; echo $?
1
```

### `--full`：測試與覆蓋率

測試與覆蓋率的問題長這樣（取自開啟完整測試的 [pre-push hook](Command-hook.md#git-pre-push)，它跑的就是 `--full` 的這兩層）：

```text
標準：team@1.0.0

./ (TypeScript)
  錯誤  行覆蓋率 14.2%（1/7）低於門檻 80%  [coverage/lines]
        需手動修正：補上測試；若暫時無法達到，在 .devguard.yaml 以 {value, reason, until} 放寬 coverage.lines
  錯誤  分支覆蓋率 0%（0/4）低於門檻 80%  [coverage/branches]
        …
4 個錯誤、0 個偏離、0 個提示
```

---

## 常見錯誤與排解

| 現象 | 原因與處理 |
|---|---|
| `找不到 eslint：node_modules 中沒有安裝`，exit `2` | `check` 遇到專案工具沒有安裝會直接中止。照提示安裝（`npm ci`、`uv sync`、`poetry install` 等）。TypeScript 的提示依最近的 lockfile 決定套件管理工具與目錄：`npm ci`、`pnpm install --frozen-lockfile`、`yarn install --immutable`（Yarn Berry）／`yarn install --frozen-lockfile`（Yarn classic）、`bun install --frozen-lockfile`，在 lockfile 所在的目錄（workspace 根目錄）執行；沒有 lockfile 時是 `deps.manager` 的一般安裝（例如 `npm install`、`bun install`），在最近的有 `package.json` 的目錄執行。同一個目錄有多個 lockfile 時，`deps.manager` 的那一個優先。標準要求的 Python 工具（例如 `basedpyright`）沒有列在 `pyproject.toml` 的依賴中時，`uv sync` 也裝不到它，提示改為 `uv add --dev "basedpyright>=1.40,<2"`（Poetry 專案為 `poetry config virtualenvs.in-project true && poetry add --group dev "…"`，讓工具裝進 devguard 會找的專案內 `.venv`），範圍取標準的 `tools.*`；想看完整的環境問題清單改跑 [`doctor`](Command-doctor.md)，它會把缺工具列成一筆錯誤並繼續 |
| `找不到 uv`，exit `2` | uv 專案的 Python 工具透過 `uv run` 執行，devguard 只在 PATH 上找 uv。照提示選一種方式安裝（官方安裝腳本、`pipx install uv`、`pip install uv`、`scoop install uv`）。已用 `pip install uv` 安裝卻仍出現時，uv 在 Python 的 Scripts 目錄（Windows）或 `~/.local/bin`（其他平台），預設不在 PATH 上：把該目錄加進 PATH，重開終端機後以 `uv --version` 確認 |
| TypeScript 專案卻出現 `找不到 golangci-lint` | 檔案清單來自 `git ls-files`（含未被忽略的未追蹤檔）。沒有 `.gitignore` 時 `node_modules/` 裡的 `.go`、`.py` 等檔案也會被當成專案檔案。把 `node_modules/`、`.venv/` 等加進 `.gitignore` |
| `eslint 執行失敗（exit 2）…` `[code/tool-failed]` | 工具本身執行失敗（缺設定檔、缺 plugin 等）。訊息附上工具輸出的最多 5 行：Maven 取 `[ERROR]` 的原因（略過 `[INFO]`／`[WARNING]` 與結尾的 `Re-run Maven…`、`[Help 1]`），Gradle 取 `* What went wrong:` 段落，其他工具取開頭幾行（`test/tool-failed` 取結尾幾行）。照提示在元件目錄直接執行該工具看完整訊息 |
| `Parsing error: … was not found by the project service` | `typescript-eslint` 的 `projectService` 找不到 `eslint.config.js`、`vitest.config.ts` 等不在 `tsconfig.json` 範圍內的檔案。在 ESLint 設定中加上 `projectService: { allowDefaultProject: [...] }` |
| `Vitest coverage.include 沒有設定` `[settings/coverage-include]` | Vitest 與 Jest 預設只計算被測試 import 的檔案，沒有測試的檔案不會拉低覆蓋率。在 `vitest.config.ts` 設定 `coverage.include`（例如 `["src/**/*.ts"]`），Jest 則設定 `collectCoverageFrom`。`fix` 只會印出片段 |

---

## 相關頁面

- [`fix`](Command-fix.md)：修正標為「可用 fix 修正」的問題
- [`doctor`](Command-doctor.md)：`check` 加上本機環境檢查
- [`hook`](Command-hook.md)：pre-commit / pre-push 如何呼叫這些檢查
- [CLI 指令與報告格式參考](CLI-Reference.md)：輸出格式與 exit code
- 規格：[SPEC §3.2、§7.1、§8、§11](../../SPEC.md)
- 實作：[`src/check.ts`](../../src/check.ts)（檢查層順序）、[`src/scope.ts`](../../src/scope.ts)（檔案與旗標組合）、[`src/layers/`](../../src/layers/)、[`src/report/render.ts`](../../src/report/render.ts)
