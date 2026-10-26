# 各語言預設標準（`team@1.0.0`、`team@1.1.0`、`legacy@1.0.0`）與檢查對照表

本文整理內建預設標準 `team@1.0.0`（定義於 [`src/standard/team-1.0.0.ts`](../../src/standard/team-1.0.0.ts)）在四種語言中的預設值、設定檢查項目、程式碼檢查執行方式，以及 `--full` 測試與覆蓋率檢查邏輯。

`team@1.1.0`（定義於 [`src/standard/team-1.1.0.ts`](../../src/standard/team-1.1.0.ts)）是 CLI 內建的最新版本，`devguard draft` 寫入、`doctor` 建議升級到的都是它。它沿用 `team@1.0.0` 的所有項目，只有以下差異（都是放寬，見 [SPEC §6](../../SPEC.md)）：

- TypeScript 不再要求 `eslint-plugin-sonarjs`（見 [TypeScript](#3-typescript)）。
- `java.minVersion` 從 `"17"` 降為 `"8"`（OpenJDK 仍在維護 Java 8）。Python、Node、Go 的最低版本已是上游仍支援的最舊版本，不變。
- 工具版本範圍：`tools.ruff` `>=0.17,<1`、`tools.pyright` `>=1.1.400,<2`、`tools.vitest` `>=4.1,<6`、`tools.spotless-maven-plugin` `>=2.44,<4`、`tools.spotless-gradle-plugin` `>=7,<9`、`tools.checkstyle` `>=10.21,<15`。下限不低於上游仍在修補的版本線。

下文各語言的「工具版本範圍」列的是 `team@1.0.0` 的值，`team@1.1.0` 的差異標在括號中。

### 既有專案的基線標準 `legacy@1.0.0`

`legacy@1.0.0`（定義於 [`src/standard/legacy-1.0.0.ts`](../../src/standard/legacy-1.0.0.ts)）給既有專案先納管用，不必為下列項目寫一堆 `reason`／`until` 偏離；之後以 [`devguard standard upgrade`](Command-standard-upgrade.md) 升級到 `team@1.1.0`。它沿用 `team@1.1.0` 的所有項目，只放寬（見 [SPEC §6.5](../../SPEC.md)）：

| 項目 | `legacy@1.0.0` |
|---|---|
| `coverage.lines` | `0`：`--full` 仍執行測試，但不判定覆蓋率，也不要求覆蓋率設定（Vitest / Jest 門檻與 `include`、Python `branch = true`）或覆蓋率報告 |
| `typecheck.strict` | `false`（TypeScript、Python） |
| `typecheck.options` | `[]`（TypeScript） |
| `complexity.cyclomatic` / `cognitive` | `20` / `25` |
| `deps.banned` | 只保留 Python `pycrypto`、TypeScript `request`、Java `log4j:log4j`；Go 為空。JUnit 4（`junit:junit`）等不再禁用 |
| `java.minVersion` | `"8"`，明確寫在 `legacy@1.0.0` 中，不繼承 `team@1.1.0` |

`devguard draft` 不會寫入 `legacy`，要使用時把草稿的 `standard` 改成 `legacy@1.0.0`。`doctor` 不會建議從 `legacy` 升級到 `team`（會收緊），也不會建議從 `team` 改用 `legacy`。

---

## 跨語言共通標準

| 項目 | 預設值 | 類型 | 說明 |
|---|---|---|---|
| `complexity.cyclomatic` | `10` | `max` | 循環複雜度上限 |
| `complexity.cognitive` | `15` | `max` | 認知複雜度上限（Python 不適用） |
| `coverage.lines` | `80` | `min` | 覆蓋率門檻（%） |
| `deps.lockfile` | `true` | `bool` | 必須提交對應語言的 lockfile（或等效鎖定設定） |
| `deps.vulnScan` | `false` | `bool` | 弱點掃描（進階項目，預設關閉） |
| `deps.ignoredVulns` | `[]` | `ignoredVulns` | 忽略的弱點清單（每項需附 `reason` 與 `until`） |
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
| `typecheck.tool` | `"mypy"` | 允許替代：`pyright` |
| `typecheck.strict` | `true` | `[tool.mypy] strict = true` 或 `[tool.pyright] typeCheckingMode = "strict"` |
| `test.tool` | `"pytest"` | 搭配 `pytest-cov` |
| `coverage.lines` | `80` | 行覆蓋率與分支覆蓋率**各自**須達 80% |
| `deps.manager` | `"uv"` | 允許替代：`poetry` |
| `deps.lockfile` | `true` | 必須提交 `uv.lock`、`poetry.lock` 或每一行皆含 `--hash=` 的 `requirements.txt` |
| `deps.banned` | `["pycrypto", "nose"]` | 直接依賴禁用套件 |
| `deps.bannedApis` | `[]` | 對應 Ruff `TID251` banned-api |

### 執行方式

- **工具執行器**：`uv run --no-sync <tool>`（鎖定版本讀取自 `uv.lock` 或 `poetry.lock`）。Poetry 專案（最近的 lockfile 是 `poetry.lock`）改為直接執行專案內 `.venv` 中的工具，需要 `poetry config virtualenvs.in-project true`；以下的 `uv run --no-sync` 對 Poetry 專案都換成 `.venv` 中的執行檔
- **工具版本範圍（`team@1.0.0` 佔位值）**：
  - `tools.ruff`：`>=0.17,<0.18`（`team@1.1.0`：`>=0.17,<1`）
  - `tools.mypy`：`>=1.18,<2`
  - `tools.pyright`：`>=1.1.400,<1.2`（`team@1.1.0`：`>=1.1.400,<2`）
  - `tools.pytest`：`>=8,<10`
  - `tools.pytest-cov`：`>=6,<8`
- **程式碼檢查（`code` 層）**：
  - `lint`：`uv run --no-sync ruff check --output-format json`（`--staged` 時改用 `--stdin-filename <path> -` 讀取 staged 內容）
  - `format`：`uv run --no-sync ruff format --check`（`--staged` 時改用 `--stdin-filename <path> -`）
  - `typecheck`：`uv run --no-sync mypy` 或 `uv run --no-sync pyright --outputjson`
- **自動修正程式碼（`fix --code`）**：
  - `uv run --no-sync ruff check --fix --force-exclude`
  - `uv run --no-sync ruff format --force-exclude`
- **測試與覆蓋率（`tests` 層，`--full`）**：
  - 執行 `uv run --no-sync pytest --cov --cov-branch --cov-report=json:<tmp>`，由 CLI 解析 JSON 報告中的 `totals`，分別檢查行覆蓋率與分支覆蓋率是否達到門檻。
- **弱點掃描（`vuln` 層，`--full` 且 `deps.vulnScan: true`）**：
  - 先執行 `uv export --frozen --no-emit-project --format requirements.txt -o <tmp>`，再對匯出檔執行 `pip-audit -r <tmp> --disable-pip -s osv --osv-url <mirrors.osv>`，`deps.ignoredVulns` 轉為 `--ignore-vuln`。

---

## 2. Go

### 標準項目預設值

| 項目 | 預設值 | 允許替代 / 備註 |
|---|---|---|
| `go.minVersion` | `"1.26"` | 檢查 `go.mod` 的 `go` directive |
| `lint.tool` | `"golangci-lint"` | v2 設定檔（`version: "2"`），binary 版本須 `>=2.12,<3` |
| `lint.rules` | `["errcheck", "govet", "ineffassign", "staticcheck", "unused", "gosec", "revive", "errorlint", "bodyclose", "misspell", "cyclop", "gocognit", "gomodguard_v2", "depguard"]` | `.golangci.yml` 的 `linters.enable` |
| `format.tools` | `["gofumpt", "goimports"]` | `.golangci.yml` 的 `formatters.enable` |
| `complexity.cyclomatic` / `cognitive` | `10` / `15` | `cyclop.max-complexity` / `gocognit.min-complexity` |
| `coverage.lines` | `80` | 排除 generated 檔案（`// Code generated … DO NOT EDIT.`）與 `mocks/` |
| `deps.lockfile` | `true` | `go.mod` 與 `go.sum` 必須提交，且 `go mod tidy -diff` 必須乾淨 |
| `deps.banned` | `["github.com/pkg/errors", "github.com/golang/protobuf"]` | 直接依賴禁用模組 + `gomodguard_v2` |
| `deps.bannedApis` | `["io/ioutil"]` | `.golangci.yml` 的 `depguard` 規則 |

### 執行方式

- **工具執行器**：PATH 上的 `golangci-lint`（例外：指定版本的 binary 由開發者放到 PATH，CLI 核對版本）與 `go tool <name>`（鎖定於 `go.mod` 的 `tool` directive）；執行時一律帶入 `GOTOOLCHAIN=local`；golangci-lint 與套件管理指令另外帶入鏡像環境變數（`GOPROXY`、`GOSUMDB`），`go tool` 與 `go mod` 等檢查用的指令則帶入 `GOPROXY=off`，檢查時不下載任何模組。
- **工具版本範圍（`team@1.0.0` 佔位值）**：
  - `tools.golangci-lint`（PATH）：`>=2.12,<3`
  - `tools.gofumpt`（`mvdan.cc/gofumpt`）：`>=0.9,<1`
  - `tools.goimports`（`golang.org/x/tools/cmd/goimports`）：`>=0.38,<1`
  - `tools.govulncheck`（`golang.org/x/vuln/cmd/govulncheck`）：`>=1.1,<2`
- **程式碼檢查（`code` 層）**：
  - 透過 `golangci-lint run --output.json.path=stdout` 一次涵蓋 lint、format 與型別編譯問題，並依類別過濾；`--staged` 時額外對 staged `.go` 檔執行 `golangci-lint fmt --stdin` 檢查排版。
- **自動修正程式碼（`fix --code`）**：
  - `golangci-lint run --fix`（套用 linters 自動修復與設定中的 `gofumpt` / `goimports`）。
- **測試與覆蓋率（`tests` 層，`--full`）**：
  - 執行 `go test -coverprofile=<tmp> ./...` 與 `go tool cover -func=<tmp>`，過濾自動產生檔案與 `mocks/` 後計算總行覆蓋率。
- **弱點掃描（`vuln` 層，`--full` 且 `deps.vulnScan: true`）**：
  - 執行 `go tool govulncheck -json -db <mirrors.govulndb> ./...`，由 CLI 判定結果並過濾 `deps.ignoredVulns`。

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
| `complexity.cyclomatic` / `cognitive` | `10` / `15` | ESLint `complexity` / `sonarjs/cognitive-complexity`（或 Biome `noExcessiveCognitiveComplexity`）。`team@1.1.0` 起使用 ESLint 時只檢查 `complexity`，不檢查 `sonarjs/cognitive-complexity`；Biome 照舊 |
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
  - `lint`：`eslint --format json`（或 `biome lint --reporter=json`；`--staged` 時透過 `--stdin` 讀取 staged 內容）
  - `format`：`prettier --list-different`（或 `biome format --reporter=json`；`--staged` 時透過 `--stdin-filepath` 讀取 staged 內容）
  - `typecheck`：`tsc --noEmit --pretty false`
- **自動修正程式碼（`fix --code`）**：
  - `eslint --fix` + `prettier --write`（或 `biome lint --write` + `biome format --write`）
- **測試與覆蓋率（`tests` 層，`--full`）**：
  - 執行 Vitest（或 Jest）產生 `coverage-summary.json`，檢查 `lines`、`branches`、`functions`、`statements` 四項百分比。
  - Vitest 與 Jest 預設只計算被測試 import 的檔案，所以設定檢查會要求 `coverage.include` / `collectCoverageFrom`（`settings/coverage-include`）。
- **弱點掃描（`vuln` 層，`--full` 且 `deps.vulnScan: true`）**：
  - 執行 `npm audit --json --registry=<mirrors.npm>`，依嚴重度門檻（預設 `high`）與 `deps.ignoredVulns`（GHSA ID）過濾。

---

## 4. Java

### 標準項目預設值

| 項目 | 預設值 | 允許替代 / 備註 |
|---|---|---|
| `java.minVersion` | `"17"`（`team@1.1.0`：`"8"`） | Maven `maven.compiler.release` 或 Gradle Java toolchain |
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

- **工具執行器**：元件目錄或上層目錄的 `./mvnw`（`mvnw.cmd`）或 `./gradlew`（`gradlew.bat`）。
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
- **弱點掃描（`vuln` 層，`--full` 且 `deps.vulnScan: true`）**：
  - 透過 OWASP Dependency-Check Maven plugin（指向內部 NVD 資料鏡像 `<mirrors.nvd>nvdcve-{0}.json.gz`）產生報告，依 CVSS 門檻（`high` 對應 CVSS 7.0）與 `dependency-check-suppressions.xml` 判定。
