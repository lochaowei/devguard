# devguard

讓 Java、Python、Go、TypeScript 專案的標準（coding standard、complexity、test coverage、dependency）用**一份設定**同時落實到三道防線，並幫開發者快速確認自己的環境是否設定正確。

| 防線 | 時機 | devguard 做什麼 |
|---|---|---|
| 第一道：VS Code | 撰寫時 | 產生並檢查 workspace 設定，讓擴充套件即時顯示問題 |
| 第二道：Claude Code | Claude 編輯檔案時 | 產生 `.claude/` 的 rules、hooks 與 `/standards-doctor`，事前告知標準、事中檢查回饋 |
| 第三道：git hook | commit / push 時 | 安裝 pre-commit 與 pre-push hook，擋下不合格的變更 |

單一事實來源是 **預設標準**（內建在 CLI，例如 `team@1.0.0`）加上專案自己的 **專案宣告** `.devguard.yaml`。完整設計見 [SPEC.md](SPEC.md)，用語定義見 [GLOSSARY.md](GLOSSARY.md)，詳細使用手冊與各語言對照表見 [docs/wiki/Home.md](docs/wiki/Home.md)。

## 目前狀態

**v0.1.0：SPEC 的指令都已實作**（`check`、`doctor`、`fix`、`install`、`hook`、`draft`、`standard upgrade`）。以 Bun 打包成單一 exe，透過 GitHub Release 發佈（見[安裝](#安裝)）。見下方[路線圖](#路線圖)與[已知限制](#已知限制)。

- **專案宣告與草稿**：解析並檢查 `.devguard.yaml`（9 種標準項目類型、覆寫與偏離規則、到期日檢查、未涵蓋程式檔提示），以及依既有設定產生宣告草稿（`devguard draft`，含 Gradle、pnpm、yarn、Poetry、Biome、Jest、pyright 等工具選擇）。
- **四語言設定檢查與一致性檢查**：Python（`pyproject.toml`、`ruff.toml`、`pyrightconfig.json`）、Go（`.golangci.yml` / `.golangci.yaml`、`go.mod`）、TypeScript（`tsconfig.json`、ESLint、Prettier、Biome、Vitest / Jest、`package.json`）、Java（`pom.xml`、`build.gradle(.kts)`、`checkstyle.xml`、PMD ruleset、`lombok.config`）與共通 `.gitattributes`（`* text=auto eol=lf`）。monorepo 的子元件沿用上層目錄的共用設定檔。
- **依賴規則與工具版本範圍**：lockfile 是否提交（含 `go mod tidy -diff`、Maven Enforcer、Gradle `gradle.lockfile`）、直接依賴是否包含禁用套件（`deps.banned`），以及鎖定的工具版本（`uv.lock` / `poetry.lock`、`package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` 等）是否落在標準允許的範圍內（`tools.*`）。
- **程式碼、測試與弱點掃描**：透過專案環境鎖定的工具執行 lint、format 與 typecheck；`check --full` 再跑測試、行 / 分支覆蓋率門檻與弱點掃描。
- **三道防線**：`install` 產生 `.vscode/`、`.claude/`、工具設定檔與鏡像設定，並安裝 pre-commit / pre-push hook（或注入既有的 pre-commit、husky、lefthook）；`doctor` 檢查本機環境。
- **修正**：`fix` 依檔案類別修正設定（保留註解與順序、CRLF 檔不整份重寫），`fix --code` 修正程式碼。
- **實際專案測試**：以 27 個開源專案跑過 `draft` → `check` → `fix --yes` → `check`，發現的問題都已修正並補上測試，見 [KEI-6 報告](docs/real-project-test-report.md) 與 [KEI-7 報告](docs/testing/round-2-report.md)。

## 快速開始（Quick Start）

### 1. 安裝 devguard

- **下載執行檔（一般開發者／CI）**：從 [GitHub Releases](https://github.com/lochaowei/devguard/releases/latest) 下載 `devguard-windows-x64.exe`（arm64 機器用 `devguard-windows-arm64.exe`），改名為 `devguard.exe` 並放進 `PATH`。可用同一個 release 中的 `SHA256SUMS.txt` 核對雜湊值。更新時下載新版取代即可。`devguard.exe` 內建執行環境，不需要安裝 Node.js，也沒有程式碼簽章（SPEC §3.1）。
- **從原始碼執行（開發 devguard 本身）**：需要 Node.js **22.18 以上**（使用 Node 內建的 TypeScript type stripping）：
  ```bash
  npm ci
  npm run devguard -- check
  ```

### 2. 專案導入通用流程

在任何 Git 專案根目錄導入 `devguard` 的五個步驟：

```bash
# 步驟 1：產生 .devguard.yaml（既有專案自動偵測元件與覆寫；新專案也可手寫）
devguard draft

# 步驟 2：依語言安裝並鎖定專案工具（uv / npm / go / Maven 或 Gradle wrapper，見下方各語言章節）

# 步驟 3：產生三道防線與工具設定檔（.vscode/、.claude/、工具設定、鏡像設定、git hooks）
devguard install        # 互動預覽 diff 後確認套用（CI 或腳本可加 --yes）

# 步驟 4：執行檢查與自動修正
devguard check          # 檢查宣告、設定、依賴、工具版本與程式碼（lint / format / typecheck）
devguard fix            # 自動修補不合規的設定檔（保留註解與順序）
devguard fix --code     # 自動格式化與修正可自動修復的 lint 問題
devguard check --full   # 完整檢查：再加上測試、行/分支覆蓋率門檻與弱點掃描

# 步驟 5：檢查本機開發環境
devguard doctor         # 檢查 VS Code 擴充套件、git hook、Claude Code 版本、Go 鏡像、鏡像帳密環境變數
```

> **提示**：
> - `devguard` 透過 `git ls-files` 判斷專案檔案，請先確保 `git init` 已執行且 `.gitignore` 已排除虛擬環境或建置目錄（如 `.venv/`、`node_modules/`、`target/`、`build/`、`dist/`），避免第三方套件被誤判為專案元件。
> - 若在公司內網外開發（無內部 Nexus 鏡像），請在 `.devguard.yaml` 的 `mirrors` 區塊將對應鏡像改為公開來源並附上 `reason`（見[鏡像設定](#鏡像mirrors)）。

---

### 3. 各語言快速開始（Per-Language Quick Start）

#### Python（`uv` + `ruff` + `mypy` / `pyright` + `pytest`）

1. **前置環境與安裝專案工具**（Python `>= 3.11`，預設使用 `uv`，亦可於宣告改用 `poetry`）：
   ```bash
   # 初始化虛擬環境並鎖定標準要求的工具版本範圍（寫入 pyproject.toml 與 uv.lock）
   uv add --dev "ruff>=0.17,<0.18" "mypy>=1.18,<2" "pytest>=8,<10" "pytest-cov>=6,<8"
   # 若改用 pyright：uv add --dev "pyright>=1.1.400,<1.2"
   ```
2. **建立 `.devguard.yaml`**（或執行 `devguard draft`）：
   ```yaml
   standard: team@1.0.0
   components:
     - path: ./
       language: python
       # overrides:
       #   typecheck.tool: pyright   # 允許替代：mypy（預設）| pyright
       #   deps.manager: poetry      # 允許替代：uv（預設）| poetry
   ```
3. **產生設定與安裝防線**：
   ```bash
   devguard install
   ```
   `install` / `fix` 會在 `pyproject.toml` 自動寫入並維護（保留原有註解與順序）：
   - `[tool.ruff]`：`line-length = 120`、`target-version`（依 `requires-python` 或 `3.11`）
   - `[tool.ruff.lint]`：`select = ["E", "W", "F", "I", "B", "UP", "C90", "SIM", "N", "S", "TID"]`（不使用 `extend-select`）、`mccabe.max-complexity = 10`，以及測試檔放寬 `S101`（`per-file-ignores`）
   - `[tool.mypy]`：`strict = true`、`python_version`（或 `[tool.pyright]` 的 `typeCheckingMode = "strict"`）
   - `[tool.coverage.run]`：`branch = true`
   - `[[tool.uv.index]]`：指向內部 PyPI 鏡像 `nexus`（`default = true`）
4. **日常檢查與修正**：
   ```bash
   devguard check          # 透過 uv run --no-sync 執行 ruff check、ruff format --check、mypy/pyright
   devguard fix --code     # 執行 ruff check --fix 與 ruff format
   devguard check --full   # 執行 pytest --cov --cov-branch，要求行與分支覆蓋率「各自」>= 80%
   ```

---

#### Go（`go 1.26+` + `golangci-lint v2` + `gofumpt` / `goimports`）

1. **前置環境與安裝工具**：
   - Go `>= 1.26`（`go.mod` 的 `go` directive）。
   - **PATH 上的 `golangci-lint`**：Go 唯一由開發者放到 `PATH` 的工具，版本須在 `>=2.12,<3`（v2 格式，支援 `gomodguard_v2` 與 `golangci-lint fmt`）。
   - 在 `go.mod` 以 `tool` directive 鎖定格式化與弱點掃描工具，並確保 `go.sum` 乾淨：
     ```bash
     go get -tool mvdan.cc/gofumpt@latest golang.org/x/tools/cmd/goimports@latest golang.org/x/vuln/cmd/govulncheck@latest
     go mod tidy
     ```
   - 設定使用者層級 Go 鏡像（`devguard doctor` 會檢查）：
     ```bash
     go env -w GOPROXY=https://nexus.example.internal/repository/go-proxy/
     go env -w GOSUMDB="sum.golang.org https://nexus.example.internal/repository/go-sumdb-proxy/"
     ```
2. **建立 `.devguard.yaml`**（或執行 `devguard draft`）：
   ```yaml
   standard: team@1.0.0
   components:
     - path: ./
       language: go
   ```
3. **產生設定與安裝防線**：
   ```bash
   devguard install
   ```
   `install` / `fix` 會產生或更新 `.golangci.yml`（`version: "2"`）：
   - 啟用標準要求的 14 個 linters（`errcheck`、`govet`、`ineffassign`、`staticcheck`、`unused`、`gosec`、`revive`、`errorlint`、`bodyclose`、`misspell`、`cyclop`、`gocognit`、`gomodguard_v2`、`depguard`）
   - 設定 `cyclop.max-complexity = 10`、`gocognit.min-complexity = 15`
   - 設定 `gomodguard_v2` 禁用模組（`github.com/pkg/errors`、`github.com/golang/protobuf`）與 `depguard` 禁用 API（`io/ioutil`）
   - 啟用 formatters：`gofumpt` 與 `goimports`
4. **日常檢查與修正**：
   ```bash
   devguard check          # 檢查 go mod tidy -diff 與 golangci-lint run（含 lint、format、typecheck）
   devguard fix --code     # 執行 golangci-lint run --fix（含 gofumpt / goimports 格式化）
   devguard check --full   # 執行 go test -coverprofile，排除 generated 檔與 mocks/ 後要求行覆蓋率 >= 80%
   ```

---

#### TypeScript（Node `22+` + `ESLint` + `Prettier` / `Biome` + `Vitest` / `Jest`）

1. **前置環境與安裝專案工具**（Node.js `>= 22`，預設使用 `npm` + `eslint+prettier` + `vitest`）：
   ```bash
   npm pkg set type=module "engines.node=>=22"
   npm i -D "typescript@>=6 <7" "eslint@>=10 <11" "typescript-eslint@>=8 <9" \
     "eslint-plugin-sonarjs@>=3 <4" "prettier@>=3 <4" "vitest@>=5 <6" "@vitest/coverage-v8@>=5 <6"
   # 若改用 Biome：npm i -D "@biomejs/biome@>=2 <3"
   # 若改用 Jest：npm i -D "jest@>=30 <31"
   ```
2. **建立 `.devguard.yaml`**（或執行 `devguard draft`）：
   ```yaml
   standard: team@1.0.0
   components:
     - path: ./
       language: typescript
       # overrides:
       #   lint.tool: biome          # 允許替代：eslint+prettier（預設）| biome
       #   test.tool: jest           # 允許替代：vitest（預設）| jest
       #   deps.manager: pnpm        # 允許替代：npm（預設）| pnpm | yarn
   ```
3. **產生設定與安裝防線**：
   ```bash
   devguard install
   ```
   - **自動寫入（`managed`）**：
     - `tsconfig.json`：設定 `strict: true`、`noUncheckedIndexedAccess: true`、`noImplicitOverride: true`、`noFallthroughCasesInSwitch: true`
     - `.prettierrc`（`printWidth: 120`、`endOfLine: "lf"`）或 `biome.json`（含 `noExcessiveCognitiveComplexity`）
     - `.npmrc`：設定內部 `registry`（當 `mirrors.auth: env` 時加上 `:_auth=${NEXUS_NPM_AUTH}`）
     - `.vscode/`：設定 Prettier/Biome 存檔格式化、`source.fixAll.eslint`、`js/ts.tsdk.path`
   - **印出片段由開發者套用（`snippet`）**：`eslint.config.js` 與 `vitest.config.ts` 屬於程式碼設定檔，CLI 不會自動改寫，可建立如下最小設定：
     ```js
     // eslint.config.js
     import { defineConfig } from "eslint/config";
     import sonarjs from "eslint-plugin-sonarjs";
     import tseslint from "typescript-eslint";

     export default defineConfig(
       { ignores: ["coverage/", "dist/", "node_modules/"] },
       tseslint.configs.strictTypeChecked,
       {
         plugins: { sonarjs },
         languageOptions: {
           parserOptions: { projectService: { allowDefaultProject: ["eslint.config.js"] } },
         },
         rules: {
           complexity: ["error", 10],
           "sonarjs/cognitive-complexity": ["error", 15],
         },
       },
     );
     ```
     ```ts
     // vitest.config.ts
     import { defineConfig } from "vitest/config";

     export default defineConfig({
       test: {
         coverage: {
           provider: "v8",
           thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
         },
       },
     });
     ```
     > 若使用 Prettier，建議在 `.prettierignore` 加入 `.claude/` 與 `coverage/`。
4. **日常檢查與修正**：
   ```bash
   devguard check          # 執行 eslint、prettier --list-different（或 biome）、tsc --noEmit
   devguard fix --code     # 執行 eslint --fix 與 prettier --write（或 biome check --write）
   devguard check --full   # 執行 vitest run --coverage（或 jest），檢查 lines/branches/functions/statements 皆 >= 80%
   ```

---

#### Java（Java `17+` + Maven / Gradle Wrapper + `Spotless` + `Checkstyle` + `PMD` + `JaCoCo`）

1. **前置環境與建置 Wrapper**：
   - JDK `>= 17`（新專案建議 21+）。
   - **必須提交 Wrapper**：CLI 一律透過 `./mvnw`（`mvnw.cmd`）或 `./gradlew`（`gradlew.bat`）呼叫建置工具：
     ```bash
     mvn -N wrapper:wrapper   # Maven：提交 mvnw、mvnw.cmd 與 .mvn/wrapper/
     # 或 gradle wrapper      # Gradle：提交 gradlew、gradlew.bat 與 gradle/wrapper/
     ```
2. **建立 `.devguard.yaml`**（或執行 `devguard draft`）：
   ```yaml
   standard: team@1.0.0
   components:
     - path: ./
       language: java
       # overrides:
       #   build.tool: gradle        # 允許替代：maven（預設）| gradle
   ```
3. **產生設定與安裝防線**：
   ```bash
   devguard install
   ```
   - **CLI 全權產生（`generated`）**：
     - `checkstyle.xml`：包含 `CyclomaticComplexity`（上限 10）與 `IllegalImport`（預設禁用 `sun.*`）
     - `pmd-ruleset.xml`：引用 `rulesets/java/quickstart.xml` 並啟用 `CognitiveComplexity`（`reportLevel = 15`）
     - `.mvn/maven.config` 與 `.mvn/settings.xml`（Maven 專案）：指向內部 Maven 鏡像，當 `mirrors.auth: env` 時引用 `${env.NEXUS_USERNAME}` / `${env.NEXUS_PASSWORD}`
   - **結構化設定（`managed`）**：
     - `lombok.config`（若偵測到使用 Lombok）：自動補上 `lombok.addLombokGeneratedAnnotation = true`，避免 Lombok 產生的程式碼拉低 JaCoCo 覆蓋率
     - `.vscode/settings.json`：關閉 Java `editor.formatOnSave`（避免 IDE 格式化與 Palantir 衝突），並將 `java.checkstyle.configuration` 與 `java.checkstyle.version` 對齊建置檔；同時在 `.vscode/tasks.json` 產生 `standards: format (Spotless)` task
   - **建置檔設定（`snippet`，手動加入 `pom.xml` 或 `build.gradle(.kts)`）**：
     - Java 版本：`<maven.compiler.release>17</maven.compiler.release>`（或 Gradle Java toolchain）
     - 鎖定外掛版本並設定：
       - `spotless-maven-plugin`（`>=2.44,<3`）或 `com.diffplug.spotless`（`>=7,<8`），設定 `palantirJavaFormat()`
       - `maven-checkstyle-plugin`（`>=3.6,<4`，設定 `configLocation` 為 `checkstyle.xml`）或 Gradle `checkstyle`（`toolVersion` `>=10.21,<11`）
       - `maven-pmd-plugin`（`>=3.26,<4`，設定 `rulesets` 為 `pmd-ruleset.xml`）或 Gradle `pmd`（`toolVersion` `>=7,<8`）
       - `jacoco-maven-plugin`（`>=0.8.12,<0.9`，含 `prepare-agent` 與 `report`）或 Gradle `jacoco`（開啟 `xml.required = true`）
       - 依賴鎖定：Maven 設定 `maven-enforcer-plugin`（`>=3.5,<4`）啟用 `banDynamicVersions` 與 `dependencyConvergence`；Gradle 啟用 dependency locking 並提交 `gradle.lockfile`
4. **日常檢查與修正**：
   ```bash
   devguard check          # 執行 spotless:check、checkstyle:check、pmd:check（或對應 Gradle tasks）並解析報告
   devguard fix --code     # 執行 spotless:apply（或 spotlessApply）自動格式化
   devguard check --full   # 執行 test + jacoco，解析 jacoco.xml 檢查 LINE 與 BRANCH 覆蓋率各自 >= 80%
   ```

---

### 發佈新版本

1. 修改 `package.json` 的 `version`，提交並合併到 `main`。
2. 推送相同版本的 tag：`git tag v0.2.0 && git push origin v0.2.0`。
3. [release workflow](.github/workflows/release.yml) 會在 Windows runner 上執行測試、建置兩個 exe、跑 smoke test，再建立 GitHub Release 並附上 exe 與 `SHA256SUMS.txt`。tag 與 `package.json` 版本不同時會失敗。

本機建置：`npm run build:exe`（需要 Bun ≥1.2.23），產物在 `dist/`；`npm run smoke:exe` 在 PATH 中沒有 Node 的情況下驗證 exe。

## 專案宣告 `.devguard.yaml`

放在 repo 根目錄。最精簡的寫法：

```yaml
standard: team@1.0.0
components:
  - path: ./
    language: typescript
```

monorepo 與覆寫的寫法：

```yaml
standard: team@1.0.0            # 必須寫確切版本
components:                     # 元件 = 目錄 + 語言
  - path: backend/
    language: go
  - path: web/
    language: typescript
    overrides:
      complexity.cyclomatic: 8              # 收緊：直接寫值
      lint.tool: biome                      # 允許清單內的替代工具：直接寫值
      format.printWidth: 100                # 風格項目：直接寫值
      coverage.lines:                       # 放寬：必須寫理由，可加到期日
        value: 60
        reason: "舊程式碼補測試中，2027 Q1 回到 80"
        until: 2027-03-31
mirrors:
  auth: env                     # 內部 Nexus 需要帳密時
```

規則摘要（細節見 SPEC §4 與 [Project-Declaration.md](docs/wiki/Project-Declaration.md)）：

- **收緊**標準、改用**允許清單內**的替代工具、修改**風格**項目，都可以直接寫值。
- **放寬**標準必須寫 `reason`，報告中會標示為**偏離**，不會擋人；超過 `until` 的日期後變回**錯誤**。
- 理由仍是 `TODO`、覆寫不存在的項目、值的型別錯誤、重複宣告同一個元件，都是**錯誤**。
- 每個檔案歸屬於路徑最長且語言相符的元件；沒有元件涵蓋時，依副檔名推定語言並套用預設標準（並發出 `declaration/uncovered-files` 提示）。

可以覆寫的項目與預設值，見 [src/standard/team-1.0.0.ts](src/standard/team-1.0.0.ts)、SPEC §5–§6 或 [Language-Standards.md](docs/wiki/Language-Standards.md)。

### 鏡像（`mirrors.*`）

`mirrors.pypi`、`npm`、`go`、`maven` 等預設指向內部 Nexus（SPEC §10.1）。改成同一台內部主機上的其他 repository 直接寫值即可；**改成內部主機以外的網址算放寬**，必須寫成 `{value, reason}`，報告中一直列為偏離，沒有理由就是錯誤。這樣 §10.2「設定指向外部來源是錯誤」不會被宣告悄悄繞過。devguard 自己在公司網路外開發，所以它的 [.devguard.yaml](.devguard.yaml) 就是這樣寫的：

```yaml
mirrors:
  npm:
    value: https://registry.npmjs.org/
    reason: "devguard 本身在公司網路外開發，沒有內部 Nexus 可用"
```

### 還沒有宣告：`devguard draft`

專案還沒有 `.devguard.yaml` 時（`check` 會回報「找不到 .devguard.yaml」並建議這個指令），執行 `devguard draft`，依偵測到的元件與既有的工具設定產生**草稿**並寫入 `.devguard.yaml`（SPEC §4.3）：

- **元件**：每個 `.py`、`.go`、`.ts`、`.java` 檔歸屬於最近一層有該語言建置或工具檔（`pyproject.toml` / `setup.py` / `setup.cfg` / `requirements.txt`、`go.mod`、`package.json` / `tsconfig.json`、`pom.xml` / `build.gradle(.kts)` / `settings.gradle(.kts)`）的目錄，沒有的話歸屬 repo 根目錄；monorepo 會產生多個元件。Java 的多模組建置以最外層的建置檔為一個元件。
- **覆寫**：沿用設定檢查讀取的工具設定。與預設相同的值省略；比預設嚴格的值、風格項目直接寫入；比預設寬鬆的值寫成 `{value, reason: "TODO: …"}`，**填寫理由之前 `check` 會回報錯誤**。
- **不覆寫**：`.devguard.yaml` 已存在時不做任何修改，以 exit code `2` 結束。

### 工具版本範圍

`check` 會讀出各元件用依賴管理鎖定的工具版本（`uv.lock` / `poetry.lock`、`package-lock.json`、`go.mod` 的 `tool`、`pom.xml` / `build.gradle(.kts)` 中的 plugin 版本），超出標準的版本範圍（`tools.<工具>` 項目）就回報錯誤。golangci-lint 例外：從 PATH 呼叫 `golangci-lint --version` 核對。專案用 pre-commit 框架時，其他工具 hook 的 `rev` 與鎖定版本不同會給提示（SPEC §8）。

> **待團隊訂定**：`team@1.0.0` 中各工具的版本範圍、golangci-lint 與 Dependency-Check plugin 的指定版本目前都是**佔位值**（SPEC §12 第 5 項），發佈前必須換成團隊訂定的值。

## 指令

```
devguard check [檔案…] [--staged] [--full] [--only lint|format|typecheck] [--format <格式>] [--strict] [--verbose]
devguard doctor [--quiet] [--exit-zero] [--format <格式>] [--strict] [--verbose]
devguard fix [--yes]
devguard fix --code [檔案…] [--yes]
devguard install [--yes]
devguard hook git-pre-commit|git-pre-push|claude-session-start|claude-post-edit|claude-stop
devguard draft
devguard standard upgrade [目標版本] [--apply]
devguard --version | --help
```

每個指令都接受 `--cwd <dir>`（專案根目錄，預設為目前目錄）。

| 指令 | 說明 |
|---|---|
| `check` | 依序執行專案宣告、未涵蓋檔案、四語言設定、依賴規則、工具版本、`.gitattributes`、鏡像、VS Code、Claude Code 與程式碼檢查（lint、格式、型別），不含環境檢查。給 CI 與 git hook 使用。指定檔案時，程式碼檢查只針對這些檔案 |
| `check --staged` | 只檢查 staged 的檔案，與 pre-commit hook 相同：formatter 與單檔 linter 讀 staged 版本（stdin），依賴相關檔案 staged 時才跑依賴規則 |
| `check --full` | 再加上各元件的完整測試、行 / 分支覆蓋率門檻與（開啟時的）弱點掃描，與 pre-push hook 相同；不能與檔案參數同時使用 |
| `doctor` | `check` 加上環境檢查：工具是否安裝、git hook 是否安裝（含既有 hook 框架與 `pre-commit install`）、VS Code 擴充套件、Claude Code 版本、Go 鏡像、帳密變數是否存在、npm audit 端點、標準是否有更新。只回報並附上修正指令，不自動安裝 |
| `fix` | 修正**設定**（互動式終端機先預覽 diff、確認後套用）：工具設定檔、`.vscode/`、`.claude/`、被修改過的 devguard git hook、`.gitattributes`、`lombok.config`。CLI 產生的檔案整份重新產生；共用的結構化檔只改 CLI 管理的 key；建置檔與程式碼形式的設定只印出片段（SPEC §9.2） |
| `fix --code` | 修正**程式碼**：格式化與可自動修正的 lint（Ruff、ESLint、Prettier、Biome、golangci-lint、Spotless），修正後回報剩餘問題 |
| `install` | `fix` 會產生的設定，加上 `.claude/` 的初次產生與 pre-commit / pre-push hook。專案已在用 pre-commit、husky 或 lefthook（YAML、TOML、JSON）時，改為在其設定中注入呼叫 devguard 的項目 |
| `hook <名稱>` | 給 git 與 Claude Code 的 hook 呼叫；各自處理輸入格式與 exit code |
| `draft` | 見上方 |
| `standard upgrade` | 預覽標準升級的差異、對本專案的影響與要執行的套件管理指令；`--apply` 才實際修改 |

| 選項 | 說明 |
|---|---|
| `--only <類別>` | 只執行單一類別的程式碼檢查：`lint`、`format` 或 `typecheck` |
| `--format text` | 預設。依元件、等級（錯誤、偏離、提示）分組，附上修正方式並標註能否用 `fix` 處理，最後一行是總結 |
| `--format json` | `{ standard, components[], findings[] }`，給 CI 或其他工具使用 |
| `--format sarif` | SARIF 2.1.0，只含程式碼類問題，給程式碼審查平台 |
| `--format vscode` | 每個問題一行 `檔案:行:欄: 等級: 訊息 [規則]`，給 VS Code problem matcher |
| `--format claude` | 最多 20 項、少於 4,000 字元，給 Claude Code |
| `--strict` | 偏離也算失敗 |
| `--verbose` | 展開所有提示（預設只顯示數量） |
| `--quiet` | doctor：只輸出錯誤與偏離，沒有問題時不輸出 |
| `--exit-zero` | doctor：有問題時也以 0 結束（`/standards-doctor` skill 嵌入結果用） |
| `--yes` | fix / install：不詢問，直接套用。非互動環境沒有加 `--yes` 時只預覽，並以 1 結束 |
| `--apply` | standard upgrade：實際套用 |
| `--cwd <dir>` | 指定專案根目錄（預設為目前工作目錄） |

**exit code**（SPEC §11）：`0` 通過（只有偏離或提示也算通過；`fix` 無須修改或已套用完成）、`1` 有錯誤（或 `--strict` 時有偏離；`fix` 使用者取消、非互動環境未加 `--yes` 且有待修正項目，或沒有可用的 `.devguard.yaml`）、`2` CLI 本身出錯（參數錯誤、檔案不在專案目錄內、`draft` 時宣告檔已存在、內部例外）。專案的工具尚未安裝時，`check` 以 `2` 結束並印出安裝指令（例如 `uv sync`、`npm ci`）；`doctor` 與各 hook 則把它回報成一項錯誤（附安裝指令），其餘檢查照常執行。

**帳密**：預覽、片段與報告中一律不顯示帳密的值（`.npmrc` 的 `_auth` / `_authToken` / `_password`、Maven 的 `<username>` / `<password>`、網址中的 `user:password@`）；只引用環境變數（`${…}`）的值照常顯示（SPEC §10.3）。

`check` 輸出範例：

```
標準：team@1.0.0

web/ (TypeScript)
  錯誤  覆蓋率門檻 (%)：80 → 60：比預設寬鬆，必須寫理由（改用 {value, reason, until}）  [declaration/looser-without-reason] .devguard.yaml:6

./ (Python)
  偏離  循環複雜度上限：10 → 15｜理由：舊專案｜到期：2027-03-31  [declaration/deviation] .devguard.yaml:13

1 個錯誤、1 個偏離、0 個提示
```

### 設定修正：`devguard fix`

`devguard fix` 會依檔案類別決定修改方式（SPEC §9.2）：

| 類別 | 範例 | `devguard fix` 做法 |
|---|---|---|
| **CLI 全權產生**（`generated`） | `checkstyle.xml`、`pmd-ruleset.xml`、`.mvn/settings.xml`、`.mvn/maven.config` | 整份重新產生，檔頭標註「由 CLI 產生（devguard），請勿手動修改」 |
| **結構化的共用檔**（`managed`） | `pyproject.toml`、`.golangci.yml`、`tsconfig.json`、`.prettierrc`、`biome.json`、`.gitattributes` | 只修改 CLI 管理的 key 或行規則，保留註解與原有順序 |
| **建置檔與程式碼設定**（`snippet`） | `pom.xml`、`build.gradle(.kts)`、`eslint.config.js`、`vitest.config.ts` | 不自動修改檔案，在預覽中印出應套用的設定片段 |
| **使用者層級設定**（`user`） | `~/.m2/settings.xml`、使用者的 `.npmrc`、`go env` | 絕不自動修改，只印出修改說明 |

## 三道防線運作細節

執行 `devguard install` 後，CLI 會在 repo 根目錄與 `.git/hooks/` 建立並管理三道防線的設定（SPEC §7）：

### 第一道防線：VS Code（`.vscode/`）

只在 repo 根目錄放一份 `.vscode/`（必須提交至 Git；若 `.gitignore` 忽略了 `.vscode/`，`check` 會提示改為 `.vscode/*` 並放行 `settings.json`、`extensions.json`、`tasks.json`）：

- **`extensions.json`**：依專案使用的語言與工具寫入推薦與不推薦的擴充套件：
  - **Python**：推薦 `ms-python.python`、`charliermarsh.ruff`、`ms-python.mypy-type-checker`（使用 mypy 時）；不推薦 `black-formatter`、`isort`、`flake8`、`pylint`
  - **Go**：推薦 `golang.go`
  - **TypeScript**：預設推薦 `dbaeumer.vscode-eslint`、`esbenp.prettier-vscode`（改用 Biome 時推薦 `biomejs.biome`，未選用的那一套列入不推薦），以及 `vitest.explorer`（使用 Vitest 時）
  - **Java**：推薦 `vscjava.vscode-java-pack`、`shengchen.vscode-checkstyle`
- **`settings.json`**（只修改 CLI 管理的 key，保留個人或專案其他設定）：
  - 共通：`files.eol: "\n"`
  - Python：存檔時以 Ruff 格式化並執行 `source.fixAll` / `source.organizeImports`，`ruff.importStrategy` 與 `mypy-type-checker.importStrategy` 設為 `fromEnvironment`，`python.defaultInterpreterPath` 指向 `.venv`
  - Go：`go.lintTool: "golangci-lint-v2"`、`go.lintOnSave: "package"`、`gopls.formatting.gofumpt: true`
  - TypeScript：存檔時以 Prettier 或 Biome 格式化並執行 `source.fixAll.eslint`（或 `source.fixAll.biome`），`js/ts.tsdk.path` 指向專案 `node_modules/typescript/lib`，`eslint.workingDirectories` 列出所有 ESLint 元件
  - Java：**關閉 `[java].editor.formatOnSave`**（避免 IDE 格式化與 Spotless Palantir 規則衝突），並將 `java.checkstyle.configuration` 與 `java.checkstyle.version` 同步至建置設定
- **`tasks.json`**：提供 `standards: doctor`（開啟資料夾時自動執行 `devguard doctor --quiet`）、`standards: check`、`standards: fix`、`standards: test & coverage`，以及 Java 專案的 `standards: format (Spotless)`。

### 第二道防線：Claude Code（`.claude/`）

由 `devguard install` 初次產生並提交，開發者在 Claude Code 信任專案資料夾後自動生效：

- **`.claude/rules/standards-<元件>.md`**：以 frontmatter `paths` 綁定元件目錄與副檔名，只在 Claude 讀寫該元件檔案時載入，提供精簡的語言標準、門檻、禁用清單與目前偏離項目。
- **`.claude/settings.json` hooks**：
  - `SessionStart`（`devguard hook claude-session-start`）：執行 `doctor --quiet` 將環境與設定問題注入 Claude context，並記錄 `.git/devguard/claude-last-seen`。
  - `PostToolUse`（matcher `Edit|Write`，`devguard hook claude-post-edit`）：每次 Claude 編輯檔案後，立即對該檔案跑 `lint` 與 `format`，有問題時以 JSON `decision: "block"` 回饋給 Claude（最多 20 項、少於 4,000 字元）。
  - `Stop`（`devguard hook claude-stop`）：Claude 完成一輪回答前，找出工作目錄所有變更與新增檔案執行 `lint`、`format`、`typecheck`；若連續失敗（`stop_hook_active`）則放行並以 `systemMessage` 提醒開發者，避免無限修正迴圈。
- **`/standards-doctor` skill（`.claude/skills/standards-doctor/SKILL.md`）**：由開發者手動呼叫，嵌入 `devguard doctor --format claude --exit-zero` 報告，經開發者同意後代為執行 `devguard fix --yes` 或 `devguard fix --code <檔案> --yes`。

### 第三道防線：git hook（`pre-commit` / `pre-push`）

- **安裝與框架相容**：`devguard install` 預設在 `.git/hooks/`（或 `core.hooksPath`）寫入帶 sha256 checksum 的 POSIX sh hook。若專案已使用 **pre-commit**（`.pre-commit-config.yaml`）、**husky**（`.husky/`）或 **lefthook**（`lefthook.yml` / `.toml` / `.json`），CLI 不會覆寫原有 hook，而是自動在該框架設定檔注入呼叫 `devguard` 的項目。
- **`pre-commit`（等同 `devguard check --staged`）**：
  - 只檢查 staged 檔案；若檔案為「部分 staged（partially staged）」，CLI **不做 `git stash`**，而是透過 `git show :<path>` 取出 staged 內容由 stdin 送交單檔工具（`ruff`、`eslint`、`prettier`、`biome`、`golangci-lint fmt --stdin`）檢查，避免工作區未暫存修改造成誤判；無 stdin 模式的工具（`mypy`、`pyright`、`tsc`、`golangci-lint run`、Java wrapper）則檢查工作區版本並印出提示。
  - 當依賴相關檔案（如 `pyproject.toml`、`uv.lock`、`package.json`、`go.mod`、`pom.xml` 等）被 staged 時，一併執行依賴規則檢查（lockfile 與禁用套件）。
  - hook 只檢查不自動改檔；失敗時會印出可直接複製執行的 `devguard fix --code <files>` 指令。
- **`pre-push`（等同 `devguard check --full`）**：完整執行所有檢查層、單元測試、行/分支覆蓋率門檻與（開啟時的）弱點掃描。

### 內部鏡像與帳密變數（`mirrors.auth: env`）

當專案宣告設定 `mirrors.auth: env` 時，設定檔只寫入環境變數引用，帳密絕不進 repo，`devguard doctor` 會在不讀取變數值的前提下檢查變數或憑證檔是否存在（SPEC §10.3）：

| 語言 / 工具 | 專案設定檔落地位置 | `mirrors.auth: env` 時需設定的本機環境變數 / 檔案 |
|---|---|---|
| Python（`uv`） | `pyproject.toml` 的 `[[tool.uv.index]]`（`name = "nexus"`） | `UV_INDEX_NEXUS_USERNAME`、`UV_INDEX_NEXUS_PASSWORD`（或通用 `NEXUS_USERNAME`、`NEXUS_PASSWORD`） |
| TypeScript（`npm` / `pnpm` / `yarn`） | `.npmrc` 的 `registry=` 與 `//<host>/<path>/:_auth=${NEXUS_NPM_AUTH}` | `NEXUS_NPM_AUTH`（`username:password` 的 base64）或 `NEXUS_NPM_TOKEN` |
| Java（Maven） | `.mvn/maven.config` + `.mvn/settings.xml` | `NEXUS_USERNAME`、`NEXUS_PASSWORD` |
| Java（Gradle） | `settings.gradle(.kts)` 片段（`credentials(PasswordCredentials)`） | `ORG_GRADLE_PROJECT_nexusUsername`、`ORG_GRADLE_PROJECT_nexusPassword` |
| Go | 使用者層級 `go env`（`GOPROXY`、`GOSUMDB`） | `NETRC` 環境變數指向的檔案，或 `%USERPROFILE%\_netrc` |

### 標準升級與弱點掃描

- **升級預設標準（`devguard standard upgrade`）**：
  ```bash
  devguard standard upgrade           # 預覽升級至最新內建標準的設定差異、既有覆寫變化與需執行的套件指令
  devguard standard upgrade --apply   # 實際更新 .devguard.yaml、修補設定檔，並透過內部鏡像執行套件管理指令
  ```
- **開啟弱點掃描（`deps.vulnScan: true`）**：在元件 `overrides` 將 `deps.vulnScan` 設為 `true` 後，`devguard check --full` 與 `pre-push` 會執行對應語言的弱點掃描（Python：`uv export` + `pip-audit`；Go：`govulncheck`；TypeScript：`npm audit`；Java：OWASP `dependency-check`）。若需暫時忽略特定弱點，可在 `deps.ignoredVulns` 填入 `{ id, reason, until }`。

## 開發

| 指令 | 用途 |
|---|---|
| `npm test` | 執行測試（Vitest） |
| `npm run test:coverage` | 測試並檢查覆蓋率（四項門檻皆為 80%） |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint（typescript-eslint `strictTypeChecked`，循環複雜度上限 10） |
| `npm run format` / `format:check` | Prettier（行寬 120、LF） |
| `npm run devguard -- <指令>` | 從原始碼執行 CLI，例如 `npm run devguard -- check` |
| `npm run build:exe [-- x64\|arm64]` | 用 Bun（≥ 1.2.23）打包成 `dist/devguard-windows-<arch>.exe`，含圖示與版本資訊。交叉編譯的目標沒有圖示與版本資訊（Bun 的限制） |
| `npm run smoke:exe [-- <exe>]` | 從 PATH 移除 Node 後，對 exe 執行 `--version` 與 `check`（範例專案） |
| `npm run t2:probe` / `build:t2-probe` | SPEC §13 T2：子程序行為探測，先在 Node 下跑基準，再打包成 `dist/t2-probe-windows-<arch>.exe` 執行比對 |

devguard 本身也遵守 SPEC §6.3 的 TypeScript 預設標準，並以 [.devguard.yaml](.devguard.yaml) 宣告自己。**例外：認知複雜度（上限 15）目前沒有檢查**。標準用 `eslint-plugin-sonarjs` 的 `cognitive-complexity`，但它的授權是 LGPL-3.0-only，還在等法務確認（SPEC §12 第 8 項），所以 devguard 自己還沒有加入；`devguard check` 對自己會一直顯示這一項提示。

測試大多在同一個程序內執行 CLI（`runCli`，[src/main.ts](src/main.ts)），以假的 `ToolRunner` 代替 ESLint、Ruff 等工具；只有少數測試真的啟動 `node src/cli.ts` 與真實工具。

### 目錄結構

```
src/
  cli.ts                 指令列入口（只接上 process）
  main.ts                runCli：參數解析與各指令，可在程序內測試
  check.ts               check 的各層與執行順序
  doctor.ts              check 加上環境層
  draft.ts               devguard draft
  scope.ts               [檔案…]、--only、--full 的範圍
  declaration/           宣告檔的解析、比對、套用、檔案歸屬
  standard/              內建的預設標準、版本查找與 standard upgrade
  layers/                check 的各層（宣告、設定、依賴、版本、鏡像、VS Code、Claude Code、程式碼、測試、弱點）
  settings/              各語言工具設定檔的設定檢查（Python、Go、Java、TypeScript）、寬鬆／嚴格判定與 Java 設定檔產生器
  code/                  各語言的 lint、格式、型別檢查
  testing/               各語言的測試與覆蓋率
  vuln/                  各語言的弱點掃描
  deps/                  依賴規則：lockfile 與禁用清單
  versions/              版本範圍、鎖定的工具版本、pre-commit rev
  mirrors/               專案層級的鏡像設定（uv、npm、Maven、Gradle）
  environment/           只有 doctor 跑的環境檢查
  hooks/                 git 與 Claude Code hook、install、既有 hook 框架
  fix/                   fix 的檔案分類、設定修補（YAML / JSONC / TOML / 行規則）、diff 預覽與套用、fix --code
  vscode/                .vscode/ 的 settings、extensions、tasks
  claude/                .claude/ 的 hooks、rules 與 /standards-doctor
  tools/                 執行專案鎖定的工具（uv run、node_modules/.bin、go tool、mvnw / gradlew）
  process/               啟動外部程序（.cmd 透過 cmd.exe）
  repo/                  repo 的檔案清單、元件歸屬與路徑工具
  report/                finding 型別、各種報告格式、exit code、帳密遮蔽
  shared/                共用的檔案讀取與型別守衛
  xml/                   XML 解析（含行號，不讀外部 DTD；供 pom.xml、Checkstyle、PMD、JaCoCo 使用）
test/                    Vitest 測試
scripts/                 exe 打包、smoke test、T2 探測
assets/                  exe 圖示
docs/                    Agent 規範與 Wiki 使用說明文件（docs/wiki/）
SPEC.md                  實作規格
GLOSSARY.md              用語定義
.scratch/                規劃過程：地圖、決策票、研究紀錄、原型
```

## 路線圖

依 SPEC 的章節與 GitHub Issues（#1–#28）逐步實作：

- [x] 專案宣告的解析與檢查（§4、§5.5、§11，#1）
- [x] 可插拔的檢查層與專案工具執行器（§2、§5.2，#2）
- [x] 偵測各工具的設定檔、設定檢查與依既有設定產生宣告草稿（§4.3、§6、§8，#3–#7）
- [x] 依賴規則與工具版本一致性檢查（§5.2、§5.4、§8，#8–#9）
- [x] 程式碼檢查、測試與覆蓋率、報告格式（§6、§7.1、§11，#10–#15）
- [x] `devguard fix` 與 `fix --code`（§9，#16–#17）
- [x] `devguard install` 與 git hook：pre-commit、pre-push、既有 hook 框架（§7.4，#18–#20）
- [x] `devguard doctor`、內部鏡像與帳密檢查（§7.4、§10，#21、#24）
- [x] VS Code：`.vscode/` 的 extensions、settings、tasks（§7.2，#22）
- [x] Claude Code：`.claude/` 的 rules、hooks 與 `/standards-doctor`（§7.3，#23）
- [x] 弱點掃描（§5.3，#25）
- [x] `devguard standard upgrade` 與棄用版本（§5.5，#26）
- [x] 實際專案測試（KEI-6、KEI-7）
- [x] Bun 打包單一 exe、smoke test 與 T1 / T2 實機測試（§3.1、§13，#27）
- [x] 以 GitHub Release 發佈 exe（§3.1；原本規劃的簽章與內部 Scoop bucket 已取消，#28）

### 已知限制

- 弱點掃描：pnpm / yarn、Poetry 與 Gradle 元件尚未支援，掃描時只給提示。
- 多數 checker 與 fixer 只以工具的範例輸出與實際專案的設定檔測試過（ESLint、Prettier、tsc、Vitest、Ruff、mypy、pytest、`go test` 有真實執行）。

導入前需要團隊或 IT 確認的事項見 SPEC §12，實作初期要實機測試的項目見 SPEC §13。
