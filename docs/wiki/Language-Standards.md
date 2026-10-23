# 各語言預設標準（`team@1.0.0`）與檢查對照表

本文整理內建預設標準 `team@1.0.0`（定義於 [`src/standard/team-1.0.0.ts`](../../src/standard/team-1.0.0.ts)）在四種語言中的預設值、設定檢查項目、程式碼檢查執行方式，以及 `--full` 測試與覆蓋率檢查邏輯。

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

- **工具執行器**：`uv run <tool>`（鎖定版本讀取自 `uv.lock` 或 `poetry.lock`）
- **程式碼檢查（`code` 層）**：
  - `lint`：`uv run ruff check --output-format json`
  - `format`：`uv run ruff format --check`
  - `typecheck`：`uv run mypy` 或 `uv run pyright --outputjson`
- **測試與覆蓋率（`tests` 層，`--full`）**：
  - 執行 `uv run pytest --cov --cov-branch --cov-report=json:<tmp>`，由 CLI 解析 JSON 報告中的 `totals`，分別檢查行覆蓋率與分支覆蓋率是否達到門檻。

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
- **程式碼檢查（`code` 層）**：
  - 透過 `golangci-lint run --output.json.path stdout` 一次涵蓋 lint、format 與型別編譯問題，並依類別過濾。
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
| `complexity.cyclomatic` / `cognitive` | `10` / `15` | ESLint `complexity` / `sonarjs/cognitive-complexity`（或 Biome `noExcessiveCognitiveComplexity`） |
| `test.tool` | `"vitest"` | 允許替代：`jest` |
| `coverage.lines` | `80` | `lines`、`branches`、`functions`、`statements` 四項皆須達 80% |
| `deps.manager` | `"npm"` | 允許替代：`pnpm`、`yarn` |
| `deps.lockfile` | `true` | 必須提交 `package-lock.json`、`pnpm-lock.yaml` 或 `yarn.lock` |
| `deps.banned` | `["moment", "request", "node-fetch"]` | 直接依賴禁用套件 |
| `deps.bannedApis` | `[]` | ESLint `no-restricted-imports` |

### 執行方式

- **工具執行器**：`node_modules/.bin/<tool>`（Windows 下 `.cmd` 自動透過 `cmd.exe /d /s /c` 啟動；鎖定版本讀取自 `package-lock.json`）。
- **程式碼檢查（`code` 層）**：
  - `lint`：`eslint --format json`（或 `biome lint --reporter=json`）
  - `format`：`prettier --list-different`（或 `biome format --reporter=json`）
  - `typecheck`：`tsc --noEmit --pretty false`
- **測試與覆蓋率（`tests` 層，`--full`）**：
  - 執行 Vitest（或 Jest）產生 `coverage-summary.json`，檢查 `lines`、`branches`、`functions`、`statements` 四項百分比。

---

## 4. Java

### 標準項目預設值

| 項目 | 預設值 | 允許替代 / 備註 |
|---|---|---|
| `java.minVersion` | `"17"` | Maven `maven.compiler.release` 或 Gradle Java toolchain |
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
- **程式碼檢查（`code` 層）**：
  - `format`：`spotless:check`（或 Gradle `spotlessCheck`）
  - `lint`：`checkstyle:check` + `pmd:check`（或 Gradle `checkstyleMain checkstyleTest pmdMain pmdTest`），解析產生的 Checkstyle 與 PMD XML 報告。
  - `typecheck`：`test-compile`（或 Gradle `compileJava compileTestJava`），解析 javac 編譯錯誤。
- **測試與覆蓋率（`tests` 層，`--full`）**：
  - 執行 `test jacoco:report`（或 Gradle `test jacocoTestReport`），解析 `jacoco.xml` 根層級的 `LINE` 與 `BRANCH` counter。
