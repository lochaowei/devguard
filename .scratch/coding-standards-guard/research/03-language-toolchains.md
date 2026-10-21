# 研究：四種語言的檢查工具鏈現況

來源票：[03-language-toolchains](../issues/03-language-toolchains.md)
研究日期：2026-10-22

本文只整理事實，**不做選型決定**，選型交給各語言的「預設標準」grilling 票。

標記說明：
- 沒有標記的項目：已對照下方列出的官方文件或 marketplace 頁面。
- **〔未驗證〕**：根據既有知識撰寫，這次沒有逐字核對來源，grilling 前應再確認。

用語說明：「VS Code 讀同一份設定」指擴充套件會直接讀專案裡的工具設定檔（例如 `pyproject.toml`），不需要在 `settings.json` 另外寫一份規則。這是「三道防線共用設定檔」能否成立的關鍵。

---

## 跨語言重點摘要

| 面向 | Python | Go | TypeScript | Java |
|---|---|---|---|---|
| lint / format | Ruff（lint 與 format 一體） | golangci-lint v2（lint 加 `fmt`） | ESLint 搭配 Prettier，或 Biome | Checkstyle、PMD、Spotless |
| complexity 預設上限 | Ruff C901：10 | cyclop：10；gocyclo / gocognit：30（官方建議 10–20） | ESLint `complexity`：20；Biome 認知複雜度：15 | Checkstyle：10；PMD 循環複雜度：10、認知複雜度：15 |
| coverage 門檻 | coverage.py `fail_under`（未設 = 不檢查） | **沒有內建門檻**，需自行解析 `go tool cover -func` | Vitest `coverage.thresholds`、Jest `coverageThreshold` | JaCoCo `check` 的 rules |
| 弱點掃描 | pip-audit | govulncheck | npm / pnpm / yarn audit | OWASP Dependency-Check |
| 禁用清單 | Ruff TID251 banned-api〔未驗證〕 | depguard、gomodguard_v2 | ESLint `no-restricted-imports`〔未驗證〕 | Maven Enforcer `bannedDependencies`〔未驗證〕 |
| 型別檢查 | mypy、pyright | 編譯器本身就做 | `tsc --noEmit` | 編譯器本身就做 |
| VS Code 讀同一份設定 | 是（Ruff、mypy、Pylance） | golangci-lint 是；格式化走 gopls | 是（ESLint、Prettier、Biome） | **部分**：Checkstyle 要在 settings 指定路徑；Spotless 沒有 IDE 對應 |

業界常見數值：
- **cyclomatic complexity 10** 是 McCabe 的傳統建議值，Ruff、cyclop、Checkstyle、PMD 的預設都是 10。ESLint 預設 20 比較寬鬆。
- **cognitive complexity 15** 是 PMD 與 Biome 的預設，和 SonarSource 的慣例一致〔Sonar 的部分未驗證〕。
- **coverage 80%**：各工具的預設都是「不設門檻」。80 是業界慣例，JaCoCo、Jest 官方範例也用 0.80 / 80。Vitest 的 watermarks 預設是 `[50, 80]`，但只影響報告上色，不是門檻。

---

## Python

### lint / format：Ruff

| 項目 | 事實 |
|---|---|
| 設定檔 | `pyproject.toml` 的 `[tool.ruff]`、`ruff.toml`、`.ruff.toml`（TOML 格式） |
| 同一目錄有多個設定檔時 | `.ruff.toml` 優先於 `ruff.toml`，`ruff.toml` 又優先於 `pyproject.toml`。沒有 `[tool.ruff]` 段落的 `pyproject.toml` 會被忽略 |
| 設定檔階層 | 每個檔案使用離它最近的設定檔，**不會自動合併**多層設定，要合併需寫 `extend = "../pyproject.toml"`。找不到任何設定時，用使用者層級設定或內建預設值 |
| 用 CLI 單獨執行 | `ruff check [--fix]`、`ruff format [--check]` |
| 預設值 | `line-length = 88`；`lint.mccabe.max-complexity = 10`（規則 C901）；預設啟用的規則是 `E4, E7, E9, F`〔規則集未驗證〕，C901 預設不啟用〔未驗證〕 |
| VS Code 擴充套件 | `charliermarsh.ruff`（Astral 官方）。**會讀**上述三種設定檔，官方也建議用設定檔讓 CLI 和擴充套件共用。擴充套件內附一份 ruff（頁面寫 0.17.1）。尋找 ruff 的順序：目前 Python 環境、PATH、內附版本。未受信任的 workspace 一律用內附版本。可用 `ruff.configuration` 指定設定檔路徑 |
| 存檔時格式化 | 在 settings 寫 `"[python]": {"editor.formatOnSave": true, "editor.defaultFormatter": "charliermarsh.ruff"}`，另可加 `source.fixAll`、`source.organizeImports` |
| Windows | 有官方 Windows 版 wheel 與二進位檔〔未驗證〕 |
| 一致性風險 | 擴充套件內附的 ruff 版本可能和專案鎖定的版本不同 |

### 型別檢查：mypy 與 pyright

| 項目 | mypy | pyright / Pylance |
|---|---|---|
| 設定檔 | 從目前目錄往上找，依序是 `mypy.ini`、`.mypy.ini`、`pyproject.toml` 的 `[tool.mypy]`、`setup.cfg` 的 `[mypy]`。找不到時用使用者層級設定。不會合併多個設定檔 | `pyrightconfig.json`，或 `pyproject.toml` 的 `[tool.pyright]`。兩者都存在時以 `pyrightconfig.json` 為準 |
| 嚴格模式 | `strict = true`（預設 False），它涵蓋哪些檢查會隨 mypy 版本改變 | `typeCheckingMode` 可設 `off`、`basic`、`standard`、`strict`，**預設 `standard`** |
| 用 CLI 單獨執行 | `mypy .` | `pyright`（npm 套件或 PyPI 上的包裝套件〔未驗證〕） |
| VS Code 擴充套件 | `ms-python.mypy-type-checker`（Microsoft）。內附 mypy 1.15.0。`importStrategy` 預設 `useBundled`，可改成 `fromEnvironment`。`reportingScope` 預設 `file`（只檢查開著的檔案）。`cwd` 可設 `${nearestConfig}`，用最近的設定檔所在目錄當工作目錄 | `ms-python.vscode-pylance`，以 pyright 為核心。只要有 pyright 設定檔，**settings.json 裡的 pyright 設定就全部被忽略**，所以會以專案設定檔為準 |
| 一致性風險 | 預設用內附版本，可能和專案鎖定的版本不同；要一致應設 `fromEnvironment` | Pylance 使用的 pyright 版本跟著擴充套件走 |

### test coverage：pytest-cov 與 coverage.py

| 項目 | 事實 |
|---|---|
| 設定檔 | 優先順序：`--rcfile` 或環境變數 `COVERAGE_RCFILE`，接著 `.coveragerc`、`.coveragerc.toml`、`setup.cfg`、`tox.ini`、`pyproject.toml` 的 `[tool.coverage.*]`。使用第一個含有 coverage 設定的檔案 |
| 門檻 | `[report] fail_under`（浮點數）。總覆蓋率低於門檻時 exit code 為 2。沒有預設值，也就是預設不檢查 |
| 分支覆蓋率 | `[run] branch` 預設 False |
| 用 CLI 執行 | `pytest --cov --cov-fail-under=80`〔參數名稱未驗證〕，或 `coverage run -m pytest && coverage report` |
| VS Code | Python 擴充套件的 Testing 面板可以顯示 coverage〔未驗證〕，但不會強制門檻 |

### dependency

| 項目 | 事實 |
|---|---|
| lockfile | `uv.lock`、`poetry.lock`、`pylock.toml`（PEP 751）、帶 hash 的 `requirements.txt`〔uv 與 poetry 的部分未驗證〕 |
| 弱點掃描：pip-audit 2.10.1 | 支援四種輸入：`-r requirements.txt`、專案目錄 `pip-audit .`（目前只支援 `pyproject.toml` 與 `pylock.*.toml`）、`--locked`、目前的 Python 環境。資料來源預設 PyPI，可用 `-s osv` 改成 OSV。`--ignore-vuln ID` 可忽略指定弱點。**exit code：0 = 沒有弱點，1 = 有弱點，而且無法關閉這個行為**。官方提供 pre-commit hook（`id: pip-audit`） |
| 讀 `uv.lock` | pip-audit 不直接讀 `uv.lock`，常見做法是先 `uv export` 成 requirements 格式再掃描〔未驗證〕 |
| 禁用清單 | Ruff 的 `flake8-tidy-imports` banned-api（TID251）可禁止 import 指定模組〔未驗證〕。限制「宣告了哪些套件」沒有主流的專用工具 |

---

## Go

### lint / format：golangci-lint v2

| 項目 | 事實 |
|---|---|
| 設定檔 | `.golangci.yml`、`.golangci.yaml`、`.golangci.toml`、`.golangci.json`。v2 格式必須寫 `version: "2"`（唯一合法值） |
| 尋找順序 | 先找目前目錄，再從第一個要分析的路徑一路往上找到根目錄，最後找 home 目錄。加 `-v` 可看出實際用了哪一份 |
| 用 CLI 單獨執行 | `golangci-lint run [--fix]`、`golangci-lint fmt` |
| 支援的 formatter | `gofmt`、`gofumpt`、`goimports`、`gci`、`golines`、`swaggo`，都能自動修正 |
| complexity 相關 linter 預設值 | `cyclop.max-complexity` = **10**；`gocyclo.min-complexity` = **30**；`gocognit.min-complexity` = **30**（官方註明「建議 10–20」）；`funlen` = 60 行、40 個 statement |
| depguard | 沒有自訂規則時，預設規則是「全部檔案只允許 import 標準庫（`$gostd`）」 |
| gomodguard | v2.12.0 起標為 deprecated，改用 `gomodguard_v2` |
| Windows | 官方提供 Windows 二進位檔〔未驗證〕 |

### VS Code：`golang.go`（Go 團隊官方）

| 設定 | 值 |
|---|---|
| `go.lintTool` | 可選 `staticcheck`、`golint`、`golangci-lint`、`golangci-lint-v2`、`revive`。settings 頁寫「未設定時不跑額外 linter」（tools 頁的說法不同，寫 staticcheck 是預設，兩頁互相矛盾）。gopls 已內含 staticcheck 分析 |
| `go.lintOnSave` | `file`、`package`、`workspace`、`off`，預設 `package` |
| `go.lintFlags` | 傳給 linter 的額外參數 |
| `go.formatTool` | `default`（gopls）、`gofmt`、`goimports`、`gofumpt`、`custom`。**不能直接用 `golangci-lint fmt` 當格式化工具**，只能透過 `custom` 搭配 `go.alternateTools.customFormatter` |
| `.golangci.yml` | 擴充套件文件沒有明說。實際上它呼叫 golangci-lint，由 golangci-lint 自己依上面的順序找設定檔，所以會讀同一份〔推論〕 |
| coverage | `go.coverOnSave` 預設 false，開啟後存檔時執行 `go test -coverprofile`，只做顯示 |

### test coverage

`go test -cover` 或 `-coverprofile=c.out` 加上 `go tool cover -func=c.out` 可以產出數字，但 **Go 工具鏈沒有門檻參數**，要在 CLI 自行解析 total 行。也有第三方工具可做門檻〔例如 go-test-coverage，未驗證〕。

### dependency

| 項目 | 事實 |
|---|---|
| lockfile | `go.mod` 加 `go.sum`。Go 1.16 起預設等同 `-mod=readonly`：`go.mod` 需要更新時會報錯，不會自動改寫 |
| 一致性檢查 | `go mod tidy -diff`（Go 1.23 起）只顯示差異，有差異時 exit 非 0；`go mod verify` 驗證模組快取的 hash〔兩者都未逐字驗證〕 |
| 弱點掃描：govulncheck | `govulncheck ./...`。預設做 source 分析，只回報**實際呼叫到**的有弱點程式碼。另有 `-mode binary`。**exit code：一般模式有弱點時非 0；用 `-json`、`-format sarif`、`-format openvex` 時一律回 0**。**不支援忽略指定弱點**（go.dev/issue/61211） |
| 禁用清單 | golangci-lint 的 depguard、gomodguard_v2 |

---

## TypeScript

### lint：ESLint（v9 以上用 flat config）

| 項目 | 事實 |
|---|---|
| 設定檔 | `eslint.config.js`、`.mjs`、`.cjs`、`.ts`、`.mts`、`.cts`（TS 版本需額外設定）。多個並存時依此順序優先 |
| 尋找方式 | **對每個檔案**從它所在目錄往上找，所以 monorepo 可以每個子目錄各放一份。用 `--config` 指定時不再搜尋 |
| 用 CLI 單獨執行 | `npx eslint . [--fix]` |
| complexity | 規則 `complexity`，**預設 max = 20**。`variant` 可選 `classic`（預設）或 `modified`（整個 switch 只算 1） |
| VS Code 擴充套件 | `dbaeumer.vscode-eslint`（Microsoft）。**使用 workspace 裡安裝的 eslint**，找不到才用全域的，所以版本和專案一致。`eslint.useFlatConfig` 在 v9 預設 true，v10 起忽略（一律 flat）。`eslint.workingDirectories` 決定設定檔從哪個目錄解析。存檔修正用 `editor.codeActionsOnSave: {"source.fixAll.eslint": ...}` |
| 型別相關 lint | typescript-eslint 的 type-aware 規則〔未驗證〕 |

### format：Prettier

| 項目 | 事實 |
|---|---|
| 設定檔 | `package.json` 的 `"prettier"` 欄位、`.prettierrc`（JSON 或 YAML）、`.prettierrc.{json,yml,yaml,json5,js,ts,mjs,mts,cjs,cts,toml}`、`prettier.config.{js,ts,mjs,mts,cjs,cts}`，另外會讀 `.editorconfig` |
| 預設值 | `printWidth` 80、`endOfLine` `"lf"`〔options 頁未逐字驗證〕 |
| 用 CLI 執行 | `npx prettier --check .`、`npx prettier --write .` |
| VS Code 擴充套件 | `esbenp.prettier-vscode`：優先用專案裡的 prettier，並讀專案設定檔〔未驗證〕 |
| Windows 注意 | 預設 `endOfLine: lf`，如果同時開了 git `core.autocrlf=true`，checkout 出來是 CRLF，Prettier 會判定**全部檔案都不合格**。需用 `.gitattributes` 統一換行，或調整 endOfLine〔推論〕 |

### lint 與 format 合一的選項：Biome

| 項目 | 事實 |
|---|---|
| 設定檔 | `biome.json` 或 `biome.jsonc`。monorepo 的子設定寫 `"root": false`，或用 `"extends": "//"` 繼承根目錄的設定 |
| 格式化預設值 | `indentStyle` 是 **tab**（和 Prettier 預設的空白不同）、`indentWidth` 2、`lineWidth` 80、`lineEnding` `lf` |
| complexity | `complexity/noExcessiveCognitiveComplexity` 預設 `maxAllowedComplexity` = **15**，但這條規則**預設不啟用**，要自己開 |
| 用 CLI 執行 | `npx biome check [--write]`、`biome ci`〔未驗證〕 |
| VS Code 擴充套件 | `biomejs.biome`（官方）。`biome.configurationPath` 可指定設定檔（只適用 v2）。`biome.lsp.bin` 可指定執行檔。存檔修正用 `source.fixAll.biome`、`source.organizeImports.biome` |

### 型別檢查：tsc

`tsconfig.json`；用 CLI 執行 `npx tsc --noEmit`（專案有多個子專案時用 `-b`）。VS Code 內建的 TS 支援讀同一份 `tsconfig.json`，可設定成使用 workspace 安裝的 TypeScript 版本（`typescript.tsdk`）〔未驗證〕。

### test coverage

| 工具 | 設定方式 |
|---|---|
| Vitest | 寫在 `vitest.config.*` 的 `coverage` 段落。provider 預設 `v8`。`coverage.enabled` 預設 false。`coverage.thresholds` 可設 `lines`、`functions`、`branches`、`statements`：正數代表最低百分比，負數代表最多允許幾個未覆蓋項目。其他選項：`perFile`、`autoUpdate`、`100`（四項全設 100）、依 glob 設定個別門檻。watermarks 預設 `[50, 80]`，只影響報告上色 |
| Jest | 設定檔是 `jest.config.{js,ts,mjs,mts,cjs,cts,json}` 或 `package.json` 的 `"jest"` 欄位。`coverageThreshold` 預設 undefined（不檢查），格式是 `{global: {branches, functions, lines, statements}, "<glob>": {...}}`，沒達到門檻時 Jest 回報失敗。`coverageProvider` 預設 `babel` |

### dependency

| 項目 | 事實 |
|---|---|
| lockfile | `package-lock.json`、`pnpm-lock.yaml`、`yarn.lock`。`npm ci` 會嚴格依照 lockfile 安裝〔未驗證〕 |
| npm audit | 預設需要 lockfile。`--audit-level` 可設 `info`、`low`、`moderate`、`high`、`critical`、`none`，預設 null，也就是**只要有任何弱點就 exit 非 0**。`--omit dev` 可排除開發用依賴。`npm audit fix` 背後會跑 `npm install`。`npm audit signatures` 驗證套件簽章 |
| pnpm / yarn | `pnpm audit`、`yarn npm audit`〔未驗證〕 |
| 禁用清單 | ESLint `no-restricted-imports`〔未驗證〕；限制 dependency 版本可用 npm `overrides`、pnpm `overrides`〔未驗證〕 |

---

## Java

Java 的特點：lint、format、coverage、弱點掃描大多以 **Maven 或 Gradle plugin** 的形式掛在 build 上，CLI 入口是 `mvn` / `gradle` 指令。

### coding standard：Checkstyle

| 項目 | 事實 |
|---|---|
| 設定檔 | XML 格式，常見做法是直接用內建的 `google_checks.xml` 或 `sun_checks.xml`〔未驗證〕 |
| complexity | `CyclomaticComplexity` 預設 **max = 10**，`switchBlockAsSingleDecisionPoint` 預設 false |
| 用 CLI 執行 | `java -jar checkstyle-all.jar -c config.xml src`，或 `mvn checkstyle:check`、Gradle 的 `checkstyle` plugin〔未驗證〕 |
| VS Code 擴充套件 | `shengchen.vscode-checkstyle`（個人維護，原始碼在 jdneo/vscode-checkstyle，**不是 Microsoft 官方**）。要在 `java.checkstyle.configuration` 指定設定檔路徑或 URL（預設空字串），可用 `${workspaceFolder}`，也可選內建的 Google / Sun 設定。`java.checkstyle.version` **預設 9.3**，需要手動改成和 Maven plugin 相同的版本。頁面**沒有提到**會讀 Maven 或 Gradle plugin 的設定，所以設定檔路徑與版本都要在 settings 另外指定，是一致性檢查的重點 |

### PMD

| 項目 | 事實 |
|---|---|
| complexity 預設值 | `CyclomaticComplexity`：methodReportLevel **10**、classReportLevel 80；`CognitiveComplexity`：reportLevel **15**；`NPathComplexity`：200 |
| 設定檔 | XML ruleset |
| 用 CLI 執行 | `pmd check -d src -R ruleset.xml`、`mvn pmd:check`〔未驗證〕 |
| VS Code | 沒有官方擴充套件〔未驗證〕 |

### format：Spotless

| 項目 | 事實 |
|---|---|
| 形式 | Maven 或 Gradle plugin，設定寫在 `pom.xml` 或 `build.gradle` |
| 指令 | `spotless:check` 預設綁在 `verify` phase；`spotless:apply` 用來修正。另有 `spotless:install-git-pre-push-hook` |
| 可用的 formatter | google-java-format（GOOGLE 或 AOSP 風格）、palantir-java-format、Eclipse JDT、prettier-plugin-java，以及其他幾種 |
| 只檢查變更檔 | `ratchetFrom`（例如 `origin/main`）只檢查目前分支改過的檔案 |
| 換行 | `lineEndings` 預設 `GIT_ATTRIBUTES_FAST_ALLSAME`，依 `.gitattributes` 決定。官方強烈建議不要改，對 Windows 很重要 |
| 執行需求 | JRE 17 以上、Maven 3.1.0 以上 |
| VS Code | **沒有對應的擴充套件**。`redhat.java` 的格式化使用 Eclipse formatter 設定（`java.format.settings.url`）〔未驗證〕，所以 IDE 格式化結果和 google-java-format 不會自動一致 |

### test coverage：JaCoCo

`jacoco:check` 預設綁在 `verify` phase，`haltOnFailure` 預設 true，必須寫 `<rules>`。每條 rule 由以下幾項組成：
- 檢查單位 `element`：BUNDLE（預設）、PACKAGE、CLASS、SOURCEFILE、METHOD
- 計數方式 `counter`：INSTRUCTION（預設）、LINE、BRANCH、COMPLEXITY、METHOD、CLASS
- 數值 `value`：COVEREDRATIO（預設）等
- 上下限：`minimum` 或 `maximum`，可寫 0.80 或 `80%`

官方範例用 BUNDLE、INSTRUCTION、COVEREDRATIO、minimum 0.80。

### dependency

| 項目 | 事實 |
|---|---|
| 版本鎖定 | Maven 沒有原生 lockfile，靠 pom 寫死版本，再用 Enforcer 檢查。Gradle 有 dependency locking（`gradle.lockfile`）與 dependency verification〔皆未驗證〕 |
| 弱點掃描：OWASP Dependency-Check | 有 CLI、Maven（需 3.8.1 以上）、Gradle、Ant、Jenkins 版本。**`failBuildOnCVSS` 預設 11，等於永遠不會讓 build 失敗**，必須自己設門檻（常見 7）。使用 NVD API，強烈建議設 `nvdApiKey`，並放在 Maven `settings.xml` 的 server 設定裡，避免金鑰外洩。誤報用 XML suppression 檔處理。輸出格式有 HTML、JSON、SARIF、JUNIT 等。第一次執行要下載 NVD 資料，很慢〔未驗證〕 |
| 禁用清單 | Maven Enforcer 的 `bannedDependencies`；Checkstyle `IllegalImport`〔皆未驗證〕 |
| 型別檢查 | 由 `javac` 負責，不需要額外工具 |

### VS Code 其他擴充套件

`vscjava.vscode-java-pack`（Microsoft 的 Extension Pack，內含 `redhat.java`）、SonarLint（現名 SonarQube for IDE）〔未驗證〕。

---

## 給後續票的觀察

這些是事實層面的整理，不是決定：

1. **「讀同一份設定檔」**：Python 與 TypeScript 大致成立；Go 的 lint 部分成立；Java 只部分成立，Checkstyle 擴充套件要另外指定路徑與版本，Spotless 在 IDE 沒有對應。
2. **擴充套件內附工具版本的一致性風險**：Ruff 內附 0.17.1、mypy 內附 1.15.0、Checkstyle 預設 9.3、Pylance 自帶 pyright。ESLint 擴充套件則直接用專案的 node_modules。
3. **coverage 門檻**：Go 沒有原生機制。Python、TypeScript、Java 都有，但預設值全是「不檢查」。
4. **弱點掃描的 exit code 行為不一致**：pip-audit 無法關閉失敗；govulncheck 輸出 JSON 時一律回 0；npm audit 預設有任何弱點就失敗；Dependency-Check 預設永遠不失敗。govulncheck 不支援忽略指定弱點。
5. **Windows 換行**：Prettier 和 Biome 預設 `lf`，Spotless 依 `.gitattributes` 決定。`.gitattributes` 可能需要列為共同的修正項目。

---

## 來源

- Ruff 設定總覽：https://docs.astral.sh/ruff/settings/
- Ruff 設定檔探索規則：https://docs.astral.sh/ruff/configuration/
- Ruff VS Code 擴充套件：https://marketplace.visualstudio.com/items?itemName=charliermarsh.ruff
- mypy 設定檔：https://mypy.readthedocs.io/en/stable/config_file.html
- mypy VS Code 擴充套件：https://marketplace.visualstudio.com/items?itemName=ms-python.mypy-type-checker
- pyright 設定：https://github.com/microsoft/pyright/blob/main/docs/configuration.md
- coverage.py 設定：https://coverage.readthedocs.io/en/latest/config.html
- pip-audit：https://pypi.org/project/pip-audit/
- golangci-lint 設定檔：https://golangci-lint.run/docs/configuration/file/
- golangci-lint linter 設定：https://golangci-lint.run/docs/linters/configuration/
- golangci-lint formatters：https://golangci-lint.run/docs/formatters/
- vscode-go settings：https://github.com/golang/vscode-go/wiki/settings
- vscode-go tools：https://github.com/golang/vscode-go/wiki/tools
- Go Modules 參考：https://go.dev/ref/mod
- govulncheck：https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck
- ESLint 設定檔：https://eslint.org/docs/latest/use/configure/configuration-files
- ESLint complexity 規則：https://eslint.org/docs/latest/rules/complexity
- ESLint VS Code 擴充套件：https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint
- Prettier 設定：https://prettier.io/docs/configuration
- Biome 設定：https://biomejs.dev/reference/configuration/
- Biome 認知複雜度規則：https://biomejs.dev/linter/rules/no-excessive-cognitive-complexity/
- Biome VS Code 擴充套件：https://biomejs.dev/reference/vscode/
- Vitest coverage：https://vitest.dev/config/coverage
- Jest 設定：https://jestjs.io/docs/configuration
- npm audit：https://docs.npmjs.com/cli/v11/commands/npm-audit
- Checkstyle CyclomaticComplexity：https://checkstyle.org/checks/metrics/cyclomaticcomplexity.html
- Checkstyle VS Code 擴充套件：https://marketplace.visualstudio.com/items?itemName=shengchen.vscode-checkstyle
- PMD Java design 規則：https://pmd.github.io/pmd/pmd_rules_java_design.html
- Spotless Maven plugin：https://github.com/diffplug/spotless/tree/main/plugin-maven
- JaCoCo check：https://www.eclemma.org/jacoco/trunk/doc/check-mojo.html
- OWASP Dependency-Check：https://dependency-check.github.io/DependencyCheck/
- Dependency-Check Maven 設定：https://dependency-check.github.io/DependencyCheck/dependency-check-maven/configuration.html
