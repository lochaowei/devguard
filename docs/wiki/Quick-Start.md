# 快速開始（Quick Start）

本頁說明如何安裝 `devguard`，並針對 **Python**、**Go**、**TypeScript**、**Java** 四種語言提供從零導入專案、設定三道防線、執行檢查與自動修正的完整步驟。

---

## 1. 安裝 `devguard`

### 一般開發者與 CI：下載單一執行檔

1. 前往 [GitHub Releases](https://github.com/lochaowei/devguard/releases/latest) 下載對應架構的執行檔：
   - x64 Windows：`devguard-windows-x64.exe`
   - ARM64 Windows：`devguard-windows-arm64.exe`
2. （選用）使用同一 Release 附帶的 `SHA256SUMS.txt` 驗證雜湊值：
   ```powershell
   Get-FileHash .\devguard-windows-x64.exe -Algorithm SHA256
   ```
3. 將檔案重新命名為 `devguard.exe`，並放入系統 `PATH` 中的目錄。
4. 確認安裝成功：
   ```bash
   devguard --version
   devguard --help
   ```

> **備註**：`devguard.exe` 由 Bun 打包為獨立執行檔，**不需要安裝 Node.js**，也沒有程式碼簽章（SPEC §3.1）。更新版本時直接下載新檔覆蓋即可。

### 開發 `devguard` 本身：從原始碼執行

需要 **Node.js >= 22.18**（直接執行 TypeScript 原始碼）：

```bash
npm ci
npm run devguard -- check
```

---

## 2. 導入專案的五個通用步驟

無論專案使用哪一種語言（或包含多種語言的 monorepo），導入流程皆相同：

```bash
# 1. 產生或撰寫專案宣告 .devguard.yaml
devguard draft          # 掃描既有專案自動產生草稿；新專案亦可直接手寫 .devguard.yaml

# 2. 安裝並鎖定該語言的開發工具（詳見下方各語言章節）

# 3. 產生三道防線與工具設定檔（.vscode/、.claude/、工具設定、鏡像設定、git hooks）
devguard install        # 互動式預覽 diff，確認後寫入；非互動環境可加 --yes

# 4. 執行檢查與修正
devguard check          # 執行宣告、設定、依賴、工具版本與程式碼檢查（lint / format / typecheck）
devguard fix            # 自動修正設定檔（保留註解與順序）
devguard fix --code     # 自動修正程式碼排版與可自動修復的 lint 問題
devguard check --full   # 加上完整測試、行/分支覆蓋率門檻與（開啟時的）弱點掃描

# 5. 檢查本機開發環境
devguard doctor         # 檢查 VS Code 擴充套件、git hook、Claude Code 版本、Go 鏡像、帳密環境變數
```

> **重要提醒**：
> - **先設定 `.gitignore`**：`devguard` 會透過 `git ls-files` 取得專案檔案清單。執行 `devguard draft` 或 `check` 前，請確保 `.gitignore` 已忽略 `.venv/`、`node_modules/`、`target/`、`build/`、`dist/`、`coverage/` 等目錄，避免第三方套件被當成專案元件。
> - **公司網路外開發（無內部 Nexus 鏡像）**：預設標準 `team@1.0.0` 要求套件鏡像指向內部 Nexus。若在外部環境測試或開發，請在 `.devguard.yaml` 的 `mirrors` 區塊覆寫為公開來源並寫明 `reason`（會記錄為「偏離」，不會阻擋 `check`）：
>   ```yaml
>   mirrors:
>     pypi:
>       value: https://pypi.org/simple
>       reason: "公司網路外開發，沒有內部 Nexus 可用"
>     npm:
>       value: https://registry.npmjs.org/
>       reason: "公司網路外開發，沒有內部 Nexus 可用"
>   ```

---

## 3. 各語言快速開始

### 3.1 Python

#### 前置需求與安裝工具
- Python `>= 3.11`（若 `pyproject.toml` 的 `requires-python` 更高，則以專案為準）
- 套件管理工具：預設使用 **`uv`**（可在 `.devguard.yaml` 改用 `poetry`）
- 在專案環境（`.venv`）安裝並鎖定標準要求的開發工具（寫入 `pyproject.toml` 與 `uv.lock`）：
  ```bash
  uv init --lib
  uv add --dev "ruff>=0.17,<0.18" "mypy>=1.18,<2" "pytest>=8,<10" "pytest-cov>=6,<8"
  # 若型別檢查改用 pyright：
  # uv add --dev "pyright>=1.1.400,<1.2"
  ```

#### 專案宣告 `.devguard.yaml`
```yaml
standard: team@1.0.0
components:
  - path: ./
    language: python
    # 選用覆寫範例：
    # overrides:
    #   typecheck.tool: pyright   # 允許替代：mypy（預設）| pyright
    #   deps.manager: poetry      # 允許替代：uv（預設）| poetry
    #   format.lineLength: 100    # 風格項目：直接寫值
```

#### 執行 `devguard install` 產生的設定
`devguard install`（或 `devguard fix`）會保留 `pyproject.toml` 原有註解與欄位順序，自動補齊或更新以下區塊：
```toml
[tool.ruff]
line-length = 120
target-version = "py311" # 依 requires-python 自動推導

[tool.ruff.lint]
select = ["E", "W", "F", "I", "B", "UP", "C90", "SIM", "N", "S", "TID"]

[tool.ruff.lint.mccabe]
max-complexity = 10

[tool.ruff.lint.per-file-ignores]
"**/tests/**" = ["S101"]
"**/test_*.py" = ["S101"]

[tool.mypy]
strict = true
python_version = "3.11"

[tool.coverage.run]
branch = true

[[tool.uv.index]]
name = "nexus"
url = "https://nexus.example.internal/repository/pypi-proxy/simple"
default = true
```
同時建立 `.gitattributes`（`* text=auto eol=lf`）、`.vscode/`（設定 Ruff 為預設 formatter、存檔執行 `fixAll` 與 `organizeImports`、指定 `.venv` 直譯器）、`.claude/` 與 git hooks。

#### 檢查與修正指令
| 指令 | 實際執行的動作 |
|---|---|
| `devguard check` | 驗證 `pyproject.toml`、`uv.lock`（或 `poetry.lock`）、禁用套件（`pycrypto`、`nose`）、工具版本範圍，並以 `uv run --no-sync` 執行 `ruff check`、`ruff format --check`、`mypy`（或 `pyright`） |
| `devguard fix` | 自動修補 `pyproject.toml`、`.gitattributes`、`.vscode/`、`.claude/` |
| `devguard fix --code` | 執行 `ruff check --fix` 與 `ruff format`，並回報剩餘需手動修改的問題 |
| `devguard check --full` | 額外執行 `uv run pytest --cov --cov-branch --cov-report=json`，檢查**行覆蓋率與分支覆蓋率各自達到 80%** |

---

### 3.2 Go

#### 前置需求與安裝工具
- Go `>= 1.26`（`go.mod` 的 `go` directive）
- **`golangci-lint`（v2）**：這是唯一由開發者安裝並放到 `PATH` 的工具（SPEC §5.2 例外），版本須符合 `>=2.12,<3`：
  ```bash
  golangci-lint --version   # 確認在 >=2.12,<3 範圍內
  ```
- 在 `go.mod` 以 `tool` directive 鎖定 `gofumpt`、`goimports`、`govulncheck`，並確保 `go.mod` / `go.sum` 已提交且 `go mod tidy -diff` 乾淨：
  ```bash
  go mod init example.com/my-service
  go get -tool mvdan.cc/gofumpt@latest golang.org/x/tools/cmd/goimports@latest golang.org/x/vuln/cmd/govulncheck@latest
  go mod tidy
  ```
- 設定本機 Go 鏡像環境變數（使用者層級設定，CLI 不自動修改，`devguard doctor` 會檢查）：
  ```bash
  go env -w GOPROXY=https://nexus.example.internal/repository/go-proxy/
  go env -w GOSUMDB="sum.golang.org https://nexus.example.internal/repository/go-sumdb-proxy/"
  ```

#### 專案宣告 `.devguard.yaml`
```yaml
standard: team@1.0.0
components:
  - path: ./
    language: go
```

#### 執行 `devguard install` 產生的設定
`devguard install`（或 `devguard fix`）會產生或更新 `.golangci.yml`（v2 格式）：
```yaml
version: "2"
linters:
  enable:
    - errcheck
    - govet
    - ineffassign
    - staticcheck
    - unused
    - gosec
    - revive
    - errorlint
    - bodyclose
    - misspell
    - cyclop
    - gocognit
    - gomodguard_v2
    - depguard
  settings:
    cyclop:
      max-complexity: 10
    gocognit:
      min-complexity: 15
    gomodguard_v2:
      blocked:
        modules:
          - github.com/pkg/errors
          - github.com/golang/protobuf
    depguard:
      rules:
        devguard:
          deny:
            - pkg: io/ioutil
              desc: 標準禁用的套件（deps.bannedApis）
formatters:
  enable:
    - gofumpt
    - goimports
```
同時在 `.vscode/settings.json` 設定 `go.lintTool: "golangci-lint-v2"`、`go.lintOnSave: "package"` 與 `gopls.formatting.gofumpt: true`。

#### 檢查與修正指令
| 指令 | 實際執行的動作 |
|---|---|
| `devguard check` | 檢查 `go.mod` / `go.sum`、`go mod tidy -diff`（強制 `GOPROXY=off` 與 `GOTOOLCHAIN=local`）、禁用模組、`golangci-lint` 版本，並執行 `golangci-lint run` 一次檢查 lint、format 與型別編譯問題 |
| `devguard check --staged` | 對 staged 的 `.go` 檔案額外以 `golangci-lint fmt --stdin` 檢查 staged 版本的排版 |
| `devguard fix` | 自動修補 `.golangci.yml`、`.gitattributes`、`.vscode/`、`.claude/` |
| `devguard fix --code` | 執行 `golangci-lint run --fix`（含 `gofumpt` 與 `goimports` 格式化） |
| `devguard check --full` | 執行 `go test -coverprofile=<tmp> ./...` 與 `go tool cover -func`，排除自動產生檔案（`// Code generated … DO NOT EDIT.`）與 `mocks/` 後檢查總行覆蓋率 `>= 80%` |

---

### 3.3 TypeScript

#### 前置需求與安裝工具
- Node.js `>= 22`（`package.json` 的 `engines.node` 須設為 `>=22`）
- 預設工具組合：`npm` + `eslint+prettier` + `vitest`（可於 `.devguard.yaml` 改用 `pnpm` / `yarn`、`biome`、`jest`）
- 安裝並鎖定開發依賴（產生 `package-lock.json`）：
  ```bash
  npm init -y
  npm pkg set type=module "engines.node=>=22"
  npm i -D "typescript@>=6 <7" "eslint@>=10 <11" "typescript-eslint@>=8 <9" \
    "eslint-plugin-sonarjs@>=3 <4" "prettier@>=3 <4" "vitest@>=5 <6" "@vitest/coverage-v8@>=5 <6"
  ```
  > 若改用 **Biome**：`npm i -D "@biomejs/biome@>=2 <3"`；若改用 **Jest**：`npm i -D "jest@>=30 <31"`。

#### 專案宣告 `.devguard.yaml`
```yaml
standard: team@1.0.0
components:
  - path: ./
    language: typescript
    # 選用覆寫範例：
    # overrides:
    #   lint.tool: biome          # 允許替代：eslint+prettier（預設）| biome
    #   test.tool: jest           # 允許替代：vitest（預設）| jest
    #   deps.manager: pnpm        # 允許替代：npm（預設）| pnpm | yarn
```

#### 設定檔產生與程式碼設定片段
1. 執行 `devguard install` 會**自動建立或修補（`managed`）**：
   - `tsconfig.json`：設定 `strict: true`、`noUncheckedIndexedAccess: true`、`noImplicitOverride: true`、`noFallthroughCasesInSwitch: true`
   - `.prettierrc`：`{ "printWidth": 120, "endOfLine": "lf" }`（若選用 Biome 則修補 `biome.json`）
   - `.npmrc`：寫入 `registry=https://nexus.example.internal/repository/npm-proxy/`
   - `.vscode/`：設定 Prettier / Biome 為預設 formatter、存檔執行 `source.fixAll.eslint`、指定 `js/ts.tsdk.path` 為 `node_modules/typescript/lib`
2. **手動建立程式碼設定檔（`snippet`）**：`eslint.config.js` 與 `vitest.config.ts` 是 JavaScript/TypeScript 程式碼，CLI 只會印出應套用的片段，不會自動改寫檔案。建議範本如下：
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
   > 建議在 `.prettierignore` 加入 `.claude/` 與 `coverage/`，避免 Prettier 檢查產生的規則 Markdown 或測試報告。

#### 檢查與修正指令
| 指令 | 實際執行的動作 |
|---|---|
| `devguard check` | 檢查 `package.json`、`tsconfig.json`、ESLint / Prettier（或 Biome）、Vitest / Jest 覆蓋率門檻、lockfile 與禁用套件（`moment`、`request`、`node-fetch`），並透過 `node_modules/.bin` 執行 `eslint`、`prettier --list-different`、`tsc --noEmit` |
| `devguard fix` | 自動修補 `tsconfig.json`、`.prettierrc` / `biome.json`、`.npmrc`、`.vscode/`、`.claude/`，並印出 `eslint.config.js` / `vitest.config.ts` 缺少的設定片段 |
| `devguard fix --code` | 執行 `eslint --fix` 與 `prettier --write`（或 `biome lint/format --write`） |
| `devguard check --full` | 執行 `vitest run --coverage`（或 `jest --coverage`），解析 `coverage-summary.json` 驗證 `lines`、`branches`、`functions`、`statements` 四項皆 `>= 80%` |

---

### 3.4 Java

#### 前置需求與建置 Wrapper
- JDK `>= 17`（新專案建議 21+）
- 建置工具：預設 **Maven**，可在 `.devguard.yaml` 改用 **Gradle**
- **必須提交建置 Wrapper**：`devguard` 一律透過專案目錄（或上層多模組根目錄）的 `./mvnw`（`mvnw.cmd`）或 `./gradlew`（`gradlew.bat`）呼叫建置工具：
  ```bash
  # Maven 專案：
  mvn -N wrapper:wrapper
  # Gradle 專案：
  gradle wrapper
  ```

#### 專案宣告 `.devguard.yaml`
```yaml
standard: team@1.0.0
components:
  - path: ./
    language: java
    # 選用覆寫範例：
    # overrides:
    #   build.tool: gradle        # 允許替代：maven（預設）| gradle
    #   java.minVersion: "21"     # 收緊最低 Java 版本
```

#### 設定檔產生與建置檔設定片段
1. 執行 `devguard install` 會**自動產生或修補**：
   - `checkstyle.xml`（`generated`）：由 CLI 全權產生，內含 `CyclomaticComplexity`（上限 10）與 `IllegalImport`（禁用 `sun.*`）
   - `pmd-ruleset.xml`（`generated`）：由 CLI 全權產生，引用 `rulesets/java/quickstart.xml` 並設定 `CognitiveComplexity`（`reportLevel = 15`）
   - `.mvn/maven.config` 與 `.mvn/settings.xml`（`generated`，Maven 專案）：設定內部 Maven 鏡像與 `${env.NEXUS_USERNAME}` / `${env.NEXUS_PASSWORD}`
   - `lombok.config`（`managed`，當專案使用 Lombok 時）：自動加上 `lombok.addLombokGeneratedAnnotation = true`，讓 JaCoCo 排除 Lombok 產生的程式碼
   - `.vscode/`（`managed`）：關閉 `[java].editor.formatOnSave`（避免 IDE 格式化與 Spotless Palantir 衝突）、將 `java.checkstyle.configuration` 與 `java.checkstyle.version` 同步至建置設定，並在 `tasks.json` 加入 `standards: format (Spotless)`
2. **手動加入建置檔（`snippet`）**：`pom.xml` 與 `build.gradle(.kts)` 為建置檔，CLI 不會自動修改，只會印出提示片段。以 Maven `pom.xml` 為例，需設定：
   ```xml
   <properties>
     <maven.compiler.release>17</maven.compiler.release>
   </properties>

   <build>
     <plugins>
       <!-- 格式化：Spotless + palantir-java-format -->
       <plugin>
         <groupId>com.diffplug.spotless</groupId>
         <artifactId>spotless-maven-plugin</artifactId>
         <version>2.44.2</version>
         <configuration>
           <java><palantirJavaFormat/></java>
         </configuration>
       </plugin>
       <!-- Checkstyle：指向 CLI 產生的 checkstyle.xml -->
       <plugin>
         <groupId>org.apache.maven.plugins</groupId>
         <artifactId>maven-checkstyle-plugin</artifactId>
         <version>3.6.0</version>
         <configuration>
           <configLocation>checkstyle.xml</configLocation>
         </configuration>
       </plugin>
       <!-- PMD：指向 CLI 產生的 pmd-ruleset.xml -->
       <plugin>
         <groupId>org.apache.maven.plugins</groupId>
         <artifactId>maven-pmd-plugin</artifactId>
         <version>3.26.0</version>
         <configuration>
           <rulesets><ruleset>pmd-ruleset.xml</ruleset></rulesets>
         </configuration>
       </plugin>
       <!-- 覆蓋率：JaCoCo -->
       <plugin>
         <groupId>org.jacoco</groupId>
         <artifactId>jacoco-maven-plugin</artifactId>
         <version>0.8.12</version>
         <executions>
           <execution><goals><goal>prepare-agent</goal></goals></execution>
           <execution><id>report</id><phase>test</phase><goals><goal>report</goal></goals></execution>
         </executions>
       </plugin>
       <!-- 依賴鎖定：禁止動態版本與處理版本衝突 -->
       <plugin>
         <groupId>org.apache.maven.plugins</groupId>
         <artifactId>maven-enforcer-plugin</artifactId>
         <version>3.5.0</version>
         <executions>
           <execution>
             <id>enforce</id>
             <goals><goal>enforce</goal></goals>
             <configuration>
               <rules>
                 <banDynamicVersions/>
                 <dependencyConvergence/>
               </rules>
             </configuration>
           </execution>
         </executions>
       </plugin>
     </plugins>
   </build>
   ```
   > **Gradle 專案**：在 `build.gradle(.kts)` 套用 `com.diffplug.spotless`（`>=7,<8`）、`checkstyle`（`toolVersion` `>=10.21,<11`）、`pmd`（`toolVersion` `>=7,<8`）、`jacoco`（`toolVersion` `>=0.8.12,<0.9`，開啟 `xml.required = true`），並啟用 `dependencyLocking { lockAllConfigurations() }` 提交 `gradle.lockfile`。

#### 檢查與修正指令
| 指令 | 實際執行的動作 |
|---|---|
| `devguard check` | 檢查 Wrapper、`pom.xml` / `build.gradle(.kts)` 版本與鎖定規則、`checkstyle.xml`、`pmd-ruleset.xml`、`lombok.config`、禁用依賴（`log4j:log4j`、`junit:junit`），並透過 Wrapper 執行 `spotless:check`、`checkstyle:check`、`pmd:check`（或 Gradle 對應 tasks）解析 XML 報告 |
| `devguard fix` | 重新產生 `checkstyle.xml`、`pmd-ruleset.xml`、`.mvn/`，修補 `lombok.config`、`.vscode/`、`.claude/`，並印出建置檔需手動修改的片段 |
| `devguard fix --code` | 透過 Wrapper 執行 `spotless:apply`（或 `spotlessApply`）格式化 Java 程式碼 |
| `devguard check --full` | 執行 `mvnw test jacoco:report`（或 `gradlew test jacocoTestReport`），解析 `jacoco.xml` 驗證 `LINE` 與 `BRANCH` 覆蓋率各自 `>= 80%` |

---

## 4. Monorepo 多語言專案範例

若同一個 repo 同時包含多個服務（例如 `backend/` 為 Go、`worker/` 為 Python、`web/` 為 TypeScript），只需在 repo 根目錄放一份 `.devguard.yaml`：

```yaml
standard: team@1.0.0
components:
  - path: backend/
    language: go
  - path: worker/
    language: python
  - path: web/
    language: typescript
    overrides:
      lint.tool: biome
```

- `devguard install` 會在 repo 根目錄產生**單一份** `.vscode/`（合併所有使用語言的推薦擴充套件、設定與 `eslint.workingDirectories`）與 `.claude/`（為每個元件產生專屬的 `.claude/rules/standards-<元件>.md`），並在各元件目錄產生對應的工具設定檔。
- 也可以對單一檔案或子目錄檔案執行檢查與修正：
  ```bash
  devguard check backend/internal/handler.go web/src/App.tsx
  devguard fix --code worker/
  ```
