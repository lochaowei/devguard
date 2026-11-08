# 實際專案測試 Round 3 報告

> [!NOTE]
> 本報告記錄 #82（實際專案測試 Round 3：每種語言各五個 GitHub 專案）的測試範圍、20 個公開專案的全流程結果，以及實測開出的 47 個 issue（#83–#129）。修正不在本輪範圍，各 issue 另外處理。

- **受測版本**：devguard 0.3.1，由 `main` @ `9a3c031`（含 #64 移除鏡像、#80 Linux／macOS 支援）以 `npm run build:exe` 產生的 Windows x64 exe
- **環境**：Windows 11、Git for Windows（系統層 `core.autocrlf=true`、`core.symlinks=false`）、Node 24.21、npm 11.19、Bun 1.4.4、uv 0.10.8、Python 3.14.7、Go 1.26.5、Temurin JDK 21.0.13（java-jwt 另用 JDK 11）、Maven 3.9.16
- **測試中安裝的工具**（使用者範圍）：golangci-lint 2.15.0、lefthook 2.2.2、pre-commit 4.6.2、Poetry 2.5.1、pnpm／yarn（corepack shim）、Temurin JDK 11
- **前兩輪**：[Round 1](../real-project-test-report.md)（9 個專案）、[Round 2](round-2-report.md)（18 個專案）。本輪的 20 個專案都不在這 27 個之中。

---

## 1. 方法

前兩輪只走 `draft → check → fix --yes → check`。本輪把 `check --full`、`install`、`doctor` 與兩個 git hook 也放進流程，每個專案依序執行 9 步：

```mermaid
flowchart LR
    A[draft] --> B["check（修正前）"] --> C["fix --yes"] --> D["check（修正後）"] --> E["check --full"]
    E --> F[install] --> G[doctor] --> H["commit → pre-commit"] --> I["push → pre-push"]
```

- 專案 clone 到 devguard repo 之外的目錄；pre-push 只推到本機 bare remote，沒有推到上游，也沒有對上游開 PR。
- `draft` 產生的 TODO 理由先填好再跑 `check`。草稿明顯不適用時（例如 Java 8 專案要改用 `legacy@1.0.0`、誤判的元件），比照使用者審閱草稿的做法手動修改，並在各專案的紀錄中註明。
- pre-push 各跑兩次：預設，以及 `DEVGUARD_PRE_PUSH=full`。
- 專案自己的 hook 失敗或擋路時，用 `SKIP=<hook id>` 觀察 devguard hook 本身的結果，並註明。
- 每個 finding 都和直接執行該工具的結果對照，區分 devguard 的問題與專案或環境本身的問題。只有確認是 devguard 的問題才開 issue；開之前先查重，並對照 `.out-of-scope/`。
- 四種語言由四個 agent 並行測試。

---

## 2. 受測專案總覽

格內記號：`E` 錯誤、`D` 偏離、`H` 提示。各步驟的 exit code 與完整觀察見第 6 節。

| 語言 | 專案 | 結構／工具鏈特徵 | 標準 | 主要結果 |
| :--- | :--- | :--- | :--- | :--- |
| TypeScript | `jquense/yup` | Yarn Berry 4、`.eslintrc` + ESLint 8、Vitest 3 | team@1.3.0 | Berry lockfile 只解析出部分 entry，ESLint 8 超界漏報（#116） |
| TypeScript | `vercel/ms` | Biome 2、Jest 30（ts-jest preset）、pnpm、husky 9 | team@1.3.0 | Biome 的 staged lint 一律失敗，**每個 commit 都被擋**（#120） |
| TypeScript | `typestack/class-validator` | npm、Jest 29、ESLint 8、husky v4 hook | team@1.3.0 | 依 `install` 提示加到 husky v4 hook 結尾，devguard 永遠不會執行，`doctor` 卻判定通過（#126） |
| TypeScript | `remeda/remeda` | npm workspaces monorepo、ESLint 10、Vitest 5 | team@1.3.0 | `install` 以 ENOTDIR 內部錯誤中止，git hook 沒裝（#129）；根元件型別檢查整個 monorepo（#125） |
| TypeScript | `elysiajs/elysia` | Bun（`bun.lock`、`bun test`） | team@1.3.0 | Windows 上找不到 Bun 的 `.exe` shim，**每次 `check` 都 exit 2**（#122） |
| Python | `python-poetry/cleo` | Poetry、mypy strict、pre-commit 框架 | team@1.3.0 | mypy 忽略 `[tool.mypy] files` 的誤報擋下每個 commit（#110）；`fix` 刪掉 17 個註解（#111） |
| Python | `karpathy/minbpe` | 只有 `requirements.txt` | team@1.3.0 | 缺工具提示 `uv sync`，但沒有 pyproject.toml 時會失敗（#112） |
| Python | `dbrattli/Expression` | uv、pyright strict、Ruff dotted key、`docs/` 子元件 | team@1.3.0 | **`fix` 寫出不合法的 pyproject.toml**（#105），子元件改寫根目錄設定（#106） |
| Python | `frankie567/httpx-oauth` | uv、basedpyright（off）＋實際使用 mypy | team@1.3.0 | 型別檢查實際被關閉，明顯的型別錯誤也通過 commit（#114） |
| Python | `Kludex/uvicorn` | uv、`UV_PROJECT_ENVIRONMENT` 指向 repo 外 | team@1.3.0 | #66 的修正有效；coverage `fail_under` 讓全過的測試被報「測試失敗」（#108） |
| Go | `go-testfixtures/testfixtures` | `go.work` 三模組、沒有 golangci 設定 | team@1.3.0 | `fix` 在每個模組各建一份相同的 `.golangci.yml`（#88） |
| Go | `alecthomas/kong` | golangci v1（`enable-all`）、lefthook | team@1.3.0 | `fix` 寫出 v1／v2 混合、無法載入的設定（#86）；lefthook 沒安裝時 commit 不經過 devguard（#93） |
| Go | `carapace-sh/carapace` | `go.work`＋golangci v2、`_test/` 有 `.py` | team@1.3.0 | `draft` 把測試資料當成 Python 元件，整個 Go 專案的 `check` exit 2（#89） |
| Go | `pelletier/go-toml` | `.golangci.toml` | team@1.3.0 | 不認得 `.golangci.toml`，`fix` 新增會被忽略的 `.yml`，**標準的 linter 從沒執行**（#85） |
| Go | `AfterShip/email-verifier` | pre-commit 框架、沒有 `.gitattributes` | team@1.3.0 | CRLF 工作目錄的 27 筆 gofmt 誤報（#84）；專案 hook 在 push 也執行（#95） |
| Java | `pf4j/pf4j` | Maven 多模組＋`mvnw`、release 8 | legacy@1.0.0 | 沒有 JaCoCo 時測試完全不跑，**漏報一個真實的測試錯誤**（#99） |
| Java | `LMAX-Exchange/disruptor` | Gradle Groovy DSL＋`gradlew` | team@1.3.0 | **`fix` 把 193 行的 checkstyle.xml 換成 13 行**（#100） |
| Java | `stleary/JSON-java` | `pom.xml`＋`build.gradle`、只有 `gradlew` | legacy@1.0.0 | 忽略宣告的 `build.tool`，以 Maven 參數執行 gradlew（#96） |
| Java | `auth0/java-jwt` | Gradle 多專案、release 8、JaCoCo | legacy@1.0.0 | Gradle 跑完 707 個測試；子專案的覆蓋率報告讀不到（#101）；`fix` 覆寫 371 行的 checkstyle.xml（#100） |
| Java | `FasterXML/jackson-databind` | Maven＋`mvnw`、parent POM 提供 JaCoCo | team@1.3.0 | Maven 跑完 7,805 個測試，分支覆蓋率 77.4% 被正確擋下 |

**`check --full` 實際執行的情況：**

- TypeScript：5 個都有執行。elysia 因 #122 在找工具時就中止，remeda 的根元件把所有 package 的測試收進來而失敗（#125）。
- Python：5 個都有執行，3 個先因缺 pytest-cov 得到沒有提示的 exit 4（#109），補上後測試都能跑完。
- Go：5 個都有執行，失敗的測試都和直接執行 `go test` 一致（資料庫、Windows symlink 權限、不支援 Windows 的範例）。
- Java：4 個實際呼叫了 Maven 或 Gradle，但**只有 java-jwt 與 jackson-databind 真的跑了測試**。pf4j 與 disruptor 沒有 JaCoCo，在測試前就失敗（#99）；JSON-java 被 #96 擋住。

> [!IMPORTANT]
> #82 的驗收條件「Java 專案至少有 3 個跑完 `check --full`」**只達成 2 個**。另外兩個雖然實際執行了 Maven／Gradle，但因 #99 在測試前就失敗。

---

## 3. 跨語言的問題主題

### 3.1 `fix` 破壞或覆寫專案的設定

最嚴重的一類：`fix --yes` 應該只做結構化、保留註解與排版的修改，實測卻有寫壞檔案或整份覆寫的情況。

- **寫出無法載入的設定**：#105（Ruff dotted key → 不合法 TOML）、#86（golangci v1／v2 混合檔）、#124（在 solution-style tsconfig 加入不生效的 `compilerOptions`）
- **整份覆寫專案自己的設定**：#100（checkstyle.xml 193／371 行 → 13 行，預覽只寫「重新產生」）
- **子元件改寫上層設定**：#106（`docs/` 子元件改寫根目錄的 Ruff／pyright 設定）
- **刪改註解與排版**：#111（Ruff 行尾註解全部刪掉）、#121（tsconfig 行尾註解被移到新行）、#87（YAML flow sequence 加空白、註解對齊被壓縮，也出現在 `install` 編輯 `.pre-commit-config.yaml` 時）

### 3.2 檢查被繞過或假通過

devguard 回報「沒問題」，實際上標準要求的檢查沒有執行。

- **工具沒讀到 devguard 寫的設定**：#85（`.golangci.toml` 優先於新增的 `.golangci.yml`）、#98（Maven 不使用產生的 `checkstyle.xml`；缺 plugin 只得到 tool-failed）
- **hook 沒有真的呼叫 devguard**：#93（lefthook 沒安裝）、#126（husky v4 hook 結尾）、#129（install 中止後 hook 沒裝）
- **型別或測試實際沒有檢查**：#114（basedpyright off）、#124（`tsc --noEmit` 對 solution-style tsconfig 不檢查任何檔案）、#99（沒有 JaCoCo 時測試不跑）
- **版本或設定沒有檢查**：#116（Yarn Berry lockfile）、#103（Gradle 子專案與 dependency 宣告的工具版本）、#118（`node.minVersion` 沒有實作）、#119（Jest `preset` 讓覆蓋率設定檢查被略過）

### 3.3 誤報擋下 commit 或 push

- **每個 commit 都被擋**：#120（Biome staged lint 一律 exit 1）、#110（mypy 忽略 `[tool.mypy] files`）
- **Windows CRLF**：#84。Git for Windows 預設 `core.autocrlf=true`，沒有 eol `.gitattributes` 的 repo 在 Go（gofmt、`go-mod-untidy`）、TypeScript（Prettier、Biome）都出現大量格式誤報；`fix` 加了 `.gitattributes` 卻沒提示要重新 checkout。這是本輪影響最廣的問題，4 個 TypeScript 專案與 2 個 Go 專案的錯誤數都被它灌大。
- **其他**：#108（coverage `fail_under` → 沒有測試 id 的「測試失敗」）、#83（模組快取空時誤報 `go-mod-untidy`）、#94（並行的 golangci-lint）、#95（專案沒寫 `stages` 的 hook 在 push 時也執行）

### 3.4 整個檢查中止（exit 2 或內部錯誤）

- #122（Bun 的 `.exe` shim）、#129（`.claude/skills` 是檔案時 ENOTDIR）、#96（Java build tool 判斷）
- #89：`draft` 把 Go 會忽略的 `_*`／`testdata` 目錄當成元件，一支測試用 `.py` 就讓整個 Go 專案的 `check` 因找不到 ruff 而 exit 2。jackson-databind 根目錄的一支 `.py` 也一樣，而且刪掉 Python 元件仍會 exit 2（未涵蓋檔案依副檔名套用 Python 預設），要加 `ignore` 才行。這是 SPEC §4.1 的設計行為，但使用者的直覺做法沒用，值得在文件中說明。

### 3.5 多元件時重複回報或範圍錯誤

- **同一筆 finding 在多個元件重複**：#92（共用父目錄的 `.golangci.yml`）、#107（pyright 沿用根目錄設定）、#127（父元件的 Prettier 包含子元件檔案）
- **範圍錯誤**：#125（workspace 根目錄被推成元件，型別檢查與 vitest 涵蓋整個 monorepo）、#88（每個 Go 模組各建一份設定）

### 3.6 提示與訊息品質

- **安裝提示不對**：#117（TypeScript 一律 `npm ci`）、#112（沒有 pyproject.toml 時提示 `uv sync`）、#109（缺 pytest-cov 沒有提示）、#91（沒寫 golangci-lint 版本）
- **錯誤訊息看不到原因**：#97（Maven／Gradle 只擷取到樣板行）、#128（ANSI 色碼）、#90（golangci-lint 預設上限截斷結果）
- **其他**：#123（`fix --code` 提示列出沒有 staged、只有 tsc 錯誤的檔案）、#115（`UV_PROJECT_ENVIRONMENT` 時 VS Code 直譯器路徑）、#113（mypy 2.x 被排除在範圍外）、#104（用法說明仍提到已移除的鏡像與弱點掃描）

---

## 4. Issue 索引

本輪新開 47 個 issue，全部標 `needs-triage`，另在 2 個 issue 補充了其他語言的重現。

| 語言 | 新開 | 補充既有 issue |
| :--- | :--- | :--- |
| Go | #83 #84 #85 #86 #87 #88 #89 #90 #91 #92 #93 #94 #95 | — |
| Java | #96 #97 #98 #99 #100 #101 #102 #103 #104 | — |
| Python | #105 #106 #107 #108 #109 #110 #111 #112 #113 #114 #115 | #87（`.pre-commit-config.yaml`）、#95（cleo、Expression） |
| TypeScript | #116 #117 #118 #119 #120 #121 #122 #123 #124 #125 #126 #127 #128 #129 | #84（Prettier／Biome 的 CRLF） |

**建議優先處理**：

1. 寫壞或覆寫專案檔案的 `fix`：#105、#100、#86、#106
2. 擋下所有 commit 的誤報：#84、#120、#110
3. 讓檢查形同沒做的假通過：#85、#93、#126、#99、#114
4. 讓整個檢查中止的：#122、#129、#89、#96

---

## 5. 結論

- **前兩輪修過的部分大致穩定**：Go 多模組向上查找設定（Round 2 問題 1）、`.vscode/settings.json` 合併保留註解、`.gitattributes` 等受管理檔案的編輯、#66 的自訂 Python 環境路徑、#70 的 `framework-not-installed` 提示，在新專案上都正常。jackson-databind 的覆蓋率判定從 Maven 執行、讀 parent POM 產生的 JaCoCo 報告到擋下 push，整條路徑正確。
- **本輪新增的 `install`／hook 步驟揭露最多盲點**：在 husky v4、lefthook、pre-commit 框架與 Windows symlink 的情況下，hook 都可能沒有真的呼叫 devguard，而 `doctor` 沒有回報（#93、#126、#129）。
- **Java 的程式碼層在真實專案上幾乎跑不起來**：5 個專案都沒有 Spotless，大多沒有 PMD 或 JaCoCo，devguard 只回報不易看懂的 `tool-failed`（#97、#98、#99）。只有 java-jwt 與 jackson-databind 實際跑出測試結果。
- **Windows 環境本身是重要變因**：CRLF（#84）、Bun 的 `.exe` shim（#122）、git symlink（#129）都只在 Windows 出現。#80 加入 Linux／macOS 支援後，建議下一輪在 Linux 上重跑一部分專案作對照。

---

## 6. 各語言詳細紀錄

各表的欄位是 9 步的結果，格內為 `exit code｜finding 數與簡述`。


### 6.1 TypeScript

devguard 0.3.1，Windows 11、Git for Windows（`core.autocrlf=true`、`core.symlinks=false`）、Node 24.21.0、npm 11.19.0、Bun 1.4.4。五個專案的 `draft` 都寫入 `standard: team@1.3.0`（沒有改用基線標準 `legacy@1.0.0`）。
流程：clone → `draft` → **安裝依賴前**先跑一次 `doctor`（記錄缺工具的回報）→ 安裝依賴 → `check` → `fix --yes` → `check` → `check --full` → `install --yes` → `doctor` → 修改一個原始檔並 `git commit`（pre-commit）→ `git push local`（pre-push，預設與 `DEVGUARD_PRE_PUSH=full` 各一次，推到本機 bare remote）。
格內 `exit｜E 錯誤 D 偏離 H 提示`。所有 `check`／`doctor` 的錯誤數都被 Windows CRLF 造成的格式錯誤灌大（見 #84 留言），表中註明。

| # | 專案 | SHA | 結構／工具鏈特徵 | 標準 | draft | check 前 | fix --yes | check 後 | check --full | install | doctor | pre-commit | pre-push |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | jquense/yup | `ff31eee8a2b10c938bb3a22544d9e33957a8cf01` | **Yarn Berry 4.10**（`.yarnrc.yml`、`nodeLinker: node-modules`）、舊式 `.eslintrc` + ESLint 8、Prettier 2、Vitest 3、`test/` 有自己的 tsconfig | team@1.3.0 | 0｜2 元件（`./`、`test/`），`deps.manager: yarn`、`printWidth: 80` | 1｜96E 0D 2H（85 筆 prettier 主因 CRLF，19 筆父子元件重複） | 0｜改 2 個 tsconfig、`.gitattributes`、建 `.vscode/` | 1｜173E 0D 2H（新開的 tsconfig 選項帶出 41 筆 tsc×2 元件） | 1｜175E：vitest 缺 `@vitest/coverage-v8` → `test/tool-failed`（訊息含 ANSI 色碼） | 0｜`.git/hooks/` 兩個 hook + `.claude/` | 1｜175E 0D 4H | 1｜擋下：42E（41 筆 tsc、eslint tool-failed） | 0 放行；full：1｜2E（vitest tool-failed） |
| 2 | vercel/ms | `4ff48cec099f0514c3e9bbca18706c9c21122bfb` | **Biome 2.1.3** + **Jest 30**（`preset: 'ts-jest'`）、pnpm 10、husky 9、`engines.node >=20` | team@1.3.0 | 0｜1 元件，`lint.tool: biome`、`test.tool: jest`、`deps.manager: pnpm`、`coverage.lines: 100` | 1｜14E 0D 0H（9 筆 biome/format 主因 CRLF） | 0｜tsconfig、`biome.json` 加 cognitive complexity、`.gitattributes`、`.vscode/` | 1｜9E（typescript 5.8.3 超界 + 8 筆 CRLF 格式） | 1｜9E；Jest 測試與覆蓋率通過 | 0｜注入 `.husky/pre-commit`、新增 `.husky/pre-push` | 1｜9E 0D 2H | 1｜**擋下：biome `code/tool-failed`（#120，任何 commit 都會）** | 0 放行；full：0（Jest 通過，約 5 秒） |
| 3 | typestack/class-validator | `2e1a5c27dbd65b80e27fe96b49bd6e6641fa3603` | **npm** + **Jest 29**（`preset: 'ts-jest'`、無 `coverageThreshold`）、`.eslintrc.yml` + ESLint 8、Prettier 2、husky **v4** 的 hook 已在 `.git/hooks/` | team@1.3.0 | 0｜1 元件，`test.tool: jest` | 1｜250E 0D 2H（203 筆 prettier 主因 CRLF、45 筆 tsc） | 0｜tsconfig 加 3 選項（整檔 CRLF→LF）、`.gitattributes`、`.vscode/` | 1｜251E 0D 2H | 1｜251E；Jest 測試與覆蓋率沒有 finding（4 分鐘） | 0｜**hook 沒裝**：既有 husky v4 hook「不會覆寫」，但印「已套用。」 | 1｜253E 0D 5H（`hook-foreign`） | 0｜devguard 沒執行（husky v4 hook）；照提示把那行加在結尾仍 0、doctor 卻不再報錯（#126）；手動移到開頭後 1｜44E 擋下 | 0 放行；full：0（devguard 沒執行，hook 是 husky v4） |
| 4 | remeda/remeda | `004b09194f6d39f727118c0a71adc9986bcc13e1` | **npm workspaces** monorepo、`prettier.config.js`（plugin-pkg／sh）、ESLint 10 `eslint.config.ts`、Vitest 5、husky 9、`.claude/skills` 是 git symlink | team@1.3.0 | 0｜6 元件（含只有設定檔的 `./` 與 `.claude/hooks/`），2 個 TODO 理由（`complexity.cyclomatic: 20`、`typecheck.strict: false`，後者是誤推，#124）；理由填成「Round 3 實測：沿用上游設定」 | 1｜427E 2D 15H（大量 typescript-eslint 錯誤來自 docs 需先 build remeda／`astro sync`） | 0｜建根目錄 `tsconfig.json`（無 include）、改 solution-style tsconfig、`.vscode/` 合併保留註解 | 1｜723E 2D 15H（根元件 26→341，#125） | 1｜727E：根元件在根目錄跑 vitest 收進所有 package 的測試並失敗；stackblitz-template `test/failed` + `coverage/no-report`；`packages/remeda` 自己通過 | **2｜`ENOTDIR` 內部錯誤（#129）**，寫了一半、husky hook 沒裝；重跑一樣 | 1｜726E 2D 18H（`framework-entry-missing`、SKILL 缺）；之後 `fix --yes` 也 exit 2 | 0｜只跑 lint-staged，devguard 沒有被呼叫（install 失敗） | 0 放行；full：0（devguard 沒有被呼叫） |
| 5 | elysiajs/elysia | `1cf5ce15dc4de23a96c769b5500a8d6fac8a8373` | **Bun**（`bun.lock`、`bun test`，沒有 Vitest／Jest）、`.eslintrc.json`、`tsc --init` 風格、滿是註解的 tsconfig、`test/cloudflare/` 子目錄（自己的 npm 專案） | team@1.3.0 | 0｜2 元件（`./`、`test/cloudflare/`），`printWidth: 80` | **2｜`找不到 eslint` 中止**：Bun 在 Windows 產生 `.exe` shim，devguard 只找 `.cmd`（#122）；`--only typecheck`／`format` 也 2 | 0｜兩個 tsconfig 加 3 選項，**行尾註解被移到新行**（#121）、`.gitattributes`、`.vscode/` | 2｜同上 | 2｜同上 | 0｜`.git/hooks/` 兩個 hook + `.claude/` | 1｜7E 0D 2H（`deps/lockfile-missing` 說缺 package-lock.json、tool-missing 提示 `npm ci`） | 1｜擋下：`environment/tool-missing` eslint | 0 放行；full：1｜`找不到 vitest` |

#### jquense/yup
- 安裝依賴前的 `doctor`：`找不到 eslint … 需手動修正：npm ci`，但元件是 `deps.manager: yarn`、只有 `yarn.lock`（#117）。tsconfig `extends: "@4c/tsconfig/web"` 未安裝前正確給 `settings/unconfirmed`；裝好後改成實際的 `settings/looser`。
- **tool-version 漏報**：`yarn.lock` 是 eslint 8.57.1、prettier 2.8.8、typescript 4.9.5，devguard 只回報 vitest 3.2.4。原因是 Berry 的多 descriptor key（`"eslint@npm:^8.4.1, eslint@npm:^8.57.1":`）讀不到，1551 個 entry 只解析出 1067 個（#116）。使用者因此只看到 `eslint 執行失敗：Invalid option '--warn-ignored'`，看不到「ESLint 8 超界」這個真正原因。
- 格式：working tree 是 CRLF（`* text=auto` + autocrlf），85 筆 `[prettier/format] …:1`；`prettier --end-of-line auto` 後只剩 6 個真正不符的檔案。`fix` 加上 `eol=lf` 之後仍是 82 筆（沒有重新 checkout 的提示，#84）。
- `./` 元件的 Prettier 也檢查 `test/` 子元件的檔案，19 個檔案在兩個元件各列一次（#127）。`test/tsconfig.json` 自己 include `../src`，所以 tsc 錯誤也在兩個元件各列一次（這是專案設定，不算 devguard 的問題）。
- `fix --yes`：只插入選項，沒有破壞排版；tsconfig 原本工作目錄是 CRLF，寫回 LF（index 本來就是 LF，diff 乾淨）。
- `check --full`：`vitest 執行失敗（exit 1）：\e[31m\e[7m\e[31m MISSING DEPENDENCY …` ANSI 色碼留在訊息中並斷行（#128）。
- pre-commit：只 stage `src/util/isAbsent.ts` 也被整個元件的 tsc 擋下（文件寫明的行為）；最後一行 `修正程式碼：devguard fix --code src/array.ts …` 列了 9 個只有 tsc 錯誤、沒有 staged 的檔案，`fix --code` 修不了（#123）。staged 版本是 LF，所以 commit 時沒有格式錯誤，與 `check` 不一致。
- pre-push：預設放行、不印；`DEVGUARD_PRE_PUSH=full` 擋下（vitest tool-failed）。行為符合文件。

#### vercel/ms
- `draft` 正確推出 Biome、Jest、pnpm、`printWidth: 80`（Biome 預設）與 `coverage.lines: 100`。`engines.node: ">=20"` 低於 `node.minVersion` 22，但 `draft` 不寫、`check` 不報：`src/` 沒有任何地方檢查 `node.minVersion`（#118）。
- `jest.config.ts` 有 `preset: 'ts-jest'`、沒有 `collectCoverageFrom`：`settings/coverage-include` 完全沒有回報，連 unconfirmed 提示都沒有，因為 `preset` 被當成「設定來自別處」（#119）。
- 安裝依賴前的 `doctor`：`找不到 biome … npm ci`（應為 pnpm，#117）；`core.hooksPath 未設定，husky 的 hook 沒有安裝；請執行 npx husky`，修正方式卻寫 `devguard install`（兩個方向）。`pnpm install` 的 `prepare` 執行 husky 後就消失了。
- `fix --yes`：`biome.json` 加入 `linter.rules.complexity.noExcessiveCognitiveComplexity`（15），格式保留；之後 `biome.json` 自己的格式錯誤也消失。Biome 格式錯誤訊息直接是 Biome 的 `Formatter would have printed the following content:`。
- `install`：husky 注入正確（`.husky/pre-commit` 原有 `pnpm biome check --write` 後加一行、新增 `.husky/pre-push`）。husky 原本的 `pnpm biome check --write` 需要 `pnpm` 在 PATH 上，所以用 corepack shim（見環境備註）。
- **pre-commit 一律被擋**：`biome lint --stdin-file-path` 沒有 `--write` 時永遠印 `× The contents aren't fixed.` 並 exit 1，devguard 當成 `code/tool-failed`。Biome 2.1.3 與 2.6.6 在空白目錄對 `export const a = 1;` 都一樣（#120）。
- pre-push：預設放行；`full` 跑 Jest（約 5 秒）通過放行。

#### typestack/class-validator
- 設定層判斷正確：ESLint 8、Prettier 2、TypeScript 5.4、Jest 29 都從 `package-lock.json` 讀出並回報超界；`.eslintrc.yml` 不被承認（只認 flat config，符合標準）。
- `jest.config.js` 有 `preset: 'ts-jest'`、沒有 `coverageThreshold`：只得到 `無法從設定檔確認 Jest coverageThreshold.global` 提示，`fix` 不補門檻（#119）。
- tsc 的 45 筆錯誤與直接執行 `tsc --noEmit` 一致（不是誤報）。203 筆 prettier 主因 CRLF。
- `fix --yes`：tsconfig 在上游是 `i/crlf` 提交的，`fix` 寫回 LF，`git diff` 變成整檔刪除再加回（#84 留言）。
- `check --full`：4 分鐘，測試與覆蓋率沒有 finding（沒有再單獨驗證覆蓋率數字）。
- `install`：`.git/hooks/pre-commit` 是 husky v4 產生的 → 「不會覆寫；請在其中加上：…」，但項目被標成 `建置檔或程式碼形式的設定`，最後印 `已套用。` exit 0。husky v4 hook 以 `. husky.sh` 結尾，`husky.sh` 沒有設定時 `exit 0`，**照提示加在結尾 devguard 永遠不會執行**，`doctor` 卻不再報 `hook-foreign`（#126）。手動把那行（去掉 `exec`）移到 shebang 之後才生效，commit 被擋下（44E，提示列出 19 個未 staged、只有 tsc 錯誤的檔案，#123）。
- `doctor` 也正確提示 `.gitignore` 忽略整個 `.vscode/`。

#### remeda/remeda
- `draft` 推出 6 個元件：根目錄 `./`（只有 `lint-staged.config.ts`、`prettier.config.js`）與 `.claude/hooks/`（Claude Code hook 腳本，只有 `tsconfig.json`）也各成一個元件。`packages/stackblitz-template/tsconfig.json` 是 solution-style（`files: []` + `references`），`draft` 推成 `typecheck.strict: false` 的 TODO，實際被參照的 `tsconfig.project.json` 是 strict 且三個額外選項都開（#124）。
- 缺工具的提示 `cd .claude/hooks && npm ci`：該目錄沒有 `package.json`（#117）。
- `prettier.config.js` 是 JS 設定 → printWidth／endOfLine 都只有 unconfirmed 提示（合理）。
- `check` 前：root 元件跑 `tsc` 時沒有 tsconfig，tsc 印出說明文字（`COMMON COMMANDS…`）被當成 `code/tool-failed`；root 的 Prettier 檢查 `.husky/_/` 下 husky 產生、被 `.husky/_/.gitignore` 忽略的檔案（17 筆，因為專案用 `prettier-plugin-sh`）；`.claude/hooks/lib/claude-code-hook.ts` 的格式錯誤在 `./` 與 `.claude/hooks/` 各列一次（#127）。`packages/docs` 的大量 typescript-eslint／tsc 錯誤是因為 docs 需要先 build `remeda` 與 `astro sync`，屬於環境。
- `fix --yes`：既有 `.vscode/settings.json` 合併時保留原本的 `//` 註解，很好。但在根目錄建立沒有 `include` 的 `tsconfig.json`，根元件的 tsc 檢查整個 monorepo（含 `node_modules/astro`、`unstorage` 的 `.ts`），錯誤 26→341（#125）；在 solution-style tsconfig 加入不會生效的 `compilerOptions`，此後不再回報（#124）。
- `check --full`：root 元件在根目錄執行 vitest、收進所有 package 的測試（funnel 計時測試等）並失敗，`packages/remeda` 自己的測試卻通過；測試 id 是絕對路徑（#125 留言）。
- **`install` 內部錯誤**：`.claude/skills` 是 git symlink，在 `core.symlinks=false` 下是一般檔案 → `devguard 內部錯誤：ENOTDIR: not a directory, mkdir '…\.claude\skills\standards-doctor'`，exit 2。已寫入 `.claude/settings.json`（hook 合併正確、保留專案原有 hook）與 rules，但 husky 的 hook 沒有寫入；此後 `fix --yes` 也因同一個錯誤 exit 2（#129）。
- 因此 pre-commit（只跑專案的 lint-staged）與 pre-push 都沒有經過 devguard，exit 0。

#### elysiajs/elysia
- `draft` 沒有推出任何 `deps.manager`（Bun 不在允許清單），`doctor` 回報 `沒有提交 package-lock.json [deps/lockfile-missing]`，只有「需手動修正」，沒有說明 Bun 不被支援（#122）。`test/cloudflare/` 有自己的 `package-lock.json`，typescript 5.9.2 超界被正確讀出。
- `bun install` 後 `node_modules/.bin/` 只有 `eslint.exe`／`eslint.bunx`，沒有 `.cmd`；devguard 在 Windows 只找 `.cmd` → `check`、`check --only …`、`check --full` 全部 exit 2 `找不到 eslint … 安裝：npm ci`（#122），看不到任何設定或程式碼 finding。
- `fix --yes`：在 `"skipLibCheck": true,  /* Skip type checking all .d.ts files. */` 後面插入三個選項時，行尾註解被搬到最後一個新選項後面、對齊空白消失（#121）。其他上百行註解都保留。
- `install` 正常（`.git/hooks/` 兩個檔案）。pre-commit 擋下（`environment/tool-missing` eslint，hook 照文件把缺工具列成錯誤）；pre-push 預設放行，`full` 擋下（`找不到 vitest`，專案實際用 `bun test`）。

#### 發現的問題
- #116 Yarn Berry 的 yarn.lock：多 descriptor 與 `patch:` entry 讀不到，tool-version 超界不回報 — 新開
- #117 TypeScript 找不到工具時一律提示 `npm ci`（yarn／pnpm／bun／workspace 子目錄都會失敗）— 新開
- #118 TypeScript 的 `node.minVersion` 沒有實作，不檢查 `engines.node` — 新開
- #119 Jest 設定有 `preset` 時 `collectCoverageFrom` 檢查被靜默略過、缺門檻只剩提示 — 新開
- #120 Biome 元件的 pre-commit／`check --staged` 一律 `code/tool-failed`，擋下每個 commit — 新開
- #121 `fix` 在 tsconfig 加選項時把行尾註解移到新插入的行 — 新開
- #122 Bun 專案：Windows 上 `.exe` shim 找不到、`check` exit 2；`bun.lock` 被報成缺 package-lock.json — 新開
- #123 pre-commit 的「修正程式碼：devguard fix --code」列出只有 tsc 錯誤、沒有 staged 的檔案 — 新開
- #124 solution-style tsconfig：draft 誤推 strict false、fix 寫入無效設定、tsc --noEmit 不檢查任何檔案 — 新開
- #125 workspace 根目錄被推成元件；`fix` 建立沒有 include 的 tsconfig，根元件型別檢查（及 vitest）涵蓋整個 monorepo — 新開（另留言補 vitest）
- #126 既有非 devguard hook（husky v4）：install 誤標為建置檔並印「已套用」、提示沒說位置、doctor 誤判通過 — 新開
- #127 TypeScript 父元件的 Prettier 包含子元件檔案，同一筆格式問題重複回報 — 新開
- #128 tool-failed 訊息保留 ANSI 色碼（Vitest）— 新開
- #129 `.claude/skills` 是檔案（未展開的 git symlink）時 install／fix 以 ENOTDIR 內部錯誤中止、只寫一半 — 新開
- #84 Windows `core.autocrlf=true` 的 CRLF 工作目錄被報成格式錯誤 — 既有（Go），留言補 Prettier／Biome 的重現與 `fix` 整檔改 LF

#### 環境備註
- 安裝依賴前的 `doctor`：五個專案都沒有回報 `pnpm`／`yarn` 本身不在 PATH，只回報 `environment/tool-missing`（找不到 eslint／biome），提示一律 `npm ci`（pnpm／yarn／bun 專案都不對，#117）。
- 為了安裝依賴與讓 husky 的 `pnpm biome check` 能執行，用 `corepack enable pnpm yarn ` 在使用者範圍建立 shim（pnpm 10.33.0、yarn 4.10.0 由 corepack 依 `packageManager` 下載），並把該目錄加進 PATH。Bun 1.4.4 本來就有。
- 依賴安裝：yup `corepack yarn install`（約 4 分鐘）、ms `pnpm install --frozen-lockfile`、class-validator `npm ci`（husky v4 寫入 `.git/hooks/*`）、remeda `npm ci`、elysia `bun install --frozen-lockfile`。
- 所有專案的 `doctor` 都有 `environment/vscode-cli-failed`（`code.cmd --list-extensions` 結束碼 49）提示，是本機 VS Code CLI 的問題。
- 每次 `check`／`doctor` 都會跑整個 code 層：class-validator 約 3–4 分鐘、remeda 約 5 分鐘（`check --full` 4 分鐘）。

### 6.2 Python

devguard 0.3.1，Windows 11、Python 3.14.7、uv 0.10.8。五個專案都用 `draft` 產生的 `team@1.3.0`。
「check 前」指環境裝好之後的 `check`；剛 clone、環境還沒裝時每個專案的 `check` 都以 `2`（找不到工具）結束，另外列在各專案的說明中。

| # | 專案 | SHA | 結構／工具鏈特徵 | 標準 | draft | check 前 | fix --yes | check 後 | check --full | install | doctor | pre-commit | pre-push |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `python-poetry/cleo` | `a03f2a592dd0e59e700a54fd7b0e69a817cd55e4` | **Poetry**（`poetry.lock`）、mypy strict、Ruff `extend-select` 加行尾註解、pre-commit 框架 | team@1.3.0 | 0｜1 元件（`deps.manager: poetry`、`lineLength 88`、`minVersion 3.9` TODO） | 1｜6E 0D 2H（含 mypy 誤報 `docs/conf.py`，#110） | 0｜extend-select→select，**17 個行尾註解被刪**（#111） | 1｜110E 0D 3H（新規則組的 ruff finding） | 1｜111E（分支覆蓋率 67.7%） | 0｜寫入 pre-commit 項目，提示 `pre-commit install` | 1｜110E 0D 5H | 先被專案鎖定的 pre-commit 4.3.0 擋下（符合 #69 設計）；升級後擋下 TODO 理由（正確）；填好後 0；py 修改被 `docs/conf.py` 誤報擋下（#110） | 1｜專案自己沒寫 `stages` 的 ruff-check 在 push 時執行並改檔（#95）；SKIP 後 0；`full` 1（分支覆蓋率） |
| 2 | `karpathy/minbpe` | `1acefe89412b20245db5a22d2a02001e547dc602` | **只有 `requirements.txt`**（無 pyproject.toml、無 lockfile） | team@1.3.0 | 0｜1 元件，無 override | 2 → 提示 `uv sync` 但會失敗（#112）；fix 建立 pyproject 後依提示 `uv add --dev` ruff／mypy：1｜127E 0D 0H | 0｜建立 `pyproject.toml`（只有 `[tool.*]`）、`.gitattributes`、`.vscode/` | 1｜127E（`lockfile-untracked`、ruff、mypy strict） | 2（缺 pytest）→ 1｜pytest exit 4：缺 pytest-cov 沒有提示（#109）→ 補 pytest-cov 與 requirements 後 1｜124E，測試全過、覆蓋率達標 | 0｜直接寫 `.git/hooks` | 1｜124E 0D 2H | 設定檔 commit 0；py 修改 1（mypy 89E，正確擋下） | 0；`full` 0 |
| 3 | `dbrattli/Expression` | `75965392922b40b79f3ac476cddb334428eb0b3e` | uv（`uv.lock`）、**pyright**（`pyrightconfig.json` strict）、Ruff 用 **dotted key**（`[tool.ruff]` 下 `lint.select`）、`docs/requirements.txt` | team@1.3.0 | 0｜2 元件（`./` pyright、`minVersion 3.10` TODO；`docs/` pyright） | 沒裝 extra：1｜410E（201 筆 pyright 在 `./` 與 `docs/` 各一份，#107）；`uv sync --all-extras`：1｜8E 0D 2H | 0，但**寫壞 pyproject.toml**（#105），docs/ 子元件改寫根目錄 `target-version` 與 `pythonVersion`、建立 `docs/pyproject.toml`（#106） | 1｜`settings/pyproject-invalid`，ruff／ruff format／pyright 全部 tool-failed；手動修好 TOML 後 1｜115E 0D 5H，docs/ 工具 `Failed to spawn`（#106） | 1｜pytest exit 4（缺 pytest-cov，#109）→ 補上後 1｜118E（行 79.9%、分支 57.8%；docs/ pytest `Failed to spawn`） | 0｜pre-commit 項目；既有 hook 的 flow sequence 被加空白（#87） | 1｜114E 1D 7H（根元件被建議把宣告改成 3.11，#106） | 專案的 pyright node hook 安裝失敗（nodeenv 解析 node 27 alpha，與 devguard 無關）；`SKIP=pyright` 後 0；pyright 錯誤的 py 修改 1（正確擋下） | 1｜專案的 ruff-check 與 `prevent-readme-edits`（`/bin/bash` not found）在 push 時執行（#95）；SKIP 後 0；`full` 1（覆蓋率 + docs/ pytest `Failed to spawn`） |
| 4 | `frankie567/httpx-oauth` | `8570ab5bff5cf10c802abbcc9cb4f80de2510b16` | uv、**basedpyright**（`[tool.basedpyright] typeCheckingMode = "off"`）＋實際使用的 `[tool.mypy]`、`--cov-fail-under=100` | team@1.3.0 | 0｜1 元件（`typecheck.tool: basedpyright`、`strict false` TODO、`lineLength 88`、`minVersion 3.10` TODO，#114） | 1｜48E 0D 0H | 0｜extend-select→select 正確（無註解可失） | 1｜79E 0D 1H | 1｜80E：測試全過卻回報沒有 id 的「測試失敗」（#108） | 0｜警告已有 `[tool.mypy]`（#68 行為） | 1｜79E 0D 3H（`mypy 2.1.0` 超出範圍，#113） | 設定檔 commit 0；**明顯的型別錯誤也通過**（basedpyright off，#114） | 0；`full` 1（#108 的假「測試失敗」擋下 push） |
| 5 | `Kludex/uvicorn` | `a99c1b76ee9caea67ff98e2ccc457bd372db193f` | uv、mypy 非 strict、**`UV_PROJECT_ENVIRONMENT` 指向 repo 外的絕對路徑**、`[tool.coverage.report] fail_under = 100` | team@1.3.0 | 0｜1 元件（`strict false` TODO） | 1｜32E 0D 1H（mypy 的 Windows 平台錯誤為真；ruff format 也檢查 `.md`，是 Ruff 0.17 的行為） | 0 | 1｜144E 0D 1H | 1｜pytest exit 4（#109）→ 補 pytest-cov 後 1｜145E：1371 passed 卻回報「測試失敗」（#108） | 0 | 1｜144E 0D 3H（`mypy 2.4.0` 超出範圍 #113；VS Code 直譯器仍指 `.venv` 不提示 #115） | 設定檔 commit 0；型別錯誤的 py 修改 1（在自訂環境找到 mypy，正確擋下） | 0；`full` 1（#108） |

#### python-poetry/cleo
- 沒有環境時 `check` 2：`找不到 ruff：專案環境（...\cleo\.venv）中沒有安裝`，提示 `poetry config virtualenvs.in-project true && poetry add --group dev "ruff>=0.17,<1"`（Poetry 提示正確）。`poetry install` 後 mypy／pytest 都在，但 ruff 不在依賴中，照提示 `poetry add` 後才能 `check`。
- 環境裝好前的 `doctor`：1｜8E 0D 3H，只列出第一個缺少的工具（ruff）。
- mypy 誤報：專案 `[tool.mypy] files = ["src", "tests"]`，自己跑 mypy 是 `Success: no issues found in 135 source files`；devguard 以 `.` 執行，回報 `docs/conf.py:183 [mypy/var-annotated]`。這筆誤報讓之後每一個含 Python 檔的 commit 都被 pre-commit 擋下，hook 還建議 `devguard fix --code docs/conf.py ...`（對型別錯誤無效）→ #110。
- `fix --yes`：`extend-select` 的 17 行多行陣列（每行有 `# flake8-bugbear` 之類的註解）被換成單行 `select`，註解全部消失 → #111。`[tool.coverage.run] branch = true` 加在檔案最末（`[tool.coverage.report]` 之前就有），只是位置不理想。`.vscode/` 被專案 gitignore，devguard 正確給出 `vscode/gitignored` 提示。
- `fix` 之後 ruff 回報 110 筆：主要是新增的 `S`（S101 assert、S105 `TOKEN_*` 常數）、`C90`、`W291`（測試字串中的行尾空白），以及 RUF100（原本 BLE001 的 `noqa`）。都是標準本身的結果，非 devguard 誤判。
- `check --full` 約 39 秒：測試通過，分支覆蓋率 67.7%（895/1322）。
- `install`：在既有 `.pre-commit-config.yaml` 加入兩個 local hook 與 `minimum_pre_commit_version: "4.4.0"`，既有內容未被改寫（這份設定的 flow sequence 原本就有內側空白）。
- pre-commit：
  - 專案 `poetry.lock` 鎖定 pre-commit 4.3.0，第一次 commit：`pre-commit version 4.4.0 is required but version 4.3.0 is installed`。`doctor` 事前沒有提示（#69 把「doctor 偵測本機 pre-commit 版本」列為 out of scope，所以不另開 issue）。在 venv 內升級到 4.7.0 後繼續。
  - 專案的 `pretty-format-json` hook 把 devguard 產生的 `.claude/settings.json` 重新排版（`args` 陣列展開成多行）；devguard 接受語意相同的結果，沒有回報不一致。
  - 填好 TODO 理由後 `.claude/rules/standards-root-python.md` 與宣告不一致（偏離段落要更新），`doctor` 回報 `settings/claude-code`，`fix --yes` 重新產生後 commit 通過。
- pre-push：沒有設定 `DEVGUARD_PRE_PUSH` 時，devguard 自己 `Passed`，但專案沒寫 `stages` 的 `ruff-check`（設定 `fix = true`）在 push 階段跑全部檔案，回報 108 筆並**改動 3 個檔案**，push 被擋 → 在 #95 補充重現。`SKIP=ruff-check` 後 push 成功；`DEVGUARD_PRE_PUSH=full` 以分支覆蓋率擋下（正確）。

#### karpathy/minbpe
- `draft` 以 `requirements.txt` 偵測到元件，草稿沒有 override。
- `check`：`找不到 ruff …  安裝：uv sync`；執行 `uv sync` 得到 `error: No pyproject.toml found in current directory or any parent directory`。`check` 以 exit 2 中止，看不到 `settings/pyproject-missing`；要跑 `doctor`（1｜5E 0D 2H）才會同時看到 → #112。`doctor` 的 lockfile 訊息清楚：「沒有提交 uv.lock（不帶 hash 的 requirements.txt 不算 lockfile）」。
- `fix --yes` 建立只有 `[tool.*]` 的 `pyproject.toml`；之後提示變成 `uv add --dev "ruff>=0.17,<1"`、`uv add --dev "mypy>=1.18,<2"`，可以照做（uv 警告沒有 `requires-python`，預設 `>=3.14`）。
- `check` 後 127E：`deps/lockfile-untracked`、ruff（I001、F401、S101、E501、format…；Ruff 0.17 也格式化 `README.md`、`lecture.md` 中的程式碼區塊）、mypy strict（無型別標註的程式碼）。
- `check --full`：先 2（缺 pytest，提示正確）；`uv add --dev pytest` 後 pytest 以 exit 4 失敗（`unrecognized arguments: --cov --cov-branch --cov-report=`），沒有指出是缺 pytest-cov → #109。補上 pytest-cov 後是 `ModuleNotFoundError: tiktoken`（requirements.txt 的依賴不在 uv 環境，屬專案範疇）；`uv pip install -r requirements.txt` 後測試全過、覆蓋率達標，約 47 秒。產生的 `uv.lock` 只鎖開發工具，執行期依賴仍沒有鎖定（記在 #112）。
- `check --full` 在 repo 根目錄留下 `.coverage`；minbpe 的 `.gitignore` 沒有忽略它，`git add -A` 時被一起提交（未開 issue，與手動執行 `pytest --cov` 相同）。
- 沒有 hook 框架：`install` 直接寫 `.git/hooks/pre-commit`、`pre-push`。設定檔 commit 通過；修改 `train.py` 的 commit 被 mypy（整個元件）擋下，符合設計。pre-push 預設與 `full` 都通過。

#### dbrattli/Expression
- `draft` 偵測到兩個元件：`./` 與只有 `requirements.txt`（Read the Docs 用）的 `docs/`。
- 只 `uv sync`（沒有 `--all-extras`，CI 用的是 `--all-extras`）時，pyright 因為 pydantic 不存在報出大量 unknown type。`docs/` 元件執行 pyright 時，pyright 往上載入根目錄 `pyrightconfig.json` 並檢查整個 repo，同樣的 201 筆在 `./` 與 `docs/` 各出現一次（410E）→ #107。
- `fix --yes`（exit 0）：
  - Ruff 設定寫成 `[tool.ruff]` 底下的 `lint.select`、`lint.ignore`，`fix` 另外加了 `[tool.ruff.lint]` 表頭 → `Cannot declare ('tool', 'ruff', 'lint') twice`，**pyproject.toml 變成不合法 TOML**，ruff／uv／pyright 全部讀不到。新的 `select` 也只多了 `S`，`B、C90、SIM、N` 沒加上。已做最小重現 → #105。
  - `docs/` 子元件沒有 override，於是把根目錄的 `target-version` 從 `py310` 改成 `py311`、刪掉 `pyrightconfig.json` 的 `pythonVersion`（根元件宣告的是 3.10），並建立只有 `[tool.coverage.run]` 的 `docs/pyproject.toml`。之後 `uv run --no-sync` 在 `docs/` 找不到工具（`Failed to spawn: ruff`），`check` 又要求在 `docs/pyproject.toml` 加 `[tool.ruff]`；根元件則收到提示「target-version 3.11 比宣告的 3.10 嚴格，建議把宣告同步成 3.11」。只保留根元件時不會發生 → #106。
- 為了跑完後續步驟，手動把 `select` 併回 `lint.select`（其餘維持 `fix` 的結果）。修好 TOML 後 check：1｜115E 0D 5H（UP044 是 target-version 被改成 3.11 造成的）。
- `check --full`：pytest exit 4（缺 pytest-cov，#109）→ 補上後行 79.9%、分支 57.8%；docs/ 元件的 pytest `Failed to spawn`（#106 的後果）。
- `install`：把既有 hook 的 `args: ["--fix"]` 改成 `args: [ "--fix" ]`、`types: [python]` 改成 `types: [ python ]` 等，與修正無關 → 在 #87 補充（同一個 `yaml` flow sequence 問題）。
- `doctor`：1｜114E 1D 7H。
- pre-commit：專案的 local `pyright`（`language: node`）hook 在本機因 nodeenv 無法解析 node `27.0.0-alpha` 而安裝失敗，與 devguard 無關；`SKIP=pyright` 後設定檔 commit 通過。加入回傳型別錯誤的 py 修改被 devguard 的 pyright 擋下（只跑所屬的 `./` 元件，沒有重複）。
- pre-push：專案的 `ruff-check --fix`（改了 `tagged_union.py`）與 `prevent-readme-edits`（`Executable /bin/bash not found`）在 push 階段執行並擋下 → #95。全部 SKIP 後 devguard `Passed`；`full` 以覆蓋率與 docs/ pytest `Failed to spawn` 擋下。

#### frankie567/httpx-oauth
- 專案實際用 mypy（`justfile`、CI 執行 `uv run mypy httpx_oauth/`），`[tool.basedpyright] typeCheckingMode = "off"` 只是把編輯器的檢查關掉。`draft` 依規則寫入 `typecheck.tool: basedpyright` 與 `typecheck.strict: false`（TODO）。照提示 `uv add --dev "basedpyright>=1.40,<2"` 後，basedpyright 在 off 模式下不回報任何問題；`install` 有警告 `[tool.mypy] 是 mypy 的設定`。故意寫 `def _probe(x: int) -> int: return "x"` 的 commit 被 pre-commit 放行 → #114。
- `check` 前 48E 主要是 Ruff 0.16.3 自己的預設規則（RUF059 等，直接執行 ruff 結果相同）。`fix` 把 `extend-select = ["I", "TRY", "UP"]` 併入 `select` 並補上標準規則組，TOML 合法。`fix` 後 79E，主要是新增的 `S105`／`S106`（測試中的假 token）。
- `ruff 0.16.3`、`mypy 2.1.0` 都被回報超出範圍；mypy 2.x 從 2026-05 起就是現行版本 → #113。
- `check --full`：專案 `addopts` 有 `--cov-fail-under=100`，直接執行是 `132 passed` 加上 `FAIL Required test coverage of 100% not reached. Total coverage: 99.13%`（exit 1）；devguard 回報沒有任何測試 id 的「測試失敗」→ #108。`DEVGUARD_PRE_PUSH=full` 的 push 也因此被擋。
- 加上 `.gitattributes`（`* text=auto eol=lf`）後，`core.autocrlf=true` 的工作目錄每個檔案都出現 CRLF 警告（與 #84 同一情境，Python 工具沒有因此產生 finding）。

#### Kludex/uvicorn
- 以 `UV_PROJECT_ENVIRONMENT` 指向 repo 外的絕對路徑執行全部步驟，repo 中沒有 `.venv`。`check`／`doctor` 的缺工具訊息正確顯示 `專案環境（...\uvicorn-env）`；`uv sync` 後 `check`、`check --full`、pre-commit hook 都在這個環境找到 ruff／mypy／pytest（#66 的修正有效）。
- 但 `fix` 寫入的 `.vscode/settings.json` 仍是 `"python.defaultInterpreterPath": "${workspaceFolder}/.venv"`，`doctor --verbose` 沒有任何提示 → #115。
- `check` 前 32E：mypy 在 Windows 上回報 `AF_UNIX`、`SIGUSR1` 等不存在（專案以 Unix 為主，結果為真）；ruff format 也檢查 `docs/*.md`（專案的 `scripts/check` 只跑 `uvicorn tests`，devguard 跑整個元件，符合 SPEC）。
- `fix` 後 144E（SIM117、S101、C901…）。
- `check --full`：pytest exit 4（缺 pytest-cov，#109）；補上後 `1371 passed, 33 skipped`，但 `[tool.coverage.report] fail_under = 100` 讓 pytest exit 1，devguard 回報「測試失敗」→ #108（第二個重現；另外 `addopts = "-rxXs"` 讓 short summary 不列 FAILED，就算真有失敗也抓不到 id）。
- `mypy 2.4.0`（專案要求 `mypy>=2.1.0`）超出範圍 → #113。
- 沒有 hook 框架，`install` 直接寫 git hook；型別錯誤的 commit 被擋下、設定檔 commit 通過；pre-push 預設 0、`full` 1（#108）。

#### 發現的問題
- #105 Ruff 設定用 dotted key（`[tool.ruff]` 下的 `lint.select`）時，`fix` 另加 `[tool.ruff.lint]` 表頭，寫出不合法的 pyproject.toml — 新開（Expression，附最小重現）
- #106 沿用上層設定的 Python 子元件：`fix` 依子元件標準改寫根目錄的 Ruff／pyright 設定，並建立讓工具無法執行的 `docs/pyproject.toml` — 新開（Expression）
- #107 pyright／basedpyright 在子元件沿用根目錄 pyrightconfig.json，整個 repo 的型別錯誤在子元件重複回報 — 新開（Expression，與 #92 同類）
- #108 coverage `fail_under`／`--cov-fail-under` 讓測試全過時也被回報為沒有 id 的「測試失敗」 — 新開（uvicorn、httpx-oauth）
- #109 `check --full` 不檢查 pytest-cov 是否安裝，只得到 pytest exit 4 的 tool-failed — 新開（minbpe、Expression、uvicorn）
- #110 mypy 以 `.` 執行，忽略 `[tool.mypy] files`，範圍外檔案誤報並擋下每個 commit — 新開（cleo）
- #111 `fix` 把 `extend-select` 併入 `select` 時刪掉每一項的行尾註解 — 新開（cleo）
- #112 只有 requirements.txt 的元件：提示 `uv sync` 但沒有 pyproject.toml 時會失敗 — 新開（minbpe）
- #113 `tools.mypy` 範圍 `>=1.18,<2` 排除了 mypy 2.x — 新開（uvicorn、httpx-oauth）
- #114 `draft` 依 `typeCheckingMode = "off"` 的 `[tool.basedpyright]` 選擇型別檢查器，型別檢查實際被關閉 — 新開（httpx-oauth）
- #115 使用 `UV_PROJECT_ENVIRONMENT` 時，VS Code 直譯器仍指向不存在的 `.venv`，`doctor` 不提示 — 新開（uvicorn）
- #95 依 `install` 提示安裝 pre-push hook 型別後，專案沒寫 `stages` 的 hook 也在 push 執行 — 既有，留言補充 cleo、Expression（ruff-check `--fix` 在 push 時改檔）
- #87 `yaml` 編輯時 flow sequence 被加內側空白 — 既有，留言補充 `.pre-commit-config.yaml`（Expression）

#### 環境備註
- 安裝：`uv tool install poetry`（Poetry 2.5.1，使用者範圍）。in-project venv 用環境變數 `POETRY_VIRTUALENVS_IN_PROJECT=true`，沒有改 Poetry 全域設定。安裝前 cleo 的 `doctor` 只回報 `找不到 ruff：專案環境（...\cleo\.venv）中沒有安裝`，附 `poetry config virtualenvs.in-project true && poetry add --group dev "ruff>=0.17,<1"`，沒有提到 Poetry 本身不在 PATH。
- 依 devguard 的提示在各 clone 中執行 `poetry add --group dev`／`uv add --dev` 加入 ruff、mypy、pytest、pytest-cov、pyright、basedpyright，因此各 clone 的 `pyproject.toml` 與 lockfile 有變動（只在本機 clone，沒有推到上游）。
- cleo：venv 內以 pip 把 pre-commit 從 4.3.0 升到 4.7.0（滿足 `minimum_pre_commit_version: "4.4.0"`）。minbpe：`uv pip install -r requirements.txt`。Expression：`uv sync --all-extras`（與 CI 相同）。uvicorn：`UV_PROJECT_ENVIRONMENT` 指向 repo 外的目錄。
- 所有專案的 `doctor` 都有 `environment/vscode-cli-failed`（`code.cmd --list-extensions` 結束碼 49）與 `environment/claude-never-ran` 提示，屬本機環境。
- 推送只到本機 bare remote（remote 名稱 `local`）。專案自己的 hook 擋下 push 時，用 `SKIP=<hook id>` 觀察 devguard hook 的結果，並在上表註明。

### 6.3 Go

受測 devguard 0.3.1，Windows 11、Go 1.26.5、golangci-lint 2.15.0（測試中途安裝）。5 個專案的 `draft` 都產生 **`team@1.3.0`**。
格式：`exit｜E 錯誤 D 偏離 H 提示`。「check 前」是填好 TODO 理由之後的第一次 `check`。

| # | 專案 | SHA | 結構／工具鏈特徵 | 標準 | draft | check 前 | fix --yes | check 後 | check --full | install | doctor | pre-commit | pre-push |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | go-testfixtures/testfixtures | `41332ec739cb1e88d7b7f22ba17a321c6326cd2d` | **`go.work`** 3 個模組（`.`、`cmd/testfixtures`、`dbtests`），**沒有 golangci 設定**，已有 `.gitattributes`（`* text eol=lf`） | team@1.3.0 | 0｜3 元件 | 1｜7E 3D 1H（裝 golangci-lint 前：2，找不到 golangci-lint） | 0｜**新增 3 份相同的 `.golangci.yml`**（#88） | 1｜21E 3D 18H（設定全清，剩真實 lint） | 1｜24E 3D 18H（`TestClickhouse` 需 DB 而失敗；覆蓋率 18.9%／0%） | 0｜原生 hook | 1｜21E 3D 20H | 0｜放行（0E，只檢查 staged 檔） | 預設 0；`DEVGUARD_PRE_PUSH=full` 1，擋下（測試失敗＋覆蓋率） |
| 2 | alecthomas/kong | `af6c65142cbcd8c86b11713721d6581bb9df4e07` | 單一模組＋`_examples/server/` 子模組，**golangci-lint v1 設定**（`enable-all: true`），**lefthook** | team@1.3.0 | 0｜2 元件 | 1｜33E 2D（每個元件 14 筆設定錯誤） | 0｜把 v1 檔改成 v1/v2 混合檔，且改寫無關排版（#86、#87） | 1｜6E 2D（version 錯誤、golangci 載入失敗，仍無法執行） | 1｜7E 2D（`_examples/server` 在 Windows build 失敗，`kr/pty`） | 0｜注入 `lefthook.yml`，沒有提示 `lefthook install` | 1｜6E 2D 2H（hook 根本沒裝也沒回報，#93） | 未裝 lefthook：0，**devguard 沒有執行**；`lefthook install` 後 1，擋下（`code/tool-failed`） | full 1，擋下（`kong_server [build failed]`；kong 自己的 lint job 也失敗） |
| 3 | carapace-sh/carapace | `95de92055a132347585d622a641e20908627c700` | **`go.work`**（`.`、`example-multi`、`example-nonposix`）＋ golangci v2，`_test/` 裡有 `.py` 測試資料，`_test_files/go.mod` 哨兵 | team@1.3.0 | 0｜**5 元件，含誤判的 `./ python` 與 `example/cmd/_test_files/`**（#89） | 2｜找不到 ruff，`安裝：uv sync`（整個檢查被擋）；移除 Python 元件仍是 2；加 `ignore` 後 1｜57E 4D 1H（52 筆是同一份設定重複 4 次，#92） | 第一次 0｜在 Go repo **新增 `pyproject.toml`**；修正宣告後重跑 0｜只改根目錄 `.golangci.yml` 一次 | 1｜77E 4D 61H | 1｜80E 4D 61H（5 個 symlink 測試在 Windows 失敗；覆蓋率 31.8%；`_test_files` setup failed） | 0｜原生 hook | 1｜77E 4D 63H | 0｜放行 | 預設 0；full 1，擋下 |
| 4 | pelletier/go-toml | `686c980c47581bf19b6119b60e9a59f2aed04170` | 單一模組，**`.golangci.toml`**（v2） | team@1.3.0 | 0｜1 元件 | 1｜23E 1D（誤報 `golangci-missing`，#85） | 0｜在 `.golangci.toml` 旁**新增會被忽略的 `.golangci.yml`** | 1｜21E 1D（設定「通過」，但 golangci-lint 仍讀 `.toml`） | 1｜21E 1D（測試通過、覆蓋率達標） | 0｜原生 hook | 1｜21E 1D 2H | 0｜放行 | 預設 0；full 0，放行 |
| 5 | AfterShip/email-verifier | `719a8832975a1f9b53d13825516180f313807a23` | 單一模組，golangci v2，**pre-commit 框架**，沒有 `.gitattributes` | team@1.3.0 | 0｜1 元件（推得 `complexity.cognitive: 20`） | 1｜37E 2D 1H（27 筆 gofmt 都是 CRLF 造成，#84） | 0｜註解保留良好 | 1｜40E 2D 12H（CRLF 的 27 筆 gofmt 仍在） | 1｜42E 2D 12H（第一次 3E：並行執行時 `parallel golangci-lint is running`，#94；單獨重跑：1 個測試失敗、覆蓋率 75.2%） | 0｜注入 `.pre-commit-config.yaml`，有提示 `pre-commit install` | 1｜41E 2D 15H（正確回報 `framework-not-installed`） | 1｜devguard **Passed**，被專案自己的 golangci-lint hook 擋下（CRLF gofmt） | 預設 1：專案的 golangci-lint hook 在 push 時也執行（#95）；full 1，devguard 也擋下（測試失敗＋覆蓋率） |

#### go-testfixtures/testfixtures
- **裝 golangci-lint 前**：`check` exit 2，`找不到 golangci-lint`／`安裝：把預設標準指定版本的 golangci-lint binary 放進 PATH`，沒寫出是哪個版本（#91）。`doctor` exit 1，列成 `environment/tool-missing`，其他檢查照常跑完，符合文件。
- 剛 clone、模組快取是空的：三個模組都被報 `deps/go-mod-untidy`，實際原因是 `GOPROXY=off` 下 `module lookup disabled`；`cmd/testfixtures` 的訊息只剩前 5 行的 `go: downloading ...`，看不到真正原因。`go mod download` 後三個模組的 `go mod tidy -diff` 都是 exit 0（#83）。
- 沒有 golangci 設定時，golangci-lint 以預設 linter 執行（報出 3 筆 staticcheck QF1012），合理。
- `fix --yes`：在 `.`、`cmd/testfixtures/`、`dbtests/` 各建一份內容相同的 `.golangci.yml`；devguard 已經會向上找設定，建一份在根目錄就夠（#88）。
- `.gitattributes` 原本是 `* text eol=lf`，仍被報 `settings/gitattributes-eol`，`fix` 在後面再加一行 `* text=auto eol=lf`。屬於精確字串比對；加上的行讓二進位檔改用自動偵測，結果合理，所以沒有開 issue。
- `check 後`：設定錯誤全清，剩下的 21 筆是 cyclop／gocognit／gosec／gofumpt 的真實問題。
- `check --full`：`dbtests` 需要真的資料庫，`TestClickhouse` 失敗、覆蓋率 0%；根模組 18.9%（測試主要在 `dbtests` 模組裡，跨模組的覆蓋率不會計入，這是 Go 本身的行為）。
- pre-commit 只檢查 staged 的 `bytes.go`，0E 放行；pre-push 預設不印東西、直接放行；`DEVGUARD_PRE_PUSH=full` 時擋下。

#### alecthomas/kong
- `draft` 把 `_examples/server/`（有自己的 go.mod）列成元件。
- **v1 設定**：`settings/golangci-version` 判斷正確，但接著仍以 v2 語意檢查：忽略 `enable-all: true`，把實際上已啟用的 `gosec`、`revive`、`bodyclose`、`misspell`、`gomodguard_v2` 報成缺少（誤報）。`fix --yes` 在 v1 檔裡加上 `linters.enable`（和 `enable-all` 並存）、`linters.settings`（和 `linters-settings` 並存）、`formatters`，仍沒有 `version`，golangci-lint 照樣 `unsupported version of the configuration: ""`（#86）。
- `fix` 改寫無關排版：`- tagalign    # ...` 變成 `- tagalign # ...`、`[revive]` 變成 `[ revive ]`；用一份最小的 v2 設定也能重現（#87）。註解本身有保留。
- `go-mod-untidy`：模組下載後根目錄 `go.sum` 真的有過時的 `repr` hash（正確回報）。
- 同一份根目錄 `.golangci.yml` 的 14 筆設定錯誤，在 `./` 和 `_examples/server/` 各列一次（#92）。
- **lefthook**：`install` 在 `lefthook.yml` 加入 `pre-commit`／`pre-push` 的 devguard job，格式正確，但沒有「下一步：`lefthook install`」。`.git/hooks` 是空的時候，`doctor` 沒有回報任何 hook 問題；這時 `git commit` 完全沒有經過 devguard（exit 0）。裝了 lefthook 2.2.2 並執行 `lefthook install` 之後，同樣的 commit 被擋下（`🥊 devguard`）（#93）。
- pre-push（`DEVGUARD_PRE_PUSH=full`，lefthook `parallel: true`）：devguard 回報 `kong_server [build failed]`（`kr/pty` 不支援 Windows，是真實的失敗），擋下 push。

#### carapace-sh/carapace
- `draft` 誤判：`example/cmd/_test/xonsh.py` 等兩個測試資料檔讓它產生 `./ python` 元件；`example/cmd/_test_files/go.mod`（上游用來讓 go 工具略過這個目錄的哨兵）被當成 Go 元件，而且它不在 `go.work` 裡（#89）。
- 有 Python 元件時，`check` exit 2：`找不到 ruff：專案環境（...\.venv）中沒有安裝`／`安裝：uv sync`，整個 Go 專案的檢查被擋；`fix --yes` 在根目錄新增 `pyproject.toml`。移除 Python 元件後，這兩個檔案變成未涵蓋檔案，仍是 exit 2（符合 `Project-Declaration.md` 的說明）；加上 `ignore: [example/cmd/_test/, example-multi/cmd/_test/]` 後才能繼續。
- `_test_files` 元件每次都有 `golangci-lint 執行失敗（exit 7）：... directory prefix . does not contain modules listed in go.work`。
- 4 個 Go 元件共用根目錄 `.golangci.yml`：57 個錯誤中有 52 筆是同樣 13 筆重複 4 次（#92）。`fix` 只改根目錄檔案一次（Round 2 的修正有效）。
- CRLF：`example-multi`、`example-nonposix` 的 `go.sum` 是 CRLF，被報 `go-mod-untidy`（diff 是整個檔案刪掉再加回）；同一份內容轉成 LF 後 `go mod tidy -diff` exit 0（#84）。
- `check --full`：`TestParentSymlinkedDir` 等 5 個測試需要 Windows symlink 權限而失敗，是環境因素；覆蓋率 31.8%。
- hook：pre-commit 0E 放行；pre-push full 擋下。

#### pelletier/go-toml
- **`.golangci.toml`**：`check` 誤報 `settings/golangci-missing`；`fix --yes` 新增 `.golangci.yml`；之後 `check` 不再有設定錯誤，但 `golangci-lint config path` 仍回傳 `.golangci.toml`，golangci-lint 的結果和 fix 前一模一樣，標準要求的 cyclop／gocognit／depguard／gofumpt 從來沒有執行（#85）。
- golangci-lint 的預設上限 `max-same-issues=3` 截斷結果：`gci` 只列出 3 筆，而且兩次執行列出的檔案不同；不設上限時有 73 筆（#90）。
- `govet inline` 的 `declared using go1.27.0` 是 golangci-lint 2.15.0 以 go1.27 建置造成的，和 devguard 無關。
- `check --full` 的測試與覆蓋率都通過（24 秒）。pre-commit 放行；pre-push 預設與 full 都放行。

#### AfterShip/email-verifier
- 系統層的 `core.autocrlf=true`（Git for Windows 預設）加上 repo 沒有 `.gitattributes`：27 個 `.go` 檔都被報 `golangci-lint/gofmt`，提示 `devguard fix --code`。`git ls-files --eol` 為 `i/lf w/crlf`，轉成 LF 後 `gofmt -s -l` 乾淨。`fix` 加上 `.gitattributes`，但沒有提示要重新 checkout，`check 後` 這 27 筆仍在（#84）。
- `fix --yes` 補了 linter、depguard 規則、`gofumpt`，248 行附大量註解的 `.golangci.yml` 只有新增的行，沒有改到別的地方。
- `check --full` 第一次和 go-toml 的 commit hook 同時執行：`golangci-lint 執行失敗（exit 3）：parallel golangci-lint is running`（#94）。單獨重跑：`TestNewSMTPClientFailed_WithInvalidProxy` 失敗、覆蓋率 75.2%。
- **pre-commit 框架**：`install` 加入 `repo: local` 的兩個項目，以及 `minimum_pre_commit_version: "4.4.0"`，並印出下一步 `pre-commit install --hook-type pre-commit --hook-type pre-push`；`doctor` 在執行前回報 `framework-not-installed`、執行後消失，符合 #70。
- commit：`devguard....Passed`，被專案自己的 golangci-lint hook 擋下（51 筆，主要是 CRLF 的 gofmt）。用 `SKIP=golangci-lint` 完成 commit。
- push：因為裝了 pre-push hook 型別，專案自己沒寫 `stages` 的 golangci-lint hook 在 push 時也執行，沒有設定 `DEVGUARD_PRE_PUSH` 也被擋下（#95）。full 時 devguard 也擋下（測試失敗＋覆蓋率）。

#### 發現的問題
- #83 Go：模組快取沒有依賴時，`go mod tidy -diff`（GOPROXY=off）的失敗被誤報為 `deps/go-mod-untidy` — 新開
- #84 Windows `core.autocrlf=true` 的 CRLF 工作目錄被報成 gofmt 與 `go-mod-untidy` 錯誤；`fix` 加了 `.gitattributes` 卻沒提示重新 checkout — 新開
- #85 不認得 `.golangci.toml`／`.golangci.json`：誤報缺設定，`fix` 新增的 `.golangci.yml` 不會被 golangci-lint 採用 — 新開
- #86 golangci-lint v1 設定：仍以 v2 語意檢查（忽略 `enable-all`），`fix` 寫出 v1/v2 混合、無法載入的檔案 — 新開
- #87 `fix` 編輯 `.golangci.yml` 時改寫無關排版：flow sequence 加空白、行尾註解對齊被壓縮 — 新開
- #88 go.work 工作區沒有 golangci 設定時，`fix` 在每個模組各建立一份相同的 `.golangci.yml` — 新開（enhancement）
- #89 `draft` 把 Go 會忽略的 `_*`／`testdata` 目錄當成元件：測試用 `.py` 產生 Python 元件、哨兵 `go.mod` 讓 golangci-lint 失敗 — 新開
- #90 golangci-lint 預設的 `max-same-issues=3`／`max-issues-per-linter=50` 截斷 `check` 結果 — 新開
- #91 找不到 golangci-lint 時，安裝提示沒有寫出版本範圍 — 新開（enhancement）
- #92 多個 Go 元件共用父目錄 `.golangci.yml` 時，同一筆設定 finding 在每個元件重複列出 — 新開（enhancement）
- #93 lefthook 的 hook 沒有安裝時，`install` 不提示 `lefthook install`，`doctor` 也不回報，commit 完全不經過 devguard — 新開
- #94 另一個 golangci-lint 正在執行時，`check`／hook 以 `parallel golangci-lint is running` 失敗 — 新開
- #95 pre-commit 框架：依 `install` 提示安裝 pre-push hook 型別後，專案既有沒寫 `stages` 的 hook 也在每次 push 執行 — 新開

#### 環境備註
- **golangci-lint**：原本沒有安裝。安裝前 `check` exit 2（`找不到 golangci-lint`／`安裝：把預設標準指定版本的 golangci-lint binary 放進 PATH`），`doctor` exit 1，列為 `environment/tool-missing`（同樣的提示文字），其他檢查照常完成。之後從 GitHub release 下載 v2.15.0 Windows amd64（以 checksums.txt 驗證）放到 `%USERPROFILE%\go\bin`（已在 PATH 上）。標準範圍為 `>=2.12,<3`。
- **lefthook** 2.2.2：release binary（驗證 checksum）放到 `%USERPROFILE%\go\bin`，只為 kong 的 hook 測試。
- **pre-commit** 4.6.2：`uv tool install pre-commit`，只為 email-verifier 的 hook 測試。
- Git for Windows 系統層 `core.autocrlf=true`，沒有 eol `.gitattributes` 的 repo 都是 CRLF 工作目錄；這是許多 gofmt／`go-mod-untidy` 錯誤的來源（#84）。testfixtures 本身有 `* text eol=lf`，所以沒有受影響。
- 為了讓後續步驟有意義，第一次 `check` 之後對每個模組執行了 `go mod download`；`-mod=mod` 下載曾改到 kong `_examples/server/go.sum` 與 email-verifier `go.sum`，已經 `git checkout` 還原，並重跑 `check 後`。
- 所有 push 都推到本機 bare repo（remote 名稱 `local`）；沒有推到上游，也沒有對上游開 PR。devguard repo 沒有修改。

### 6.4 Java

devguard 0.3.1（`main` @ 9a3c031）。clone 用 `--depth 1`；pre-push 推到本機 bare remote（`receive.shallowUpdate=true`），沒有推到上游。

| # | 專案 | SHA | 結構／工具鏈特徵 | 標準 | draft | check 前 | fix --yes | check 後 | check --full | install | doctor | pre-commit | pre-push |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `pf4j/pf4j` | `75ebd051269ccdba719b877fc130da0120a9ea20` | Maven 多模組（`pf4j`、`demo/maven`、archetype）＋`mvnw`，`maven.compiler.release` 8；沒有 Spotless／PMD／JaCoCo plugin | `legacy@1.0.0`（draft 寫 `team@1.3.0`＋`java.minVersion: "8"` TODO，手動改） | 0｜1 元件 | 1｜6E | 0｜新增 checkstyle.xml、pmd-ruleset.xml、.gitattributes、.vscode/ | 1｜3E | 1｜4E，Maven 有執行但 `jacoco` prefix 找不到，測試沒跑（#99） | 0｜.claude/、.git/hooks 兩個 | 1｜3E 2H | 1｜2E（2 筆 `code/tool-failed`）擋下 | 預設 0 放行；`DEVGUARD_PRE_PUSH=full` 1｜1E 擋下 |
| 2 | `LMAX-Exchange/disruptor` | `c871ca49826a6be7ada6957f6fbafcfecf7b1f87` | Gradle Groovy DSL 單專案（perf／jmh／jcstress sourceSets）＋`gradlew`（8.10），`sourceCompatibility` 11，自訂 `config/checkstyle/checkstyle.xml`（193 行），`.githooks/` | `team@1.3.0` | 0｜`build.tool: gradle` | 1｜7E 1H | 0｜**覆寫** checkstyle.xml（−190 行）、新增 pmd-ruleset.xml 等（#100） | 1｜3E 1H | 1｜4E 1H，Gradle 有執行但 `jacocoTestReport` task 不存在，測試沒跑（#99） | 0 | 1｜3E 3H | 1｜2E 擋下 | 預設 0；full 1｜1E 擋下 |
| 3 | `stleary/JSON-java` | `2cd0a8c2112a3bc17d33ba8546c54ecb613613f1` | 同層 `pom.xml`＋Groovy `build.gradle`，只有 `gradlew`（Gradle 6.3），Java 8（`<source>1.8`） | `legacy@1.0.0`，`build.tool: gradle`（手動加；draft 推成 Maven） | 0｜1 元件，沒寫 build.tool | 1｜7E 1H（Maven 草稿與宣告 gradle 結果相同） | 0｜新增 checkstyle.xml 等 | 1｜4E 1H | 1｜5E 1H，以 Maven 參數執行 `gradlew.bat`，usage 錯誤（#96） | 0 | 1｜4E 3H | 1｜2E 擋下 | 預設 0；full 1｜1E 擋下 |
| 4 | `auth0/java-jwt` | `1d589a4c1c3ca3ed56dd453be7a8a55b6f41dde0` | Gradle Groovy DSL 多專案（根＋`lib/`）＋`gradlew`（6.9.2），toolchain 11、`options.release = 8`，JaCoCo、Checkstyle（371 行 Google 風格） | `legacy@1.0.0`（draft 寫 `team@1.3.0`，讀不到 Gradle 版本，手動改） | 0｜`build.tool: gradle` | 1｜7E 1H（JDK 21 下 Gradle 6.9.2 無法啟動；改用 JDK 11 後同樣 7E 1H，原因變成缺 task） | 0｜**覆寫** checkstyle.xml（−358 行）（#100） | 1｜3E 1H | 1｜3E 1H，**Gradle 實際跑完 707 個測試、全過**；tests 層無 finding（改 team 實驗：誤報 `coverage/no-report`，#101） | 0 | 1｜3E 3H | 1｜2E 擋下 | 預設 0；full 0 放行（5 秒，Gradle up-to-date） |
| 5 | `FasterXML/jackson-databind` | `76d9be9ebf50fad44a3e35aefeabab3f04ce48d0` | Maven 單模組（3.x 分支）＋`mvnw`，繼承 parent POM `tools.jackson:jackson-base`（JaCoCo 在 parent），根目錄有一支 `filter_popular_issues.py` | `team@1.3.0`，加 `ignore: [filter_popular_issues.py]` | 0｜2 元件（`./` Python＋`./` Java） | 2｜`找不到 ruff`（Python 元件；只留 Java 元件仍 exit 2，加 `ignore` 後）1｜6E 1H | 0｜新增 checkstyle.xml 等，`.gitattributes` 追加一行、註解保留 | 1｜3E 1H | 1｜4E 1H，**Maven 實際跑完 7,805 個測試、0 失敗**，JaCoCo 判定分支覆蓋率 77.4% < 80%（581 秒） | 0 | 1｜3E 3H | 1｜2E 擋下（30 秒） | 預設 0；full 1｜1E（分支覆蓋率）擋下（393 秒） |

`check --full` 真的執行 Maven／Gradle 的：pf4j（Maven）、disruptor（Gradle）、java-jwt（Gradle，測試跑完）、jackson-databind（Maven）；其中測試真的執行並得到結果的是 java-jwt（707 個測試）與 jackson-databind（7,805 個測試＋覆蓋率判定），pf4j 與 disruptor 的 wrapper 有執行，但因為沒有 JaCoCo 在跑測試前就失敗（#99）。JSON-java 的 `check --full` 也呼叫了 `gradlew.bat`，但參數是 Maven 的，等於沒跑。

#### pf4j/pf4j
- **draft**：多模組正確合併成 `./ (Java)` 一個元件，從 `pom.xml` 讀出 release 8，寫成 `team@1.3.0`＋`java.minVersion: "8"`（附 TODO）。文件說 draft 不會寫 `legacy`，依說明手動改成 `legacy@1.0.0` 並刪掉 override。
- **check 前（6E，133 秒）**：`checkstyle-missing`、`pmd-missing`、`enforcer-rule-missing`、`gitattributes-eol` 合理；另外兩筆 `code/tool-failed` 的訊息只有 `[INFO] Scanning for projects...` 和 `[WARNING]`，看不出原因（#97）。直接執行才看到：
  - `spotless:check` → `No plugin found for prefix 'spotless'`（pom 沒有 Spotless；settings 層沒有回報，#98）
  - `checkstyle:check pmd:check` → `pf4j-demo-api` 解析不到同 reactor 的 `org.pf4j:pf4j:3.17.0-SNAPSHOT`（只跑 goal 不經過 compile，#102）
- **fix --yes**：新增 `checkstyle.xml`（只有 `CyclomaticComplexity` max 20 與 `IllegalImport`）、`pmd-ruleset.xml`（quickstart＋CognitiveComplexity 25，基線標準的值正確）、`.gitattributes`、`.vscode/`。pom 沒有 `maven-checkstyle-plugin` 的 `configLocation`，產生的 `checkstyle.xml` 不會被 Maven 採用（預設 sun_checks），settings 層也不回報（#98）。
- **check 後（3E）**：enforcer＋兩筆 tool-failed。
- **check --full（4E）**：多一筆 `test/tool-failed`，訊息是 Maven 結尾的 `[Help 1] …NoPluginFoundForPrefixException`（#97）。原因是固定帶 `jacoco:report`，pf4j 沒有 JaCoCo，基線標準的 `coverage.lines: 0` 也一樣跑不了測試（#99）。直接執行 `mvnw test`：336 個測試、**1 個 error**——devguard 因此漏報一個真的測試錯誤。
- **install**：沒有 hook 框架，寫入 `.git/hooks/pre-commit`、`pre-push` 與 `.claude/`。
- **doctor**：同 check 的 3E，加 `environment/claude-never-ran`、`environment/vscode-cli-failed`（見環境備註）。
- **pre-commit**：在 `StringUtils.java` 尾端加一行註解並 stage 全部設定檔。hook 觸發，2 筆 `code/tool-failed` 以 exit 1 擋下（29 秒；tool-failed 沒有檔案，不會印 `修正程式碼：devguard fix --code` 那行）。之後以 `--no-verify` commit。
- **pre-push**：第一次 push 被 bare remote 以 `shallow update not allowed` 拒絕（`--depth 1` clone 的關係，非 devguard 問題；hook 預設放行所以沒有輸出）。設 `receive.shallowUpdate` 後：預設 exit 0 不輸出；`DEVGUARD_PRE_PUSH=full` 跑 tests 層，同一筆 `test/tool-failed` 擋下。

#### LMAX-Exchange/disruptor
- **draft**：推出 `build.tool: gradle`。`sourceCompatibility = targetCompatibility = JavaVersion.VERSION_11` 沒讀出來（文件明說 Gradle 建置檔不讀版本，只給 `settings/version-unreadable` 提示），所以草稿沒有 `java.minVersion: "11"` 的放寬，team 的 17 實際上不符合也不會報錯。
- **check 前（7E 1H，83 秒）**：既有 `config/checkstyle/checkstyle.xml` 缺 `CyclomaticComplexity`、`IllegalImport`；`pmd-missing`；`gradle.lockfile` 缺；Gradle 的 tool-failed 訊息清楚（`Task 'pmdMain' not found`、`Task 'spotlessCheck' not found`）。缺 PMD 時整個 Checkstyle 呼叫也一起失敗，已設定的 Checkstyle 沒有結果（#98）。`checkstyle 'com.puppycrawl.tools:checkstyle:10.4'`（低於 `>=10.21`）沒有 `tool-version` finding（#103）。
- **fix --yes**：把專案 193 行的 Checkstyle 設定（命名、import、空白、`SuppressionFilter`）**整份換成** 13 行的產生檔（10+／190−），預覽只寫「重新產生（由 CLI 產生）」（#100）。
- **check 後（3E 1H）**／**check --full（4E 1H）**：`test/tool-failed` 訊息只有 Gradle 結尾的 `BUILD FAILED in 1s`；實際是 `Task 'jacocoTestReport' not found`（#97、#99）。直接 `gradlew test`：2 分 6 秒，全部通過。
- **install**：專案有 `.githooks/pre-commit`（自己的 stash／spotless 腳本），但 clone 沒設 `core.hooksPath`，devguard 寫入 `.git/hooks`，沒有衝突提示（合理）。
- **pre-commit**：擋下（2 筆 tool-failed，3 秒）。**pre-push**：預設放行；full 擋下。

#### stleary/JSON-java
- **draft**：同層的 `pom.xml` 與 `build.gradle`，草稿沒有寫 `build.tool`（等於 Maven），但專案只提交 `gradlew`（#96）。
- **check 前**：草稿（Maven）與手動加 `build.tool: gradle` 的結果**一樣**：`settings/wrapper-missing` 說缺 **Maven** wrapper、`enforcer-rule-missing` 讀 pom.xml，而且 `code` 層以 Maven 參數執行 `gradlew.bat`：`Unknown command-line option '-B'. USAGE: gradlew [option...] [task...]`。三層都是「有 pom.xml 就是 Maven」，宣告的 build.tool 被忽略；runner 找 wrapper 時不分 mvnw／gradlew（#96）。
- `.gitignore` 忽略整個 `.vscode/`，提示 `vscode/gitignored` 正確，附了正確的例外規則寫法。
- **fix／check 後／--full／doctor／hooks**：都卡在同一個問題；`check --full` 執行 `gradlew.bat -B -Dmaven.test.failure.ignore=true test jacoco:report`，訊息是 gradlew 的 usage（#96）。Gradle 6.3 本身也不能在 JDK 21 上跑，就算參數正確也需要較舊的 JDK。

#### auth0/java-jwt
- **draft**：`build.tool: gradle`；`options.release = 8` 讀不到（Gradle 不讀版本），依 brief 手動改 `legacy@1.0.0`。
- **check 前**：先在 JDK 21 下跑，Gradle 6.9.2 以 `Unsupported class file major version 65` 無法編譯 `settings.gradle`；devguard 的訊息是前 5 行 `FAILURE … * Where: Settings file '…settings.gradle'`，看不到原因（#97）。`doctor` 只在 JDK < 11 時提示，沒有 wrapper 版本與 JDK 不相容的提示（環境問題，未開 issue）。安裝 JDK 11 後重跑：7E 1H，與 disruptor 同類（缺 PMD／Spotless task）。`lib/build.gradle` 的 `checkstyle { toolVersion '10.0' }` 沒有 `tool-version` finding，因為只讀根目錄的建置檔（#103）。
- **fix --yes**：把 371 行的 Google 風格 Checkstyle 設定換成 13 行（13+／358−）（#100）。
- **check --full（3E 1H，60 秒）**：Gradle 真的跑完 `test jacocoTestReport`，`lib/build/test-results` 707 個測試、0 失敗，tests 層沒有 finding（基線標準不看覆蓋率）。**實驗**：暫時改成 `team@1.3.0` 再跑，報 `找不到覆蓋率報告 build/reports/jacoco/test/jacocoTestReport.xml [coverage/no-report]`，但報告在 `lib/build/reports/jacoco/test/` 裡——Gradle 多專案只讀根目錄（#101）。實驗後已改回 `legacy@1.0.0`。
- **pre-commit**：擋下（2 筆 tool-failed）。**pre-push**：預設放行；full 也放行（5 秒，Gradle 的 test task up-to-date，沒有重跑測試）。

#### FasterXML/jackson-databind
- **draft**：根目錄一支 `filter_popular_issues.py` 讓草稿多一個 `./ (Python)` 元件（依 SPEC §4.1 的設計；可以用 `draft --ignore`）。照草稿 `check` 以 exit 2 中止：`找不到 ruff：專案環境（…\.venv）中沒有安裝`，167 秒的 Java 檢查結果全部沒有輸出。刪掉 Python 元件仍 exit 2（uncovered-files 依副檔名套用 Python 預設標準，也會找 ruff），要加 `ignore: [filter_popular_issues.py]` 才行。是設計行為，但「刪掉元件」這個直覺做法沒用，值得在報告提一下。
- **check 前（6E 1H，98 秒）**：`checkstyle-missing`、`pmd-missing`、`enforcer-rule-missing`、`gitattributes-eol`、兩筆 `[INFO] Scanning for projects...` 的 tool-failed（#97）；`settings/version-unreadable`（release 在 parent POM／profile 裡）是合理的提示。直接執行：Spotless 沒設定；`checkstyle:check` 以 Maven 預設 sun_checks 跑出 `You have 50508 Checkstyle violations.`，接著 `maven-pmd-plugin:3.28.0:pmd` 因 parent POM 的舊 fluido skin 產生報告失敗。PMD 一旦修好，這 5 萬筆 sun_checks 違規就會全部變成 finding（#98）。
- **fix --yes**：`.gitattributes` 原有註解與 `pom.xml merge=ours` 保留，只在結尾加一行（managed 檔案的編輯正確）。
- **check 後（3E 1H）**：enforcer＋兩筆 tool-failed。
- **check --full（4E 1H，581 秒）**：`mvnw test jacoco:report` 跑完 7,805 個測試（0 失敗），parent POM 的 JaCoCo 寫出 `target/site/jacoco/jacoco.xml`，devguard 正確讀出 `分支覆蓋率 77.4%（17461/22549）低於門檻 80% [coverage/branches]`，行覆蓋率通過、沒有回報。這是本輪 Java 唯一一個覆蓋率判定完整走完的專案，結果合理。
- **install**：寫入 `.git/hooks` 兩個 hook 與 `.claude/`。**doctor**：3E 3H（同 check，加 claude-never-ran、vscode-cli-failed）。
- **pre-commit**：在 `JsonNode.java` 加一行註解，2 筆 tool-failed 擋下（30 秒）。
- **pre-push**：預設 exit 0；`DEVGUARD_PRE_PUSH=full` 重跑整套測試（393 秒），以分支覆蓋率 77.4% 擋下，行為符合文件。

#### 發現的問題
- #96 Java：同時有 pom.xml 與 build.gradle 時一律當成 Maven，忽略宣告的 build.tool；runner 拿 Maven 參數執行 gradlew — 新開（JSON-java）
- #97 Java 的 code/test tool-failed 訊息擷取到 Maven／Gradle 的樣板行，看不到真正的錯誤 — 新開（pf4j、disruptor、jackson-databind、java-jwt；Go 的同類是 #83）
- #98 Java：不檢查建置檔有沒有 Spotless／PMD／Checkstyle plugin，也不檢查是否指向 devguard 的設定檔；缺 plugin 只得到 tool-failed — 新開（5 個專案都沒有 Spotless）
- #99 Java check --full：專案沒有 JaCoCo 時測試完全不執行（基線標準的 coverage 0 也一樣）— 新開（pf4j 因此漏報 1 個測試錯誤）
- #100 fix 把專案自己寫的 checkstyle.xml 整份換成只有兩個 module 的產生檔 — 新開（disruptor、java-jwt；產生檔也不符 SPEC §6.4 的 google_checks 基礎）
- #101 Gradle 多專案建置只讀根目錄的 JaCoCo／Checkstyle／PMD 報告，子專案的覆蓋率被誤報 coverage/no-report — 新開（java-jwt）
- #102 Maven 多模組：lint 指令不經過 compile，模組間相依時整個 checkstyle:check pmd:check 失敗 — 新開（pf4j）
- #103 tool-versions 讀不到 Gradle 以 dependency 宣告或寫在子專案的工具版本，超出範圍不回報 — 新開（disruptor、java-jwt）
- #104 devguard 用法說明仍提到已移除的鏡像帳密與弱點掃描 — 新開（`devguard --help`／用法錯誤時印出）

#### 環境備註
- JDK 21.0.13（Temurin）＋Maven 3.9.16 已預裝；Git Bash 沒有 `JAVA_HOME`，每個指令先設定 `JAVA_HOME`，並把受測 devguard、JDK、Maven 放到 PATH 前面。
- **安裝了 Temurin JDK 11.0.32.1+1**（使用者範圍），只給 java-jwt（Gradle 6.9.2 不支援在 JDK 21 上執行）。安裝前 `doctor` 沒有任何 Java 執行環境相關的提示（`environment/java-runtime` 只在 JDK < 11 時出現），失敗只以 `code/tool-failed` 呈現。JSON-java 的 Gradle 6.3 同樣需要舊 JDK，但它被 #96 擋住，用不到。
- 選了 5 個之後換掉 2 個：`j-easy/easy-random`、`scribejava/scribejava` 在 clone 後未執行就換成 java-jwt 與 jackson-databind，因為前兩者沒有 JaCoCo（easy-random）或沒有 wrapper（scribejava），`check --full` 不會有真實測試結果。
- `environment/vscode-cli-failed`（`code.cmd --list-extensions --show-versions 結束碼 49`）在 doctor 中時有時無：同一個 repo 直接從 Git Bash 或 PowerShell 執行 `doctor` 則沒有，直接執行 `code.cmd --list-extensions` 都是 exit 0。推測是多個 agent 同時呼叫 VS Code CLI，未開 issue。
- 所有 clone 都是 `--depth 1`，推到本機 bare remote 要先 `git -C <remote> config receive.shallowUpdate true`。
- Windows 上 `git add` 會出現 `CRLF will be replaced by LF`：devguard 加的 `.gitattributes`（`* text=auto eol=lf`）與 `core.autocrlf` 的組合，Go 那邊的 #84 有討論。
