# 各語言預設標準（`team@1.0.0`～`team@1.4.0`、`legacy@1.0.0`）與檢查對照表

本文整理內建預設標準 `team@1.0.0`（定義於 [`src/standard/team-1.0.0.ts`](../../src/standard/team-1.0.0.ts)）在四種語言中的預設值、設定檢查項目、程式碼檢查執行方式，以及 `--full` 測試與覆蓋率檢查邏輯。

`team@1.1.0`（定義於 [`src/standard/team-1.1.0.ts`](../../src/standard/team-1.1.0.ts)）沿用 `team@1.0.0` 的所有項目，只有以下差異（都是放寬，見 [SPEC §6](../../SPEC.md)）：

- TypeScript 不再要求 `eslint-plugin-sonarjs`（見 [TypeScript](#3-typescript)）。因此 `team@1.1.0` 與 `legacy@1.0.0` 下，TypeScript 的 `complexity.cognitive` 只在使用 Biome 時強制；使用 ESLint 時只是參考值。
- 語言最低版本不變：`java.minVersion` 維持 `"17"`（需要 Java 8 的既有專案改用 `legacy@1.0.0`）；Python、Node、Go 的最低版本已是上游仍支援的最舊版本。
- 工具版本範圍（#36 於 2026-10-27 審視並訂定）：`tools.ruff` `>=0.17,<1`、`tools.pyright` `>=1.1.400,<2`、`tools.vitest` `>=4.1,<6`、`tools.spotless-maven-plugin` `>=2.44,<4`、`tools.spotless-gradle-plugin` `>=7,<9`、`tools.checkstyle` `>=10.21,<15`。下限不低於上游仍在修補的版本線。

`team@1.2.0`（定義於 [`src/standard/team-1.2.0.ts`](../../src/standard/team-1.2.0.ts)）沿用 `team@1.1.0` 的所有項目，只多了一個替代工具（minor，見 [SPEC §6](../../SPEC.md)）：

- Python 的 `typecheck.tool` 允許 `basedpyright`，並新增 `tools.basedpyright` `>=1.40,<2`。basedpyright 的版本都從 `main` 依序發佈、不回補舊版本線（2026-11-03 查證 PyPI 與 GitHub Releases），所以下限是目前唯一仍在維護的 1.40。

`team@1.3.0`（定義於 [`src/standard/team-1.3.0.ts`](../../src/standard/team-1.3.0.ts)）沿用 `team@1.2.0` 的所有項目，只移除 devguard 不再檢查的項目（minor，見 [SPEC §6](../../SPEC.md)，#64）：

- 所有 `mirrors.*`（內部鏡像與 `mirrors.auth`）：套件、工具與 VS Code 擴充套件從哪裡下載，交給開發者使用者層級的設定。
- 各語言的 `deps.vulnScan`、`deps.vulnFailOn`、`deps.ignoredVulns`，以及 Go 的 `tools.govulncheck`：devguard 不再執行弱點掃描。

較舊的版本仍保留這些項目，但 devguard 不再依它們做任何檢查：不論宣告哪個版本，寫著它們只會得到 `declaration/retired-item` 提示；執行 `devguard standard upgrade` 到 `team@1.3.0` 或更新的版本會把它們從宣告中刪除。

`team@1.4.0`（定義於 [`src/standard/team-1.4.0.ts`](../../src/standard/team-1.4.0.ts)）是 CLI 內建的最新版本，`devguard draft` 寫入、`doctor` 建議升級到的都是它。它沿用 `team@1.3.0` 的所有項目，只放寬一個版本範圍（minor，見 [SPEC §6](../../SPEC.md)，#113）：

- Python 的 `tools.mypy` 改為 `>=1.18,<3`，允許 mypy 2.x。2026-11-08 查證 PyPI：1.x 最後一版是 1.20.2（2026-04-21），2.0.0 於 2026-05-06 發佈、目前最新是 2.4.1，2.0 之後 1.x 沒有修補版；下限維持。

不論宣告哪個標準版本，Python 的型別檢查器版本範圍只檢查元件宣告的 `typecheck.tool` 那一個：宣告 basedpyright 時不檢查 lockfile 中 mypy 的範圍，宣告 mypy 時不檢查 pyright／basedpyright 的範圍。

下文各語言的「工具版本範圍」列的是 `team@1.0.0` 的值，`team@1.1.0`～`team@1.4.0` 的差異標在括號中。

### 既有專案的基線標準 `legacy@1.0.0`

`legacy@1.0.0`（定義於 [`src/standard/legacy-1.0.0.ts`](../../src/standard/legacy-1.0.0.ts)）給既有專案先納管用，不必為下列項目寫一堆 `reason`／`until` 偏離；之後以 [`devguard standard upgrade`](Command-standard-upgrade.md) 升級到 `team@1.1.0`。它沿用 `team@1.1.0` 的所有項目，只放寬（見 [SPEC §6.5](../../SPEC.md)）：

| 項目 | `legacy@1.0.0` |
|---|---|
| `coverage.lines` | `0`：`--full` 仍執行測試，但不判定覆蓋率，也不要求覆蓋率設定（Vitest / Jest 門檻與 `include`、Python `branch = true`）或覆蓋率報告 |
| `typecheck.strict` | `false`（TypeScript、Python） |
| `typecheck.options` | `[]`（TypeScript） |
| `complexity.cyclomatic` / `cognitive` | `20` / `25` |
| `deps.banned` | 只保留 Python `pycrypto`、TypeScript `request`、Java `log4j:log4j`；Go 為空。JUnit 4（`junit:junit`）等不再禁用 |
| `java.minVersion` | `"8"`（`team@1.1.0` 是 `"17"`），讓 Java 8 的既有專案可以納管 |

`java.minVersion` 是程式碼的目標版本（Maven `maven.compiler.release`、Gradle toolchain），不是執行工具用的 JDK。Java 工具（Checkstyle、Spotless、palantir-java-format）的版本範圍沿用 `team@1.1.0`，所以：

- 執行 Java 工具至少需要 **JDK 11**；使用 Spotless 3.x（Maven）或 8.x（Gradle）時需要 **JDK 17**。
- Java 8 的既有專案以 JDK 11 以上建置，並以 release 8 為目標即可（例如 `maven.compiler.release` 設為 `8`）。
- 只有 JDK 8 的機器上，[`doctor`](Command-doctor.md) 會以 `environment/java-runtime` 提示。

`devguard draft` 不會寫入 `legacy`，要使用時把草稿的 `standard` 改成 `legacy@1.0.0`。`doctor` 不會建議從 `legacy` 升級到 `team`（會收緊），也不會建議從 `team` 改用 `legacy`。

---

## 跨語言共通標準

| 項目 | 預設值 | 類型 | 說明 |
|---|---|---|---|
| `complexity.cyclomatic` | `10` | `max` | 循環複雜度上限 |
| `complexity.cognitive` | `15` | `max` | 認知複雜度上限（Python 不適用） |
| `coverage.lines` | `80` | `min` | 覆蓋率門檻（%）；0 以下表示不設門檻：仍執行測試，但不判定覆蓋率、不要求覆蓋率設定 |
| `deps.lockfile` | `true` | `bool` | 必須提交對應語言的 lockfile（或等效鎖定設定） |
| `deps.vulnScan` | `false` | `bool` | 弱點掃描（`team@1.2.0` 以前；devguard 已不執行，`team@1.3.0` 移除） |
| `deps.ignoredVulns` | `[]` | `ignoredVulns` | 忽略的弱點清單（同上，`team@1.3.0` 移除） |
| `claude.minVersion` | `"2.1.295"` | `minVersion` | Claude Code 最低版本 |
| `.gitattributes` | `* text=auto eol=lf` | 設定規則 | 確保跨平台換行字元一致為 LF |

---

## 1. Python

### 標準項目預設值

| 項目 | 預設值 | 允許替代 / 備註 |
|---|---|---|
| `python.minVersion` | `"3.11"` | `pyproject.toml` 的 `requires-python` 較高時以專案為準 |
| `lint.tool` | `"ruff"` | 固定使用 Ruff 執行 lint 與 format |
| `lint.rules` | `["E", "W", "F", "I", "B", "UP", "C90", "SIM", "N", "S", "TID"]` | 寫入 `[tool.ruff.lint] select`（測試檔放寬 `S101`） |
| `format.lineLength` | `120` | 風格項目（`[tool.ruff] line-length`） |
| `complexity.cyclomatic` | `10` | `[tool.ruff.lint.mccabe] max-complexity` |
| `typecheck.tool` | `"mypy"` | 允許替代：`pyright`；`team@1.2.0` 起另有 `basedpyright` |
| `typecheck.strict` | `true` | `[tool.mypy] strict = true`，或 `[tool.pyright]` / `[tool.basedpyright]`（兩者也都讀 `pyrightconfig.json`）的 `typeCheckingMode = "strict"`。宣告的 pyright／basedpyright 設為 `typeCheckingMode = "off"` 時回報錯誤 `settings/typecheck-off`（型別檢查實際被關閉），`fix` 改為 `"strict"`（宣告 `typecheck.strict: false` 時改為 `"standard"`） |
| `test.tool` | `"pytest"` | 搭配 `pytest-cov` |
| `coverage.lines` | `80` | 行覆蓋率與分支覆蓋率**各自**須達 80% |
| `deps.manager` | `"uv"` | 允許替代：`poetry` |
| `deps.lockfile` | `true` | 必須提交 `uv.lock`、`poetry.lock` 或每一行皆含 `--hash=` 的 `requirements.txt` |
| `deps.banned` | `["pycrypto", "nose"]` | 直接依賴禁用套件 |
| `deps.bannedApis` | `[]` | 對應 Ruff `TID251` banned-api |

### golangci 設定檔

devguard 用 golangci-lint 自己的規則找出它實際採用的設定檔，只檢查、修正這一份：

1. 從元件目錄往上到 repo 根目錄，最近一層有設定檔的目錄優先（元件目錄的 `.golangci.yml` 優先於上層的 `.golangci.toml`）。
2. 同一層依 `.golangci.json` > `.golangci.toml` > `.golangci.yaml` > `.golangci.yml` 取第一份。

- 四種格式套用同樣的檢查與 rule id；finding 的 `file` 是採用的那一份，能取得行號時附上（TOML 目前沒有行號）。
- `devguard fix` 沿用採用的那一份的格式修改它（TOML 就改 TOML、JSON 就改 JSON）。只有整條路徑上都沒有任何 golangci 設定檔時，才回報 `settings/golangci-missing` 並建立 `.golangci.yml`。
- 語法錯誤依格式回報 `settings/golangci-yaml-syntax`、`settings/golangci-toml-syntax` 或 `settings/golangci-json-syntax`，不當成缺檔，也不自動修正。
- 不是 v2 格式（沒有 `version`、`version: "1"` 或其他值）時，這份檔案**只**回報 `settings/golangci-version`，不檢查 linter、門檻、depguard、formatter，也沒有自動修正，所以 `fix` 不會改動 v1 設定檔（v1 的 `enable-all`、`linters-settings` 與 v2 的寫法不同，寫入 v2 的鍵只會得到一份 golangci-lint 無法載入的檔案）。先執行 `golangci-lint migrate`，再重新執行 `devguard check`。`go.mod` 照常檢查。
- 同一層有不只一份時，回報 `hint` `settings/golangci-multiple`，說明 golangci-lint 採用哪一份、其他的會被忽略。

### 執行方式

- **工具執行器**：`uv run --no-sync <tool>`（鎖定版本讀取自 `uv.lock` 或 `poetry.lock`）。工具須已安裝在專案環境：有設定 `UV_PROJECT_ENVIRONMENT` 時就是它指定的目錄（絕對路徑照用，相對路徑相對於專案目錄，與 uv 相同），否則是 `.venv`；找不到時訊息會列出實際找過的路徑。安裝提示是 `uv sync`（Poetry：`poetry install`）；工具沒有列在 `pyproject.toml` 的依賴中時改為 `uv add --dev "<工具><範圍>"`（Poetry：`poetry config virtualenvs.in-project true && poetry add --group dev "<工具><範圍>"`），範圍取標準的 `tools.*`。Poetry 專案不讀 `UV_PROJECT_ENVIRONMENT`。Poetry 專案（最近的 lockfile 是 `poetry.lock`）改為直接執行專案內 `.venv` 中的工具，需要 `poetry config virtualenvs.in-project true`；以下的 `uv run --no-sync` 對 Poetry 專案都換成 `.venv` 中的執行檔
- **套件來源**：devguard 不檢查也不寫入 `[[tool.uv.index]]` 或 `[[tool.poetry.source]]`，交給 uv／Poetry 的使用者層級設定；只檢查 `pyproject.toml` 中的網址沒有內含帳密（`credentials/plaintext`）。`standard upgrade --apply` 對 Poetry 專案執行 `poetry add --group dev`
- **工具版本範圍（`team@1.0.0` 佔位值）**：
  - `tools.ruff`：`>=0.17,<0.18`（`team@1.1.0`：`>=0.17,<1`）
  - `tools.mypy`：`>=1.18,<2`（`team@1.4.0`：`>=1.18,<3`）
  - `tools.pyright`：`>=1.1.400,<1.2`（`team@1.1.0`：`>=1.1.400,<2`）
  - `tools.basedpyright`：`team@1.2.0` 新增，`>=1.40,<2`
  - `tools.pytest`：`>=8,<10`
  - `tools.pytest-cov`：`>=6,<8`
- **程式碼檢查（`code` 層）**：
  - `lint`：`uv run --no-sync ruff check --output-format json`（`--staged` 時改用 `--stdin-filename <path> -` 讀取 staged 內容）
  - `format`：`uv run --no-sync ruff format --check`（`--staged` 時改用 `--stdin-filename <path> -`）
  - `typecheck`：`uv run --no-sync mypy`、`uv run --no-sync pyright --outputjson` 或 `uv run --no-sync basedpyright --outputjson`（輸出格式與 pyright 相同，rule 以 `basedpyright/` 開頭）
    - mypy 的範圍：mypy 讀到的設定（`mypy.ini`、`.mypy.ini`、`pyproject.toml` 的 `[tool.mypy]`、`setup.cfg` 的 `[mypy]`，依 mypy 的順序只用第一份；元件目錄沒有時往上層找到 repo 根目錄）設了 `files` 時依設定檢查，否則以 `mypy .` 檢查整個元件。上層目錄的設定一樣在元件目錄執行，`files` 路徑相對於元件目錄
- **自動修正程式碼（`fix --code`）**：
  - `uv run --no-sync ruff check --fix --force-exclude`
  - `uv run --no-sync ruff format --force-exclude`
- **測試與覆蓋率（`tests` 層，`--full`）**：
  - 執行 `uv run --no-sync pytest --cov --cov-branch --cov-report=json:<tmp>`，由 CLI 解析 JSON 報告中的 `totals`，分別檢查行覆蓋率與分支覆蓋率是否達到門檻。

---

## 2. Go

### 標準項目預設值

| 項目 | 預設值 | 允許替代 / 備註 |
|---|---|---|
| `go.minVersion` | `"1.26"` | 檢查 `go.mod` 的 `go` directive |
| `lint.tool` | `"golangci-lint"` | v2 設定檔（`version: "2"`），binary 版本須 `>=2.12,<3`。設定檔可以是 `.golangci.json`、`.golangci.toml`、`.golangci.yaml` 或 `.golangci.yml`，見下方「golangci 設定檔」 |
| `lint.rules` | `["errcheck", "govet", "ineffassign", "staticcheck", "unused", "gosec", "revive", "errorlint", "bodyclose", "misspell", "cyclop", "gocognit", "gomodguard_v2", "depguard"]` | golangci 設定檔的 `linters.enable` |
| `format.tools` | `["gofumpt", "goimports"]` | golangci 設定檔的 `formatters.enable` |
| `complexity.cyclomatic` / `cognitive` | `10` / `15` | `cyclop.max-complexity` / `gocognit.min-complexity` |
| `coverage.lines` | `80` | 排除 generated 檔案（`// Code generated … DO NOT EDIT.`）與 `mocks/` |
| `deps.lockfile` | `true` | `go.mod` 與 `go.sum` 必須提交，且 `go mod tidy -diff` 必須乾淨 |
| `deps.banned` | `["github.com/pkg/errors", "github.com/golang/protobuf"]` | 直接依賴禁用模組 + `gomodguard_v2` |
| `deps.bannedApis` | `["io/ioutil"]` | golangci 設定檔的 `depguard` 規則 |

### 執行方式

- **工具執行器**：PATH 上的 `golangci-lint`（例外：指定版本的 binary 由開發者放到 PATH，CLI 核對版本）與 `go tool <name>`（鎖定於 `go.mod` 的 `tool` directive）；執行時一律帶入 `GOTOOLCHAIN=local`；`go tool` 與 `go mod` 等檢查用的指令另外帶入 `GOPROXY=off`，檢查時不下載任何模組。其餘指令（golangci-lint、套件管理指令）的模組來源是開發者自己的 Go 設定（`go env GOPROXY`）。
- **工具版本範圍（`team@1.0.0` 佔位值）**：
  - `tools.golangci-lint`（PATH）：`>=2.12,<3`
  - `tools.gofumpt`（`mvdan.cc/gofumpt`）：`>=0.9,<1`
  - `tools.goimports`（`golang.org/x/tools/cmd/goimports`）：`>=0.38,<1`
  - `tools.govulncheck`（`golang.org/x/vuln/cmd/govulncheck`）：`>=1.1,<2`（`team@1.3.0` 移除）
- **程式碼檢查（`code` 層）**：
  - 透過 `golangci-lint run --output.json.path=stdout` 一次涵蓋 lint、format 與型別編譯問題，並依類別過濾；`--staged` 時額外對 staged `.go` 檔執行 `golangci-lint fmt --stdin` 檢查排版。
- **自動修正程式碼（`fix --code`）**：
  - `golangci-lint run --fix`（套用 linters 自動修復與設定中的 `gofumpt` / `goimports`）。
- **測試與覆蓋率（`tests` 層，`--full`）**：
  - 執行 `go test -coverprofile=<tmp> ./...` 與 `go tool cover -func=<tmp>`，過濾自動產生檔案與 `mocks/` 後計算總行覆蓋率。

---

## 3. TypeScript

### 標準項目預設值

| 項目 | 預設值 | 允許替代 / 備註 |
|---|---|---|
| `node.minVersion` | `"22"` | 檢查 `package.json` 的 `engines.node` |
| `lint.tool` | `"eslint+prettier"` | 允許替代：`biome` |
| `lint.rules` | `["typescript-eslint/strictTypeChecked"]` | ESLint flat config |
| `format.printWidth` / `endOfLine` | `120` / `"lf"` | 風格項目（`.prettierrc` 或 `biome.json`） |
| `typecheck.strict` | `true` | `tsconfig.json` 的 `compilerOptions.strict` |
| `typecheck.options` | `["noUncheckedIndexedAccess", "noImplicitOverride", "noFallthroughCasesInSwitch"]` | `tsconfig.json` 額外嚴格選項 |
| `complexity.cyclomatic` / `cognitive` | `10` / `15` | ESLint `complexity` / `sonarjs/cognitive-complexity`（或 Biome `noExcessiveCognitiveComplexity`）。`team@1.1.0` 起使用 ESLint 時只檢查 `complexity`，不檢查 `sonarjs/cognitive-complexity`，`cognitive` 只是參考值（`legacy@1.0.0` 相同）；Biome 照舊強制 |
| `test.tool` | `"vitest"` | 允許替代：`jest` |
| `coverage.lines` | `80` | `lines`、`branches`、`functions`、`statements` 四項皆須達 80%；必須設定 Vitest `coverage.include`（或 Jest `collectCoverageFrom`），沒有測試的檔案才會算進去 |
| `deps.manager` | `"npm"` | 允許替代：`pnpm`、`yarn` |
| `deps.lockfile` | `true` | 必須提交 `package-lock.json`、`pnpm-lock.yaml` 或 `yarn.lock` |
| `deps.banned` | `["moment", "request", "node-fetch"]` | 直接依賴禁用套件 |
| `deps.bannedApis` | `[]` | ESLint `no-restricted-imports` |

### 執行方式

- **工具執行器**：`node_modules/.bin/<tool>`（Windows 下 `.cmd` 自動透過 `cmd.exe /d /s /c` 啟動；鎖定版本讀取自 `package-lock.json`、`pnpm-lock.yaml` 或 `yarn.lock`）。
- **工具版本範圍（`team@1.0.0` 佔位值）**：
  - `tools.eslint`：`>=10,<11`、`tools.prettier`：`>=3,<4`、`tools.typescript`：`>=6,<7`、`tools.typescript-eslint`：`>=8,<9`、`tools.eslint-plugin-sonarjs`：`>=3,<4`（`team@1.1.0` 已移除這一項）
  - `tools.biome`（`@biomejs/biome`）：`>=2,<3`
  - `tools.vitest`：`>=5,<6`（`team@1.1.0`：`>=4.1,<6`）、`tools.jest`：`>=30,<31`
- **程式碼檢查（`code` 層）**：
  - `lint`：`eslint --format json`（`--staged` 時透過 `--stdin` 讀取 staged 內容；或 `biome lint --reporter=github`，Biome 2.x 從 stdin 不回報 lint 診斷，所以 `--staged` 時也檢查工作目錄版本）
  - `format`：`prettier --list-different`（或 `biome format --reporter=github`；`--staged` 時分別透過 `--stdin-filepath` 與 `--stdin-file-path` 讀取 staged 內容）
  - `typecheck`：`tsc --noEmit --pretty false`
- **自動修正程式碼（`fix --code`）**：
  - `eslint --fix` + `prettier --write`（或 `biome lint --write` + `biome format --write`）
- **測試與覆蓋率（`tests` 層，`--full`）**：
  - 執行 Vitest（或 Jest）產生 `coverage-summary.json`，檢查 `lines`、`branches`、`functions`、`statements` 四項百分比。
  - Vitest 與 Jest 預設只計算被測試 import 的檔案，所以設定檢查會要求 `coverage.include` / `collectCoverageFrom`（`settings/coverage-include`）。

---

## 4. Java

### 標準項目預設值

| 項目 | 預設值 | 允許替代 / 備註 |
|---|---|---|
| `java.minVersion` | `"17"`（`legacy@1.0.0`：`"8"`） | Maven `maven.compiler.release` 或 Gradle Java toolchain |
| `build.tool` | `"maven"` | 允許替代：`gradle`；必須提交 `./mvnw` 或 `./gradlew` wrapper |
| `format.tool` | `"palantir-java-format"` | 透過 Spotless 執行 |
| `lint.tool` / `lint.rules` | `"checkstyle+pmd"` / `["google_checks", "pmd-quickstart"]` | CLI 產生並檢查 `checkstyle.xml` 與 `pmd-ruleset.xml` |
| `complexity.cyclomatic` / `cognitive` | `10` / `15` | Checkstyle `CyclomaticComplexity` / PMD `CognitiveComplexity` |
| `test.tool` | `"junit5"` | JUnit 5 |
| `coverage.lines` | `80` | JaCoCo `LINE` 與 `BRANCH` 皆須達 80%；使用 Lombok 時須設定 `lombok.addLombokGeneratedAnnotation = true` |
| `deps.lockfile` | `true` | Maven：`maven-enforcer-plugin` 的 `banDynamicVersions` + `dependencyConvergence`；Gradle：`gradle.lockfile` |
| `deps.banned` | `["log4j:log4j", "junit:junit"]` | 直接依賴禁用套件 |
| `deps.bannedApis` | `["sun.*"]` | Checkstyle `IllegalImport` |

### 執行方式

- **建置工具**：宣告的 `build.tool` 優先；沒有宣告時，只有 `pom.xml` 是 Maven，只有 `build.gradle(.kts)`／`settings.gradle(.kts)` 是 Gradle；兩者都有時，只提交了 `gradlew` 是 Gradle，其餘是 Maven。設定、程式碼、測試與依賴檢查都用同一個判斷。
- **工具執行器**：元件目錄或上層目錄中**該建置工具**的 wrapper，Maven 是 `./mvnw`（`mvnw.cmd`），Gradle 是 `./gradlew`（`gradlew.bat`）。找不到時回報缺少 wrapper（安裝提示 `mvn -N wrapper:wrapper` 或 `gradle wrapper`），不會改用另一種建置工具的 wrapper。
- **工具版本範圍（`team@1.0.0` 佔位值）**：
  - Maven plugins：`maven-checkstyle-plugin`（`>=3.6,<4`）、`maven-pmd-plugin`（`>=3.26,<4`）、`spotless-maven-plugin`（`>=2.44,<3`；`team@1.1.0`：`>=2.44,<4`）、`jacoco-maven-plugin`（`>=0.8.12,<0.9`）、`maven-enforcer-plugin`（`>=3.5,<4`）
  - Gradle plugin 與 `toolVersion`：`spotless-gradle-plugin` / `com.diffplug.spotless`（`>=7,<8`；`team@1.1.0`：`>=7,<9`）、`checkstyle`（`>=10.21,<11`；`team@1.1.0`：`>=10.21,<15`）、`pmd`（`>=7,<8`）、`jacoco`（`>=0.8.12,<0.9`）
- **程式碼檢查（`code` 層）**：
  - `format`：`mvnw -B -ntp spotless:check`（或 Gradle `spotlessCheck --console=plain -q`）
  - `lint`：`mvnw -B -ntp checkstyle:check pmd:check -Dcheckstyle.failOnViolation=false -Dpmd.failOnViolation=false`（或 Gradle `checkstyleMain checkstyleTest pmdMain pmdTest --continue --console=plain -q`），解析產生的 Checkstyle（`target/checkstyle-result.xml` 或 `build/reports/checkstyle/*.xml`）與 PMD（`target/pmd.xml` 或 `build/reports/pmd/*.xml`）XML 報告。
- **自動修正程式碼（`fix --code`）**：
  - `mvnw -B -ntp spotless:apply`（或 `gradlew spotlessApply --console=plain -q`）。
- **測試與覆蓋率（`tests` 層，`--full`）**：
  - 執行 `mvnw -B -Dmaven.test.failure.ignore=true test jacoco:report`（或 Gradle `test jacocoTestReport --continue`），解析 `jacoco.xml`（或 `jacocoTestReport.xml`）根層級的 `LINE` 與 `BRANCH` counter。
