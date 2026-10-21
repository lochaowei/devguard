# 查證：工具鏈事實（SPEC §13 第 6、9 項）

查證日期：2026-10-22。範圍：SPEC.md §5.4、§6、§7.2、§7.4 依賴的事實，以及 [03-language-toolchains.md](03-language-toolchains.md) 中標記〔未驗證〕的項目。每一項都對照官方文件、原始碼或官方發佈資產。

圖例：✅ 正確／⚠ 大致正確，但有 SPEC 必須處理的細節或變動／❌ 錯誤

## 1. 事實查核表

### Python

| 事實 | 判定 | 正確值／說明 | 來源 |
|---|---|---|---|
| Ruff 預設啟用 `E4, E7, E9, F` | ⚠ | **Ruff 0.16.0（2026-07-23）起已變更**：預設規則從 59 條擴增為 413 條，涵蓋 E/W/F/I/B/UP/SIM/N/S/RUF/PL/TRY… 等群組的子集；`E4, E7, E9, F` 是 0.15.x 以前的預設。0.17.0（2026-10-09）又調整了預設集。目前最新版是 0.17.1（2026-10-15）。SPEC 以明確的 `select` 指定規則，`select` 會成為規則集的基礎並**取代**預設，所以不受影響；前提是 CLI 必須寫 `select`，**不能寫 `extend-select`**。 | https://docs.astral.sh/ruff/default-rules/ 、https://github.com/astral-sh/ruff/releases （0.16.0、0.17.0）、https://docs.astral.sh/ruff/linter/#rule-selection |
| C901 預設不啟用 | ✅ | 舊預設與 0.16+ 的新預設都不含 C90／C901，必須自行 `select` `C90`。 | https://docs.astral.sh/ruff/default-rules/ |
| `lint.mccabe.max-complexity` 預設 10 | ✅ | 預設 `10`，觸發 `C901`。 | https://docs.astral.sh/ruff/settings/#lint_mccabe_max-complexity |
| `line-length` 預設 88 | ✅ | 88。SPEC 明確設為 120。 | https://docs.astral.sh/ruff/settings/#line-length |
| SPEC 使用的規則群組代碼存在（E, W, F, I, B, UP, C90, SIM, N, S, TID） | ✅ | pycodestyle E/W、Pyflakes F、isort I、flake8-bugbear B、pyupgrade UP、mccabe C90、flake8-simplify SIM、pep8-naming N、flake8-bandit S、flake8-tidy-imports TID，全部存在。S101 = `assert`。 | https://docs.astral.sh/ruff/rules/ |
| TID251 banned-api 與設定語法 | ✅ | TID251 = `banned-api`。語法：`[tool.ruff.lint.flake8-tidy-imports.banned-api]` 下寫 `"cgi".msg = "..."`，可以是模組或模組成員。 | https://docs.astral.sh/ruff/settings/#lint_flake8-tidy-imports_banned-api 、https://docs.astral.sh/ruff/rules/banned-api/ |
| `per-file-ignores` 語法 | ✅ | `[tool.ruff.lint.per-file-ignores]`，例如 `"tests/**" = ["S101"]`；檔案模式可用 `!` 排除。 | https://docs.astral.sh/ruff/settings/#lint_per-file-ignores |
| Ruff 有 Windows 二進位檔 | ✅ | GitHub release 0.17.1 提供 `ruff-x86_64-pc-windows-msvc.zip`、`i686`、`aarch64`；另有 PowerShell 安裝程式（0.5.0 起）與 PyPI wheel。 | https://github.com/astral-sh/ruff/releases/latest 、https://docs.astral.sh/ruff/installation/ |
| `pytest --cov-fail-under=MIN` | ✅ | 說明文字："Fail if the total coverage is less than MIN."。另外，沒給此參數時，pytest-cov 會讀 coverage 設定中的 `[report] fail_under`（見 plugin.py 第 293–294 行），所以 SPEC 只寫 `[tool.coverage.report] fail_under` 就有效。 | https://pytest-cov.readthedocs.io/en/latest/config.html 、https://github.com/pytest-dev/pytest-cov/blob/master/src/pytest_cov/plugin.py |
| coverage.py `branch` 與 `fail_under` 的計算方式 | ⚠ | `[run] branch` 預設 False。`fail_under` 比對的是 **total**；開啟 branch 後，total = (執行到的敘述 + 走過的分支目的地) / (敘述數 + 分支目的地數)，也就是**行與分支合併計算的單一數字**，不是純行覆蓋率。因此 SPEC 的 `coverage.lines: 80` 在 Python 中的實際意義是「行＋分支合併 80%」，和 TS（lines、branches 分開）及 Java（LINE、BRANCH 各 0.80）不同。 | https://coverage.readthedocs.io/en/latest/config.html 、https://coverage.readthedocs.io/en/latest/branch.html |
| coverage 讀 `pyproject.toml [tool.coverage.*]` | ✅ | 設定必須放在 `[tool.coverage]` 底下，例如 `[tool.coverage.run]`；只在沒有 `.coveragerc` 時才會讀 pyproject.toml。 | https://coverage.readthedocs.io/en/latest/config.html |
| uv lockfile 為 `uv.lock`，應提交 | ✅ | 檔案在 `pyproject.toml` 旁邊。"This file should be checked into version control"。 | https://docs.astral.sh/uv/concepts/projects/layout/ |
| `uv export` 的格式可給 pip-audit 使用 | ✅（附條件） | `--format` 可選 `requirements.txt`（預設）、`pylock.toml`、`cyclonedx1.5`（preview）；預設**帶 hash**。預設會把專案本身也輸出，掃描前應加 `--no-emit-project`，並加 `--frozen`。pip-audit 可用 `-r <file>` 讀 requirements 檔；檔案帶 hash 時可加 `--disable-pip`。pip-audit **不直接讀 `uv.lock`**；它的 `--locked` 只支援 `pylock.*.toml`。建議指令：`uv export --frozen --no-emit-project --format requirements.txt -o <tmp>` 後執行 `pip-audit -r <tmp> --disable-pip`。 | https://docs.astral.sh/uv/concepts/projects/export/ 、https://docs.astral.sh/uv/reference/cli/#uv-export 、https://github.com/pypa/pip-audit |
| `poetry.lock` | ✅ | 應用程式開發者應提交 `poetry.lock`。 | https://python-poetry.org/docs/basic-usage/ |

### Go

| 事實 | 判定 | 正確值／說明 | 來源 |
|---|---|---|---|
| vscode-go `go.lintTool: golangci-lint-v2` | ✅ | enum 為 `staticcheck, golint, golangci-lint, golangci-lint-v2, revive`；`go.lintOnSave` 可為 `file/package/workspace/off`，預設 `package`。 | https://github.com/golang/vscode-go/blob/master/extension/package.json |
| gopls `formatting.gofumpt` | ✅ | 布林值，預設 false。 | 同上（`gopls` 的 properties） |
| golangci-lint v2 設定檔 `version: "2"` | ✅ | "The only possible value is "2""；`linters.default` 預設為 `standard`。 | https://github.com/golangci/golangci-lint/blob/main/.golangci.reference.yml |
| formatters 包含 gofumpt 與 goimports | ✅ | `formatters.enable: [gofumpt, goimports]`；設定放在 `formatters.settings.gofumpt`（`module-path`、`extra.*`）與 `formatters.settings.goimports.local-prefixes`。 | 同上 |
| depguard 必須寫明確規則 | ✅ | 依官方說明，沒有自訂規則時預設 "Only allow $gostd in all files"，因此必須寫規則。語法：`linters.settings.depguard.rules.<name>.{list-mode, files, allow, deny: [{pkg, desc}]}`。禁止 `io/ioutil` 應寫 `deny: - pkg: "io/ioutil"`。 | 同上 |
| gomodguard_v2 存在與設定鍵 | ⚠ | 存在，但 **v2.12.0 才加入**；舊的 `gomodguard` 從 v2.12.0 起棄用，替代品是 `gomodguard_v2`。設定：`linters.settings.gomodguard_v2.blocked: [{module, match-type, version, recommendations, reason}]`、`allowed: [...]`、`local-replace-directives`。golangci-lint 的版本範圍必須 ≥ 2.12。最新版是 v2.15.0（2026-10-16）。 | 同上；https://github.com/golangci/golangci-lint/blob/main/pkg/lint/lintersdb/builder_linter.go |
| cyclop／gocognit 門檻 | ⚠ | `cyclop.max-complexity` 預設 10 ✅。`gocognit.min-complexity` **預設 30**，必須明確設為 15。 | 同上 |
| golangci-lint 有 Windows 二進位檔 | ✅ | v2.15.0 提供 `windows-amd64`、`windows-386`、`windows-arm64` 的 zip 檔。 | https://github.com/golangci/golangci-lint/releases/latest |
| `go mod tidy -diff` | ✅ | **Go 1.23** 加入。不修改檔案，改為印出 unified diff；需要更新時以非 0 結束。SPEC 的 `go.minVersion` 為 1.26，足夠。 | https://go.dev/doc/go1.23 、https://go.dev/ref/mod#go-mod-tidy |
| `go.mod` 的 `tool` directive 與 `go tool` | ✅ | **Go 1.24** 加入，用 `go get -tool` 新增，`go tool <name>` 執行，結果會快取在 build cache。 | https://go.dev/doc/go1.24 |

### TypeScript

| 事實 | 判定 | 正確值／說明 | 來源 |
|---|---|---|---|
| ESLint `no-restricted-imports` | ✅ | 核心規則，可用字串或 `paths`/`patterns` 物件選項；只檢查靜態 import。 | https://eslint.org/docs/latest/rules/no-restricted-imports |
| typescript-eslint flat config 名稱 `strictTypeChecked` | ✅ | flat config 寫 `tseslint.configs.strictTypeChecked`（legacy 為 `plugin:@typescript-eslint/strict-type-checked`）。它包含 recommended、recommended-type-checked、strict，需要 typed linting 設定。 | https://typescript-eslint.io/users/configs#strict-type-checked |
| `eslint-plugin-sonarjs` 的 `cognitive-complexity` | ⚠ | 規則名稱 `sonarjs/cognitive-complexity`（S3776）正確，預設門檻 15。但 **授權為 LGPL-3.0-only**（最新版 4.2.2），導入前應交法務／IT 確認；peer 依賴支援 eslint 8–10。 | https://github.com/SonarSource/SonarJS （README）、https://registry.npmjs.org/eslint-plugin-sonarjs/latest |
| Biome `noExcessiveCognitiveComplexity` | ✅ | 存在，`maxAllowedComplexity` 預設 15。 | https://biomejs.dev/linter/rules/no-excessive-cognitive-complexity/ |
| Prettier 預設 `printWidth 80`、`endOfLine lf` | ✅ | printWidth 預設 `80`（SPEC 明確設為 120）；endOfLine 自 v2.0.0 起預設 `lf`。 | https://prettier.io/docs/options |
| VS Code `typescript.tsdk` | ⚠ | **已棄用**（VS Code 原始碼 2026-05 起）："This setting is deprecated. Use `js/ts.tsdk.path` instead."。新設定名稱：`js/ts.tsdk.path`（值 `./node_modules/typescript/lib`），提示切換的設定為 `js/ts.tsdk.promptToUseWorkspaceVersion`（取代 `typescript.enablePromptUseWorkspaceTsdk`）。另外，寫在 workspace 設定中時，**不會自動切換**到 workspace 版本，仍需由使用者選擇，或透過 prompt 設定提示。 | https://github.com/microsoft/vscode/blob/main/extensions/typescript-language-features/package.json 、package.nls.json；https://code.visualstudio.com/docs/typescript/typescript-compiling |
| Vitest `coverage.thresholds` | ✅ | `coverage.thresholds.{lines,branches,functions,statements}`；設為正數時是最低百分比。 | https://vitest.dev/config/coverage#coverage-thresholds |
| Jest `coverageThreshold.global` | ✅ | `coverageThreshold` 預設 `undefined`，鍵為 `global`。 | https://jestjs.io/docs/configuration#coveragethreshold-object |

### Java

| 事實 | 判定 | 正確值／說明 | 來源 |
|---|---|---|---|
| Checkstyle 內建 `google_checks.xml` | ✅（附條件） | maven-checkstyle-plugin 說明："There are 2 predefined rulesets. sun_checks.xml … google_checks.xml"（預設為 sun_checks.xml），以 classpath resource 方式提供。`google_checks.xml` **不含** `IllegalImport` 與 `CyclomaticComplexity`，而且包含 2 空白 `Indentation`、`LineLength`(100) 等格式規則，和 palantir 衝突。CLI 產生的設定必須移除格式類規則，並加入上述兩條規則。 | https://maven.apache.org/plugins/maven-checkstyle-plugin/check-mojo.html#configLocation 、https://github.com/checkstyle/checkstyle/blob/master/src/main/resources/google_checks.xml |
| `IllegalImport` 預設禁止的套件 | ✅ | `illegalPkgs` 預設 `sun`，以前綴比對，所以 `sun.*` 都會被禁止。 | https://checkstyle.org/checks/imports/illegalimport.html |
| Checkstyle `CyclomaticComplexity` 預設 | ✅ | `max` 預設 10。 | https://checkstyle.org/checks/metrics/cyclomaticcomplexity.html |
| PMD quickstart ruleset 路徑 | ✅（附條件） | `rulesets/java/quickstart.xml`。其中 `CognitiveComplexity`、`CyclomaticComplexity`、`NPathComplexity` **都被註解掉**，必須在 CLI 產生的 ruleset 額外加入 `category/java/design.xml/CognitiveComplexity`（`reportLevel` 預設 15）。 | https://pmd.github.io/pmd/pmd_rules_java.html 、https://github.com/pmd/pmd/blob/main/pmd-java/src/main/resources/rulesets/java/quickstart.xml 、https://pmd.github.io/pmd/pmd_rules_java_design.html#cognitivecomplexity |
| Maven Enforcer `bannedDependencies` | ✅ | 內建規則 "enforces that excluded dependencies aren't included"（`<excludes><exclude>log4j:log4j</exclude>`）。 | https://maven.apache.org/enforcer/enforcer-rules/index.html |
| `requireReleaseDeps` | ✅ | "enforces that no snapshots are included as dependencies"。 | 同上 |
| `dependencyConvergence` | ✅ | "ensure all dependencies converge to the same version"。 | 同上 |
| 禁止版本範圍的規則名稱 | ⚠ | 沒有只禁止版本範圍的規則。應使用 **`banDynamicVersions`**：一次禁止版本範圍（以 `[`／`(` 開頭）、`LATEST`／`RELEASE` 與 `-SNAPSHOT`（可用 `allowSnapshots` 等參數放寬）。用它可取代 `requireReleaseDeps`。Enforcer 目前版本 3.6.3。 | https://maven.apache.org/enforcer/enforcer-rules/banDynamicVersions.html |
| Gradle dependency locking `gradle.lockfile` | ✅ | 每個 project／subproject 根目錄一份 `gradle.lockfile`（buildscript 為 `buildscript-gradle.lockfile`），"Lockfiles should be checked in to source control"。 | https://docs.gradle.org/current/userguide/dependency_locking.html |
| Spotless palantirJavaFormat（Maven） | ✅ | `<java><palantirJavaFormat><version/><style>PALANTIR</style><formatJavadoc/></palantirJavaFormat></java>`。 | https://github.com/diffplug/spotless/blob/main/plugin-maven/README.md |
| Spotless palantirJavaFormat（Gradle） | ✅ | `spotless { java { palantirJavaFormat('<ver>') } }`，可接 `.style("GOOGLE")`、`.formatJavadoc(true)`。 | https://github.com/diffplug/spotless/blob/main/plugin-gradle/README.md |
| palantir-java-format 為 4 空白、120 欄 | ✅ | "A modern, lambda-friendly, 120 character Java formatter"，風格固定，沒有可調參數。 | https://github.com/palantir/palantir-java-format |
| JaCoCo check rule 語法 | ✅ | Maven：`<rule><element>BUNDLE</element><limits><limit><counter>LINE</counter><value>COVEREDRATIO</value><minimum>0.80</minimum></limit>…`，BRANCH 同樣寫法。Gradle：`jacocoTestCoverageVerification { violationRules { rule { limit { counter = "LINE"; minimum = 0.80 } } } }`。 | https://www.jacoco.org/jacoco/trunk/doc/check-mojo.html 、https://docs.gradle.org/current/userguide/jacoco_plugin.html |
| `lombok.addLombokGeneratedAnnotation = true` | ✅ | 這是 `lombok.config` 的設定鍵，**不是** pom／Gradle 設定。啟用後，Lombok 產生的節點加上 `@lombok.Generated`；JaCoCo 0.8.0 起會自動排除帶有此標註的方法。 | https://projectlombok.org/features/configuration 、https://www.jacoco.org/jacoco/trunk/doc/changes.html |

**合計查核 46 項**：✅ 37 項（含 4 項附條件）、⚠ 9 項、❌ 0 項。

## 2. 第 9 項分析：部分 staged 檔案只檢查工作目錄版本的影響

**問題**：開發者執行 `git add -p` 之後，index（會被 commit 的內容）和工作目錄不同。SPEC 檢查的是工作目錄版本。

### 各類工具可能出現的誤判

| 工具類別 | 誤判通過（壞內容被 commit） | 誤判失敗（好內容被擋） |
|---|---|---|
| 格式檢查（ruff format、prettier、gofumpt、spotless） | **常見**：先 stage 未格式化的版本，再在工作目錄執行格式化但不 stage，檢查會通過，未格式化的內容被 commit。 | 工作目錄中有未 stage、尚未格式化的修改時，會擋下其實乾淨的 commit。 |
| 單檔 linter（ruff check、eslint、Checkstyle、PMD） | 已 stage 的內容有錯，但工作目錄已修好（未 stage）。 | 工作目錄中未 stage 的修改有錯（例如寫到一半的程式碼）。 |
| 跨檔分析（型別檢查 mypy／pyright／tsc、golangci-lint、Java 編譯） | 本來就有：這類工具看的是整個元件，其他**未 stage** 的檔案（甚至未追蹤的檔案）也會影響結果。例如 A.py 的 staged 版本呼叫了 B.py 中只存在於工作目錄的函式，檢查會通過，但 commit 後的內容其實是壞的。 | 未 stage 的檔案有型別錯誤，擋下與它無關的 commit。 |

### 能否改為檢查 staged blob（`git show :<path>` 透過 stdin 傳給工具）

| 生態系 | 支援 stdin 加虛擬路徑（設定檔仍依路徑解析） | 不支援 |
|---|---|---|
| Python | `ruff check --stdin-filename <path> -`、`ruff format --check --stdin-filename <path> -` | mypy（只有 `-c PROGRAM_TEXT`，沒有模組路徑脈絡）、pyright |
| TypeScript | `eslint --stdin --stdin-filename <path>`（型別相關規則仍會從磁碟讀其他檔案）、`prettier --stdin-filepath <path>`、`biome check --stdin-file-path=<path>` | tsc |
| Go | `gofmt`／`gofumpt`（沒給路徑時讀 stdin） | golangci-lint（以 package 為單位，沒有 stdin 模式）、`go vet` |
| Java | palantir-java-format CLI 可讀 `-`，但 SPEC 透過 Spotless 執行，Spotless 沒有 stdin 模式 | Checkstyle、PMD（透過 Maven／Gradle） |

### 建議：保留 SPEC 現行做法，再加兩項小幅調整

1. **保留**「檢查工作目錄版本並印出警告、不 stash」：跨檔工具（型別檢查、golangci-lint、Java 全部）無論如何都只能看磁碟上的內容。若只為了部分工具改用 index，必須把 index 匯出到暫存目錄（例如 `git checkout-index --prefix=<tmp>/`），但專案的 `.venv`、`node_modules`、`go.mod` 等脈絡無法完整重建，成本高且容易出錯。
2. **選擇性調整（建議採用）**：只對**格式檢查**，以及 Ruff／ESLint／Prettier／Biome／gofumpt 的**單檔 lint**，在檔案部分 staged 時改用 stdin 傳入 staged blob 檢查。這樣可以消除最常見的誤判通過，也就是「工作目錄已格式化，但 staged 版本未格式化」。實作方式只是 `git show :<path> | <tool> --stdin-…`，不需要修改任何檔案。Java（Spotless）與型別檢查維持現狀。
3. 警告文字應明確寫出：「型別檢查與 Java 檢查是以工作目錄為準，未 staged 的修改可能影響結果」。

## 3. SPEC.md 應修正的內容（逐條）

1. **§5.1 版本範圍範例**：`ruff >=0.15,<0.16` 是舊版本，Ruff 0.16 起預設規則大幅改變，目前最新版是 0.17.1。建議改為 `ruff >=0.17,<0.18`，或改用不綁特定版本的寫法。另外在 §6.1 `lint.rules` 的落地方式補充：「CLI 一律寫 `lint.select`（不使用 `extend-select`），以免受 Ruff 預設規則集變動影響」。
2. **§6.1 `coverage.lines`**：註明「Python 開啟 `branch = true` 時，`fail_under` 比對的是行與分支**合併**的 total」，或在 §5.1 說明 `coverage.lines` 在各語言的實際意義不同。落地方式可補上「pytest-cov 會讀 `fail_under`，不需要 `--cov-fail-under`」。
3. **§6.1 進階 `deps.vulnFailOn`**：落地方式改為 `uv export --frozen --no-emit-project --format requirements.txt -o <tmp>`，再執行 `pip-audit -r <tmp> --disable-pip`。
4. **§6.2 `lint.rules`**：在 `gomodguard_v2` 後註明「需要 golangci-lint ≥ 2.12.0（舊的 `gomodguard` 已棄用）」。
5. **§6.2 `complexity.cyclomatic` / `cognitive`**：落地方式寫明 `cyclop.max-complexity: 10`、`gocognit.min-complexity: 15`（gocognit 預設為 30，一定要設定）。
6. **§6.3 `complexity`**：在 `eslint-plugin-sonarjs` 後註明「LGPL-3.0-only，導入前確認授權」，並把這一點加入 §12（導入前提）。
7. **§7.2 TypeScript `settings.json`**（以及 §8 一致性檢查中的 `typescript.tsdk`）：改為 `js/ts.tsdk.path` 指向 `node_modules/typescript/lib`，並設定 `js/ts.tsdk.promptToUseWorkspaceVersion: true`。`typescript.tsdk` 已棄用；一致性檢查應同時接受新舊兩個鍵，以相容舊版 VS Code。
8. **§6.4 `lint.tool` / `lint.rules`**：補充「以 `google_checks.xml` 為基礎移除格式類規則後，**加入** `IllegalImport` 與 `CyclomaticComplexity`（max 10）；PMD quickstart（`rulesets/java/quickstart.xml`）**加入** `category/java/design.xml/CognitiveComplexity`（reportLevel 15）」。
9. **§6.4 `complexity.cyclomatic` / `cognitive`**：把「Checkstyle / PMD」改為「Checkstyle `CyclomaticComplexity` / PMD `CognitiveComplexity`」。
10. **§6.4 `deps.lockfile`**：把「Enforcer 禁止 SNAPSHOT 與版本範圍」寫明為 Enforcer 規則 `banDynamicVersions`（同時禁止版本範圍、`LATEST`／`RELEASE` 與 SNAPSHOT）、`dependencyConvergence`，以及禁用清單用的 `bannedDependencies`。
11. **§6.4 `coverage.lines`**：把 `lombok.addLombokGeneratedAnnotation = true` 註明為「寫在 `lombok.config`」。
12. **§7.4 部分 staged 的檔案**：依第 2 節的建議，補充「格式檢查與支援 stdin 的單檔 lint（Ruff、ESLint、Prettier、Biome、gofumpt）改為檢查 staged blob；型別檢查、golangci-lint 與 Java 檢查以工作目錄為準，並在警告中說明」。
13. **§13 第 6、9 項**：標記為已查證，並連到本文件。
