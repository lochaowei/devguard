# 實際專案測試 Round 4 報告

> [!NOTE]
> 本報告記錄 #208（實際專案測試 Round 4：每種語言各三個 GitHub 專案，加上效能測試）的測試範圍、12 個公開專案的全流程結果、效能量測，以及實測開出的 10 個 issue（#209–#218）。修正不在本輪範圍，各 issue 另外處理。四種語言的片段都已交回，沒有缺漏。

- **受測版本**：devguard 0.5.2（`main` @ `da27b05`，release 0.5.2），以 `npm run build:exe` 產生的 Windows x64 exe；`draft` 寫入的標準都是 `team@1.4.0`
- **環境**：Windows 11、Git for Windows（`core.autocrlf=false` clone）、Core i7-1165G7（4 核 8 緒）、64 GB RAM、SSD；Node 24.21.0、npm 11.19.0、pnpm 12.11.2（corepack shim）、Bun 1.4.4、Python 3.14.7、uv 0.10.8、pre-commit 4.6.2、Go 1.26.5、golangci-lint 2.15.0、Temurin JDK 21.0.13、Maven 3.9.16
- **測試中安裝的工具**（使用者範圍）：TypeScript 只有 pnpm 的 corepack shim；Python 在各專案內的 `.venv` 安裝 ruff、mypy、pytest 等；Go、Java 沒有新增工具。細節見第 7 節各語言的環境備註
- **前幾輪**：[Round 1](../real-project-test-report.md)、[Round 2](round-2-report.md)、[Round 3](round-3-report.md)。本輪的 12 個專案是前幾輪報告中沒有出現的專案，並刻意挑前幾輪沒測過的工具鏈。

---

## 1. 方法

流程與 [Round 3](round-3-report.md) 相同，每個專案依序執行 9 步，並照 [procedure.md](procedure.md) 進行：

```mermaid
flowchart LR
    A[draft] --> B["check（修正前）"] --> C["fix --yes"] --> D["check（修正後）"] --> E["check --full"]
    E --> F[install] --> G[doctor] --> H["commit → pre-commit"] --> I["push → pre-push"]
```

- 每種語言 3 個專案（Round 3 為 5 個），由四個 agent 並行測試；每個 agent 寫一份片段，再組裝成本報告。
- 專案 clone 到 devguard repo 之外（`git clone -c core.autocrlf=false`）；pre-push 只推到本機 bare remote，沒有推到上游，也沒有對上游開 PR。
- `draft` 產生的 TODO 理由先填好再跑 `check`；專案自己的 hook 擋路時用 `SKIP=<hook id>`，devguard 的 hook 擋下 commit 時才用 `--no-verify` 前進到 push 步驟，並在各專案紀錄中註明。
- pre-push 各跑兩次：預設，以及 `DEVGUARD_PRE_PUSH=full`。
- 每個 finding 都和直接執行該工具的結果對照，區分 devguard 的問題與專案或環境的問題。只有確認是 devguard 的問題才開 issue，開之前先查重並對照 `.out-of-scope/`。
- **本輪新增效能量測**：每個步驟至少 2 次取中位數、區分冷與暖；拆解 devguard 與直接執行工具的耗時；以 `check --staged` 量測 pre-commit 在 staged 檔案數為 1、10、25 個，以及「部分 staged」（stage 後又修改同一個檔案）時的擴展性。計時時機器沒有其他負載。

---

## 2. 受測專案總覽

格內記號：`E` 錯誤、`D` 偏離、`H` 提示。各步驟的 exit code 與完整觀察見第 7 節。

| 語言 | 專案 | 結構／工具鏈特徵 | 標準 | 主要結果 |
| :--- | :--- | :--- | :--- | :--- |
| TypeScript | `sindresorhus/p-queue` | xo、`node:test`、沒有 lockfile（`package-lock=false`）、tab 縮排 | team@1.4.0 | 專案沒有 Vitest 時 `check --full` 以 exit 2 中止（#210）；Prettier 不符的檔案越多，`check` 越慢（#209）；`fix` 寫出的設定不符 `.editorconfig`（#211） |
| TypeScript | `vuejs/pinia` | pnpm workspace（9 個元件）、oxfmt、simple-git-hooks | team@1.4.0 | 專案沒有 ESLint，`check` 以 exit 2 中止、沒有任何其他 finding（#210）；擋下每個 commit |
| TypeScript | `ajv-validator/ajv` | ESLint 8 `.eslintrc.js`、Mocha、git submodule、沒有 lockfile | team@1.4.0 | `--no-warn-ignored` 讓 ESLint 8 失敗，**每個 commit 都被擋**（#212） |
| Python | `frostming/marko` | PDM（`pdm.lock`）、pre-commit 框架 | team@1.4.0 | `deps/lockfile-missing` 要求 `uv.lock`，缺工具提示 `uv add --dev`（#213）；1,648 個測試全過 |
| Python | `tox-dev/pipdeptree` | Rust／meson 混合建置、只有 PEP 751 `pylock.toml` | team@1.4.0 | 同樣是 #213；pytest 收集失敗屬環境限制 |
| Python | `pypa/build` | flit-core、沒有 lockfile、7 個 fixture 套件各有 `pyproject.toml`（9 個元件） | team@1.4.0 | fixture 元件缺工具被報成 `tool-failed`（#214）；`fix` 動到無關行（#215） |
| Go | `rancher/local-path-provisioner` | `.golangci.json`、committed `vendor/`、巢狀模組 | team@1.4.0 | `.golangci.json` 正確辨識與修改，沒有改壞 |
| Go | `jesseduffield/lazygit` | 單一大型模組（約 1,350 個 `.go`）、committed `vendor/`、golangci v2 | team@1.4.0 | `fix` 後第一次 `check` 因快取失效 52 秒；pre-commit 耗時隨 staged 檔案數成長（#216） |
| Go | `mattn/go-sqlite3` | cgo、本機沒有 C 編譯器、沒有 golangci 設定 | team@1.4.0 | 標準要求的 linter 因環境無法載入而從沒真正執行；pre-commit 耗時隨 staged 檔案數成長（#216） |
| Java | `jhy/jsoup` | Maven 單模組、**沒有 `mvnw`**、沒有 Spotless／PMD／Checkstyle／JaCoCo | team@1.4.0 | `check` 與 `check --full` 對缺 wrapper 的處理不同（`--full` exit 2）；沒有 JaCoCo 時測試有執行（#99 已修） |
| Java | `apache/commons-csv` | Maven、沒有 `mvnw`、遠端 parent POM、自己設 Checkstyle／PMD／RAT | team@1.4.0 | **`check` 只印「找不到 mvnw」就 exit 2，沒有任何 finding**（#217）；`fix` 產生的檔案讓 RAT 失敗（#218） |
| Java | `wiremock/wiremock` | Gradle Kotlin DSL、9 個子專案、`buildSrc` 慣例 plugin | team@1.4.0 | Gradle 跑完 5,359 個測試；第一次 `check` 265 秒（冷啟動）；缺 PMD 只得到 `pmdMain` 不存在的 `tool-failed` |

**`check --full` 實際執行的情況：**

- TypeScript：**3 個都沒有跑完**。p-queue、ajv 缺 Vitest，pinia 缺 ESLint，全都以 exit 2 中止（#210）；只有 pinia 的 `DEVGUARD_PRE_PUSH=full` 實際跑了 Vitest。
- Python：3 個都有執行。marko 1,648 個測試全過；pipdeptree 的 pytest 在收集階段失敗（環境限制）；build 跑完 71 個測試失敗（`NO_COLOR`／`FORCE_COLOR` 同時設定等環境因素，與直接執行 pytest 一致）。
- Go：3 個都有執行，失敗都和直接執行 `go test`／`golangci-lint` 一致（Windows 不支援的範例、終端機相關測試、缺 C 編譯器）。
- Java：jsoup（補上 wrapper 後 2,648 個測試全過）與 wiremock（5,359 個測試，2 個時間相關的失敗）真的跑了測試；commons-csv 在 Apache RAT 就失敗，測試沒有執行（#218）。

> [!IMPORTANT]
> TypeScript 沒有任何專案跑完 `check --full`：三個專案都被 #210 擋住，所以 TypeScript 的 code＋測試＋覆蓋率耗時沒有量到。

---

## 3. 跨語言的問題主題

### 3.1 專案用的工具與標準要求的不同時，檢查整個中止或沒有結果

- **缺工具讓整個 `check` 中止**：#210（oxfmt、xo、`node:test` 專案沒有標準要求的 ESLint、Prettier、Vitest，安裝提示無效，擋下每個 commit 與 push）。
- **缺 wrapper 時只剩一行錯誤**：#217（commons-csv 的 Maven 沒有 `mvnw`，`check` exit 2、沒有任何 finding；jsoup 同樣缺 wrapper 卻能列出所有 finding）。
- **本輪沒有出現的中止**：Go 的 `.golangci.json`、committed `vendor/` 與 cgo 專案都沒有讓 `check` 中止。

### 3.2 `fix` 的產出與專案本身不一致

- **不符合專案的編輯器設定**：#211（`.prettierrc`、`.vscode/*.json` 以 2 空白縮排，專案 `.editorconfig` 是 tab，下一次 `check` 就報成 `prettier/format`）。
- **動到無關的行**：#215（`pyproject.toml` 陣列最後一個元素的行尾註解空白多一格），與 Round 3 的 #87、#111 同類。
- **產生的檔案讓專案自己的檢查失敗**：#218（Apache RAT 要求授權標頭，`pmd-ruleset.xml` 與 `.devguard.yaml` 沒有）。
- **沒有重現的 Round 3 問題**：#86、#105、#100（設定被寫壞或覆寫）在本輪都沒有重現；`.golangci.json`（v2）修改後仍是合法 JSON，保留原本的縮排。

### 3.3 誤報與擋下 commit

- **每個 commit 都被擋**：#212（ESLint 8 不認得 `--no-warn-ignored`，沒有 lockfile 時連版本原因都看不到）、#210（pinia 缺 eslint）。
- **環境因素造成的 `tool-failed`**：go-sqlite3 沒有 C 編譯器時 golangci-lint 無法載入，擋下每個 commit，且訊息沒有指出缺少 C 編譯器（與 #97 同類，未另開）；wiremock 的 `pmdMain` 不存在、commons-csv 的 `spotless` prefix 不存在，都是 `settings` 層對遠端 parent POM 與 `buildSrc` 慣例 plugin 保守不判斷所致，訊息已有原因。

### 3.4 提示與工具鏈支援

- **PDM 與 PEP 751 的支援**：#213（`pdm.lock`、`pylock.toml` 不被認得，`deps/lockfile-missing` 要求 `uv.lock`，缺工具提示 `uv add --dev`，在 PDM 專案會把依賴搬到 uv）。
- **元件有自己的 `pyproject.toml` 卻沒有專案環境**：#214（build 的 fixture 元件，缺工具被報成每個元件 4 筆 `tool-failed`、沒有安裝提示）。

### 3.5 效能：耗時隨檔案數線性成長

#205 修正後，完整 staged 時 Python、Java 與 ajv 的 pre-commit 耗時都持平，但仍有兩條逐檔的路徑：#209（Prettier 對每個不符的檔案多跑一次）與 #216（Go 對每個 staged 檔案各啟動一次 `golangci-lint fmt --stdin`）。細節見第 4 節。

---

## 4. 效能

各專案的完整表格與直接執行工具的對照在第 7 節各語言的「效能」。此處彙整，數字皆為 wall-clock 秒的中位數。

### 4.1 各步驟耗時

| 步驟 | TypeScript（p-queue／pinia／ajv） | Python（marko／pipdeptree／build） | Go（local-path／lazygit／go-sqlite3） | Java（jsoup／commons-csv／wiremock） |
| :--- | :--- | :--- | :--- | :--- |
| draft | 0.2／0.5／0.2 | 0.23／0.17／0.25 | 0.4／0.3／0.1 | 0.2／0.2／0.2 |
| check（修正前） | 8.3／1.5（exit 2）／11.2 | 4.0（冷）／3.1／4.8 | 3.9／3.1／3.4 | 0.3／0.9（exit 2）／135.2（冷 264.9） |
| fix --yes | 0.3／0.5／0.3 | 0.29／0.33／0.42 | 1.3／0.7／0.3 | 0.3／0.6／0.7 |
| check（修正後） | 8.3／1.7（exit 2）／11.4 | 0.89／2.2／2.7 | 4.0／28.3（冷 52.3）／2.7 | 0.4／15.2／13.8 |
| check --full | 8.5／1.6／11.5（皆 exit 2） | 30.0／3.0／358.8 | 7.7／65.1／2.0 | 36.9／18.0／236.0 |
| install --yes | 0.3／0.3／0.4 | 0.34／0.39／0.58 | 0.3／0.3／0.3 | 0.3／0.5／0.3 |
| doctor（install 後） | 8.8／1.9／11.3 | 1.2／1.3／2.5 | 4.9／3.7／1.9 | 1.1／10.4／22.5 |
| pre-commit | 1.9／0.3／2.8（皆擋下） | 1.6／1.5／1.5（皆擋下） | 5.7／2.6／1.6 | 0.3／9.8／22.0 |
| pre-push 預設 | 0.4／0.6／0.3 | 1.0／1.0／1.2 | 0.6／0.4／0.4 | 0.3／0.5／0.4 |
| pre-push `DEVGUARD_PRE_PUSH=full` | 0.2／13.6／0.2 | 28.7／2.5／350.5 | 4.8／54.9／0.6 | 22.0／5.2／104.2 |

要點：

- **devguard 自己的步驟都很快**：`draft`、`fix --yes`、`install --yes` 與預設的 pre-push 在所有 12 個專案都在 1.3 秒以內（pre-push 的 1 秒左右是 Git 與 pre-commit 框架的啟動時間，預設不跑任何檢查）。
- **耗時主要是工具本身**：`check --full` 的時間幾乎等於直接執行測試（見 4.2）。第一次執行的冷啟動成本最大：wiremock 第一次 `check` 265 秒（Gradle distribution、`buildSrc`、依賴解析）、lazygit 在 `fix` 改了 `.golangci.yml` 後第一次 `check` 52 秒（golangci-lint 快取失效）。這些都是工具的首次成本，不是 devguard 的額外開銷。
- **`doctor` 會執行 code 層的檢查**：Java 的 `doctor` 約等於一次完整 `check`（wiremock 22.5 秒、commons-csv 10.4 秒），TypeScript 的 p-queue、ajv 也是（8.8、11.3 秒）。
- **元件數是 `check` 耗時的變因**：build 的 9 個元件讓 `check` 從單一元件的約 0.9 秒變成約 2.4 秒，約每個元件 0.2 秒；`draft` 把測試 fixture 目錄也當成元件（#214）時不只產生錯誤，也讓 `check` 慢 2–3 倍。

### 4.2 devguard 相對於直接執行工具的額外開銷

| 專案 | devguard | 直接執行 | 額外開銷 |
| :--- | :--- | :--- | :--- |
| marko `check --full` | 30.0 | 27.6 | 約 2.4（8%） |
| build `check --full` | 358.8 | 348.1 | 約 11（3%） |
| lazygit `check`（冷） | 66.4 | 64.5 | 約 2（3%） |
| lazygit `check`（暖） | 3.6 | 2.7 | 約 1（固定成本：行程啟動、`go mod tidy -diff`、`go env`） |
| jsoup `check --full`（暖） | 22.5 | 22.7 | 0 |
| ajv `check` | 11.2 | 9.4（最慢的 eslint） | 工具平行執行，沒有明顯額外開銷 |
| p-queue `check --only format` | 7.4 | 2.3（`prettier --check .`） | **約 5，來自 #209** |

唯一明顯超出直接執行工具的開銷是 #209。wiremock `check --full` 的 129.7 對直接 `gradlew test` 的 103.8，差的約 26 秒是同一次 Gradle 呼叫還包含 `spotlessCheck` 與其他 task，不是 devguard 自己的時間。

### 4.3 pre-commit 的擴展性（`check --staged`）

staged 檔案數為 1／10／25 個，每格 3 次中位數：

| 專案 | 1 個 | 10 個 | 25 個 | 判定 |
| :--- | :--- | :--- | :--- | :--- |
| ajv（TypeScript） | 2.3 | 2.6 | 2.9 | 持平（#205 的修正成立） |
| p-queue（TypeScript） | 1.8 | 4.5 | 8.1 | **線性成長**，約每個不符 Prettier 的檔案 0.3 秒（#209） |
| marko／pipdeptree／build（Python） | 0.82／0.85／0.66 | 0.75／0.72／0.67 | 0.88／0.72／0.74 | 持平 |
| jsoup／commons-csv／wiremock（Java） | 0.2／9.6／22.1 | 0.2／10.0／13.7 | 0.3／9.6／13.8 | 持平（對整個專案一次呼叫 Maven／Gradle） |
| lazygit（Go） | 1.4 | 4.0 | 6.5 | **線性成長**，約每個檔案 0.2 秒（#216） |
| go-sqlite3（Go） | 1.9 | 6.4 | 10.6 | **線性成長**，約每個檔案 0.35 秒（#216） |
| local-path-provisioner（Go） | 1.4 | 5.1 | 4.7 | 根元件只有 8 個 `.go`，10／25 個都是 8 個，所以持平 |

- **部分 staged（stage 後又修改同一個檔案）仍逐檔執行**：TypeScript（ajv）10 個檔案 9.8 秒對完整 staged 的 2.6 秒（ESLint `--stdin` 逐檔，約每檔 0.7 秒）、Python 10 個檔案 2.0–2.4 秒（約每檔 0.15 秒，Ruff `--stdin`）。這是文件已寫明的已知行為，只在同一個檔案同時有 staged 與未 staged 的修改時出現，沒有另開 issue。Java 與 Go 的部分 staged 與完整 staged 同級。
- **Go 的 1→25 個檔案成長 4.6–5.6 倍**，不符合 #205 預期的「固定成本只付一次」。直接逐檔執行 `golangci-lint fmt --stdin` 在 go-sqlite3 25 個檔案要 9.6 秒（devguard 10.6 秒），一次 `fmt --diff` 多個檔案只要 4.8 秒，所以額外開銷主要就是這些行程（#216）。
- **jsoup 的結果只代表 devguard 的固定成本**（約 0.2–0.3 秒）：pom 沒有可執行的 staged 工具。commons-csv、wiremock 的 staged 檢查都以 exit 1 結束，量到的是「工具失敗」路徑。

### 4.4 效能 issue 與未開 issue 的觀察

- **新開**：#209（Prettier 逐檔找行號）、#216（Go 逐檔 `fmt --stdin`）。
- **沒有另開**：部分 staged 的逐檔執行（已知行為）；Java 無論 staged 幾個檔案都是整個專案的 `spotlessCheck`，只改 1 行的 commit 在 wiremock 也要 13–22 秒（額外開銷小於或等於直接執行工具）；`check --full` 在 lazygit 上 run 間差異很大（41.5 到 140.8 秒），直接執行的 `go test` 也有同樣的離群值，原因未查明。
- **未量到**：TypeScript 完整的 `check --full`（#210）；Go `check` 的格式檢查比直接 `golangci-lint fmt --diff` 快很多（lazygit 3.5 對 65.0 秒），原因未深入追查。

---

## 5. Issue 索引

本輪新開 10 個 issue，全部標 `needs-triage`；沒有在既有 issue 補充留言。

| 語言 | 新開 | 標題 |
| :--- | :--- | :--- |
| TypeScript | #209 | Prettier 對每個不符的檔案多跑一次，check／pre-commit 耗時線性成長（效能） |
| TypeScript | #210 | 專案沒有標準要求的工具時 check 以 exit 2 中止，安裝提示無效 |
| TypeScript | #211 | `fix` 產生的 `.prettierrc`／`.vscode/*.json` 不符合 `.editorconfig` |
| TypeScript | #212 | ESLint 8 不認得 `--no-warn-ignored`，擋下每個 commit |
| Python | #213 | PDM 與 PEP 751 專案：`deps/lockfile-missing` 要求 `uv.lock`，提示 `uv add --dev`（enhancement） |
| Python | #214 | 元件有自己的 `pyproject.toml` 卻沒有專案環境：缺工具被報成 `tool-failed` |
| Python | #215 | `fix` 改寫 `pyproject.toml` 時動到無關行 |
| Go | #216 | pre-commit 對每個 staged 檔案各執行一次 `golangci-lint fmt --stdin`（效能） |
| Java | #217 | Maven 沒有 `mvnw` 但 pom 有 Checkstyle／PMD plugin：check exit 2 且沒有任何 finding |
| Java | #218 | 專案使用 Apache RAT 時，`fix`／`draft` 產生的檔案沒有授權標頭（enhancement） |

**建議優先處理**：

1. 擋下每個 commit 或讓檢查中止的：#210、#212、#217
2. 效能的線性成長：#209、#216
3. `fix` 的產出：#211、#215、#218
4. 工具鏈支援：#213、#214

---

## 6. 結論

- **Round 3 的修正在新專案上大致穩定**：#99（沒有 JaCoCo 時測試不跑）、#100（`fix` 覆寫 checkstyle.xml）、#117（安裝提示依套件管理器）、#126（既有 hook 的提示位置）、#89（`draft` 把 `.py` 資料當成元件）、#85（`.golangci.toml`，本輪的 `.golangci.json` 正確辨識）都沒有重現。
- **最大的實用性缺口是工具鏈多樣性**：專案用的工具與標準要求的不同時（oxfmt、xo、`node:test`、Mocha、PDM、`pylock.toml`、沒有 `mvnw`），devguard 常常是中止（#210、#217）或給出無效的安裝提示（#210、#213），而不是降級成可用的部分結果。
- **#205 的修正有效，但還有兩條逐檔的路徑**：Python、Java、ajv 的 pre-commit 耗時持平，Prettier 的格式 finding（#209）與 Go 的格式檢查（#216）仍線性成長，單檔 0.2–0.35 秒，在數十個 staged 檔案時才明顯。
- **devguard 自己的固定成本很小**：`draft`、`fix`、`install`、預設的 pre-push 都在 1.3 秒以內；`check --full` 對直接執行測試的額外開銷在 0–8%。冷啟動與工具本身的快取是耗時的最大變因。
- **下一輪建議**：修好 #210 之後重量 TypeScript 的完整 `check --full`；在 Linux 上重跑一部分專案作對照（#80）。

---

## 7. 各語言詳細紀錄

各表的欄位是 9 步的結果，格內為 `exit code｜finding 數與簡述`。各語言的「效能」小節保留各專案的完整量測表格。

### 7.1 TypeScript


devguard 0.5.2，Windows 11、Git for Windows（`core.autocrlf=false` clone）、Node 24.21.0、npm 11.19.0、pnpm 12.11.2（corepack shim）、Bun 1.4.4。三個專案的 `draft` 都寫入 `standard: team@1.4.0`，沒有 TODO 理由，沒有手動修改草稿。
本輪挑的是前三輪沒測過的工具鏈：**xo + `node:test`**（沒有 ESLint 設定、Prettier、Vitest／Jest）、**pnpm workspace + oxfmt + simple-git-hooks**（沒有 ESLint／Prettier）、**ESLint 8 `.eslintrc.js` + Prettier 3 + Mocha + ts-node + git submodule 的 npm 專案（`package-lock=false`，沒有 lockfile）**。
流程：clone → `draft` → 安裝依賴前 `doctor` → 安裝依賴 → `check`（2 次）→ `fix --yes`（2 次，第二次先還原）→ `check`（2 次）→ `check --full`（2 次）→ `install --yes` → `doctor` → `git commit`（pre-commit）→ `git push local`（預設與 `DEVGUARD_PRE_PUSH=full` 各 2 次，每次推到不同分支，推到本機 bare remote）。
格內 `exit｜E 錯誤 D 偏離 H 提示`。

| # | 專案 | SHA | 結構／工具鏈特徵 | 標準 | draft | check 前 | fix --yes | check 後 | check --full | install | doctor | pre-commit | pre-push |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | sindresorhus/p-queue | `7f272ab5ff2254c0dc2537b7977e88ede1cd55e8` | npm（`package-lock=false`，無 lockfile）、**xo**（`package.json` 的 `xo` 欄位）、**`node:test` + tsx**、`.editorconfig` tab 縮排、TypeScript 6、`engines.node >=22` | team@1.4.0 | 0｜1 元件（`./`），無 override | 1｜23E 0D 0H（缺 lockfile、缺 ESLint flat config／Vitest 設定、eslint tool-failed、19 筆 prettier 主因 tab 縮排） | 0｜只建 `.prettierrc`（printWidth 120）、`.vscode/`；不改 tsconfig（已符合） | 1｜25E（新增 4 筆是 fix 自己產生的檔案，#211） | 2｜`找不到 vitest：node_modules 中沒有安裝`，中止（專案用 `node:test`，#210） | 0｜`.git/hooks/` 兩個 hook + `.claude/` | 1｜26E 0D 2H | 1｜擋下：1E（eslint tool-failed，找不到 flat config） | 0 放行；full：1｜擋下，`找不到 vitest`（#210） |
| 2 | vuejs/pinia | `4817135a25431172d363bd928476db7cdbf875c4` | **pnpm workspace**（9 個元件）、**oxfmt**（`.oxfmtrc.json`）、**simple-git-hooks**（`pre-commit` 跑 `pnpm lint-staged`、`commit-msg` 驗證格式）、Vitest 5、Nuxt 子專案、`packageManager: pnpm@12.11.2` | team@1.4.0 | 0｜9 元件，全部 `deps.manager: pnpm` | **2｜`找不到 eslint：node_modules 中沒有安裝` 中止，完全沒有其他 finding**（專案沒有 ESLint，#210）；`--only typecheck` 有 304E、`--only format` 同樣 `找不到 prettier` | 0｜14 個檔案：9 個元件 `package.json` 加 `engines.node`、tsconfig 加選項、9 個 `.prettierrc`、`.vscode/` 合併 | 2｜同上 | 2｜同上 | 1｜既有的 `.git/hooks/pre-commit`（simple-git-hooks）「不會覆寫，請加在開頭」，已套用但 exit 1；pre-push 正常寫入；照提示手動加在開頭 | 1｜13E 0D 16H（含 `hook-foreign` 直到手動加入） | 1｜加入 devguard 行之後：`找不到 eslint` 擋下（#210）；加入之前 commit 沒有到 devguard，只被 `commit-msg` 驗證訊息格式擋 | 0 放行；full：1｜擋下：`test/failed` 3 個 nuxt 測試檔、`coverage/no-report`（直接執行 `vitest run` 同樣 3 個檔案失敗，屬專案／環境） |
| 3 | ajv-validator/ajv | `f177fe323420ccb23e1a79445fd470cbf80aee7c`（`--depth 1`；完整 clone 兩次 `invalid index-pack output`） | npm（`package-lock=false`，無 lockfile）、**ESLint 8 `.eslintrc.js`**、Prettier 3.0.3、**Mocha + ts-node + nyc**、Karma、rollup、git submodule（`JSON-Schema-Test-Suite`）、`spec/` 有自己的 tsconfig | team@1.4.0 | 0｜2 元件（`./`、`spec/`） | 1｜23E 0D 4H（缺 lockfile 兩個元件、`node-fetch` 禁用、eslint `--warn-ignored` tool-failed、prettier 解析 `.vue` 失敗、99 筆 tsc 在 fix 之後） | 0｜`package.json` 加 `engines.node`、兩個 tsconfig 加選項、`.gitattributes`、`.vscode/` | 1｜109E 0D 4H（tsconfig 新選項帶出約 99 筆 tsc：`noUncheckedIndexedAccess`、`noImplicitOverride`） | 2｜`找不到 vitest`，中止（專案用 Mocha，#210） | 0｜`.git/hooks/` 兩個 hook + `.claude/` | 1｜109E 0D 6H | 1｜擋下：1E（eslint `Invalid option '--warn-ignored'`，任何 commit 都會，#212） | 0 放行；full：1｜擋下：`找不到 vitest`（#210） |

#### sindresorhus/p-queue
- 安裝依賴前的 `doctor`：`找不到 eslint：node_modules 中沒有安裝 … 需手動修正：npm install`（6E）。`npm ci` 因為沒有 lockfile 而失敗（專案的 `.npmrc` 是 `package-lock=false`），改用 `npm install`。
- `check`：xo 是 ESLint flat 的包裝，專案沒有 `eslint.config.*`，所以 `settings/missing-file` + eslint 以 exit 2 失敗（`ESLint couldn't find an eslint.config.* file`，直接執行 `eslint` 結果相同）；devguard 不認得 xo，屬標準不符，不算 devguard 的問題。`vitest.config.ts` 缺少同理（專案用 `node:test`）。
- Prettier 19 筆：專案是 tab 縮排＋xo 風格，與 Prettier 預設不符（直接執行 `prettier --check .` 同樣 18 個檔案），不是誤報。這 19 筆也是下面「效能」中耗時隨 finding 數成長的來源（#209）。
- `fix --yes`：建立 `.prettierrc`（`printWidth: 120`、`endOfLine: lf`，來自 `.editorconfig` 以外的推斷）與 `.vscode/`，**這些新檔案用 2 空白縮排，專案 `.editorconfig` 是 tab，所以 `check` 之後多 4 筆 `prettier/format`（#211）**。
- `check --full`：`找不到 vitest：node_modules 中沒有安裝 / 安裝：npm install` 然後 exit 2（專案測試是 `node --test`，直接執行 46 秒通過）；devguard 不支援 `node:test`（無此需求，但中止本身是 #210）。
- `install`：兩個 hook 與 `.claude/` 正常；第二次 `install` 為冪等。
- pre-commit：任何 commit 都被 eslint `tool-failed` 擋下（缺 flat config）；用 `--no-verify` 前進。pre-push：預設放行；`full` 因缺 vitest 擋下。

#### vuejs/pinia
- `draft`：pnpm workspace 推出 9 個元件（含 `packages/nuxt/playground/`、`packages/pinia/test-dts/`），全部 `deps.manager: pnpm`，`pnpm-lock.yaml` 的工具版本都讀得出來。依賴安裝（`pnpm install --frozen-lockfile`）在本機網路下 47 分鐘。
- 安裝依賴前的 `doctor`：71E，缺工具提示 `pnpm install --frozen-lockfile`（#117 已修，提示正確）。
- **`check` 以 exit 2 中止**：專案用 oxfmt、沒有 ESLint／Prettier，標準要求的工具缺少 → `找不到 eslint：node_modules 中沒有安裝 / 安裝：pnpm install --frozen-lockfile`，沒有任何其他 finding；剛裝完依賴所以這個提示無效。`check --only typecheck` 可執行（304E，直接 `tsc` 對照屬專案／環境：docs 與 nuxt 需先 `dev:prepare`）；`--only format` 則 `找不到 prettier`（#210）。
- `fix --yes`：每個元件 `package.json` 補 `engines.node`、每個元件新增 `.prettierrc`（專案用 oxfmt，格式化設定在 `.oxfmtrc.json`）、`.vscode/settings.json` 加入 ESLint／Prettier 的 VS Code 設定（合併保留）；`packages/nuxt/tsconfig.json` 把專案明確寫的 `"noUncheckedIndexedAccess": false` 改成 `true`（標準規定，符合設計）。
- `install`：simple-git-hooks 的 `.git/hooks/pre-commit` 與 `commit-msg` 是既有的非 devguard hook，`install` 印出「加在開頭」的一行並 exit 1；`pre-push` 由 devguard 寫入。手動把那一行加在 shebang 後面才生效（#126 已修，提示位置正確）。加入前 `git commit` 完全不經 devguard，只被專案的 `commit-msg` 擋下格式不對的訊息。
- pre-commit：加入後，每個 commit 都被 `找不到 eslint` 擋下（0.3 秒），原因同上（#210）。
- pre-push：預設放行；`full`：3 個 nuxt 測試檔失敗（直接 `vitest run --coverage` 同樣失敗：`3 failed | 32 passed`）。

#### ajv-validator/ajv
- 專案 `.npmrc` 是 `package-lock=false`，所以兩個元件都是 `deps/lockfile-missing`，也沒有 `tool-version` 的資料來源：ESLint 8.57.1、TypeScript 5.3.3 的版本不會被回報。
- `eslint` 一律 `Invalid option '--warn-ignored'`（ESLint 8 沒有 `--no-warn-ignored`），沒有說明是版本問題，**擋下每個 commit**（#212；直接執行 `eslint --no-warn-ignored` 同樣失敗）。
- Prettier 3.0.3 解析 `docs/.vuepress/theme/components/NavLinks.vue` 失敗（專案檔案本身 HTML 不合法；直接 `prettier --check .` 也 exit 2），devguard 把它報成 `code/tool-failed`，屬專案問題。
- `package.json` 的 `node-fetch` 被 `deps/banned` 擋下（標準的禁用清單，符合設計）。
- `fix --yes`：加 `engines.node`、兩個 tsconfig 加 `noUncheckedIndexedAccess`／`noImplicitOverride`，帶出約 99 筆 tsc 錯誤（專案本身會因這些選項而失敗，不是誤報）。`.gitignore` 與 `.gitattributes` 處理正常。
- `check --full`：`找不到 vitest`，中止（專案用 Mocha，#210）。
- 完整 `git clone` 兩次 `fatal: fetch-pack: invalid index-pack output`，改用 `--depth 1`，`receive.shallowUpdate true` 後推到本機 bare remote 成功。

#### 效能

環境：Windows 11、Core i7-1165G7（4 核 8 緒）、64 GB RAM、SSD；`node_modules` 與 npm／pnpm 快取在本機；網路很慢（約 20–50 KiB/s，所以依賴安裝時間不代表工具）。每格 wall-clock 至少 2 次取中位數（2 次時為兩次平均）。**「冷」＝該專案該指令第一次執行**，**「暖」＝緊接著第二次**；`check` 的冷暖差異在這三個專案都 ≤ 0.6 秒，所以只列中位數。機器除了這些量測沒有其他負載，量測之間沒有平行執行。

**各步驟耗時（秒）**

| 步驟 | p-queue | pinia | ajv |
|---|---|---|---|
| draft | 0.2（1 次） | 0.5（1 次） | 0.2（1 次） |
| doctor（安裝依賴前） | 0.5（1 次） | 1.7（1 次） | 0.5（1 次） |
| check（修正前） | 8.3（8.3／8.4，冷／暖） | 1.5（exit 2 中止） | 11.2（10.9／11.5） |
| fix --yes | 0.3（0.27／0.26） | 0.5（0.42／0.52） | 0.3（0.34／0.36） |
| check（修正後） | 8.3 | 1.7（exit 2 中止） | 11.4 |
| check --full | 8.5（exit 2，缺 vitest） | 1.6（exit 2，缺 eslint） | 11.5（exit 2，缺 vitest） |
| install --yes | 0.3 | 0.3 | 0.4 |
| doctor | 8.8 | 1.9 | 11.3 |
| pre-commit（被擋的 `git commit`，含 git） | 1.9 | 0.3（缺 eslint 擋下） | 2.8 |
| pre-push 預設 | 0.4 | 0.6 | 0.3 |
| pre-push `DEVGUARD_PRE_PUSH=full` | 0.2（缺 vitest 擋下） | 13.6（跑完 vitest） | 0.2（缺 vitest 擋下） |

`check --full` 在 p-queue、ajv 因缺 vitest 中止，pinia 因缺 eslint 中止（#210），所以這三個專案都沒有量到完整 code＋測試＋覆蓋率的耗時，只有 pinia 的 `full` pre-push 實際跑了 vitest。

**耗時拆解（直接執行工具對照，秒）**

| 專案 | 直接執行 | devguard | 說明 |
|---|---|---|---|
| p-queue | `tsc --noEmit` 2.0、`eslint .` 1.7、`prettier --check .` 2.3（三個加起來約 6） | `check` 8.3：`--only format` 7.0／7.8、`--only lint` 0.6、`--only typecheck` 1.1 | **format 7.4 vs 直接 2.3：多出的約 5 秒是對 19 個不符的檔案各多跑一次 `prettier <file>` 找行號（每次約 0.27 秒，#209）**；lint、typecheck 與直接執行相當 |
| ajv | `tsc --noEmit` 2.5、`eslint`（專案 script 範圍）9.4、`prettier --check .` 5.5（含失敗） | `check` 11.2 | 與工具本身相當（devguard 平行跑各工具，11.2 秒 ≈ 最慢的 eslint 9.4 + 啟動）；沒有明顯額外開銷 |
| pinia | `vitest run --coverage` 7.2／8.1、`tsc --noEmit -p tsconfig.json` 2.3／2.7 | pre-push full 13.6 | 約 5 秒是 `check` 的其餘 layer 與 workspace 其他元件，沒有異常 |
| p-queue（對照） | `node --test` 46、`xo` 6.1／12.5（冷） | — | 專案本身的測試與 lint 慢；devguard 不跑這兩個，所以不在 `check`／pre-commit 的耗時內 |

**pre-commit 擴展性：`check --staged`（秒，每格 3 次中位數，每個檔案附加一行註解後 stage）**

| 專案 | 1 個 | 10 個 | 25 個 | 部分 staged 10 個（stage 後再改一行） | 部分 staged 1 個 |
|---|---|---|---|---|---|
| p-queue | 1.8 | 4.5 | 8.1（**實際只有 19 個符合的檔案**；專案只有 16 個 `.ts` + `readme.md` 等） | 7.8 | 1.7 |
| ajv | 2.3 | 2.6 | 2.9（25 個） | **9.8** | 2.6 |
| pinia | 0.2（exit 2 中止） | 0.2 | 0.2 | — | — |

- #205 的修正在 ajv 上成立：staged 1→10→25 個檔案是 2.3→2.6→2.9 秒，幾乎持平。
- **p-queue 仍隨檔案數線性成長（1.8→4.5→8.1 秒，約每檔 0.3 秒）**。原因不是 staged 檔案數，而是**不符合 Prettier 的檔案數**：每個格式 finding 多跑一次 `prettier <file>` 找第一個差異行（`check --only format` 同樣 7.4 vs 直接 2.3 秒）。在不用 Prettier 的專案（xo、oxfmt 的專案）這是常態（#209）。
- 部分 staged 仍逐檔：ajv 10 個部分 staged 檔案 9.8 秒（vs 同樣 10 個完整 staged 2.6 秒），約每檔 0.7 秒（ESLint `--stdin` 逐檔）；1 個檔案只有 2.6 秒，所以是逐檔的固定成本。與文件寫明的已知行為一致，沒有另開 issue；p-queue 同一組 7.8 vs 4.5 秒。
- pinia 的 `check --staged` 因缺 eslint 以 exit 2 中止（0.2 秒），沒有量到有意義的擴展性（#210）。

**跨專案的觀察**
- 三個專案都沒有量到「完整」的 `check --full`（#210 讓它們中止）；這也是這一輪最大的實用性問題。
- devguard 的固定成本很小（`draft`／`fix`／`install`／pre-push 預設都在 1 秒以內）；耗時主要是工具本身（ESLint、Prettier、tsc）。唯一明顯的額外開銷是 #209。
- 冷暖差異不明顯（Node 工具沒有 devguard 自己的快取）；p-queue 的 `xo` 冷 12.5 秒、暖 6.1 秒，是工具本身的快取。

#### 發現的問題
- #209 Prettier 格式檢查對每個不符合的檔案各多跑一次 prettier 找行號：check／pre-commit 耗時隨格式 finding 數線性成長 — 新開（效能，附量測）
- #210 專案沒有標準要求的工具（oxfmt／xo／node:test 專案缺 eslint、prettier、vitest）時，check 以 exit 2 中止、安裝提示無效，擋下每個 commit／push — 新開
- #211 `fix` 產生的 `.prettierrc`／`.vscode/*.json` 不符合專案 `.editorconfig`（tab 縮排），下一次 check 報成 prettier/format — 新開
- #212 ESLint 8：傳入 `--no-warn-ignored` 使 eslint exit 2，只剩 tool-failed；沒有 lockfile 時沒有 tool-version 說明，擋下每個 commit — 新開
- 前幾輪已修的 #117（安裝提示依套件管理器）、#126（既有 hook 的提示位置）在 pinia 上行為正確，沒有重現。

#### 環境備註
- 使用者範圍安裝：pnpm 12.21.0 shim（`corepack enable pnpm`，依 `packageManager` 下載 pnpm 12.11.2）。其餘工具（Node、npm、Bun、git）原本就有。
- 安裝依賴前的 `doctor`：p-queue 6E、ajv 12E（`找不到 eslint … npm install`），pinia 71E（提示 `pnpm install --frozen-lockfile`）。
- 依賴安裝：p-queue、ajv 的 `.npmrc` 是 `package-lock=false`，`npm ci` 失敗（`EUSAGE`，沒有 lockfile），改用 `npm install --no-package-lock`；因為網路逾時（`ETIMEDOUT`）加了 `--fetch-retries=5 --fetch-timeout=120000` 才完成。pinia `pnpm install --frozen-lockfile` 47 分鐘。

### 7.2 Python


devguard 0.5.2，Windows 11 Home、Git for Windows（`core.autocrlf=false` clone）、Core i7-1165G7（4 核 8 緒）、Python 3.14.7、uv 0.10.8、pre-commit 4.6.2。三個專案的 `draft` 都寫入 `standard: team@1.4.0`。

本輪挑的是前三輪沒測過的 Python 工具鏈：**PDM**（`pdm.lock`、`pdm-backend`，hook 是 black＋flake8＋isort＋mypy）、**Rust／meson 混合建置**（`meson-python`＋`scikit-build-core`，只有 PEP 751 `pylock.toml`、`[dependency-groups]`，pre-commit 設定用了框架不認得的 `priority` 欄位）、**flit-core、沒有任何 lockfile、巢狀的測試 fixture 套件**（`tests/packages/*` 各有 `pyproject.toml`，`draft` 產生 9 個元件）。三個專案都有 pre-commit 框架，且都用 `tox.toml`／`noxfile.py` 而不是 `uv`。前三輪的 Python 專案是 uv、Poetry、只有 `requirements.txt`，沒有 PDM、PEP 751、flit。

流程：clone → `draft` → 安裝依賴前 `doctor` → 建立專案內 `.venv`（`uv venv`＋`uv pip install`）→ `check`（2 次）→ `fix --yes`（2 次，第二次先還原）→ `check`（2 次）→ `check --full`（2 次）→ `install --yes`（2 次）→ `doctor`（2 次）→ `pre-commit install --hook-type pre-commit --hook-type pre-push` → `git commit`（pre-commit，2 次）→ `git push local`（預設與 `DEVGUARD_PRE_PUSH=full` 各 2 次，每次推不同的新 commit 到不同分支，推到本機 bare remote）。

- 專案自己的 pre-commit 框架 hook 全部用 `SKIP=` 略過（它們要從 GitHub 建立各自的環境，與 devguard 無關），只觀察 devguard 的 hook 項目 `devguard`／`devguard-pre-push`。
- devguard 擋下 commit（exit 1）時用 `--no-verify` 前進到 push 步驟。pre-push 前一律先有新 commit：pre-commit 框架發現要推的 commit 已經在遠端的另一個分支時，完全不執行任何 hook，推同一個 commit 到第二個分支看起來「0.6 秒通過」是假象（第一輪腳本踩到，已重跑）。
- `install` 修改了 `.pre-commit-config.yaml`，框架要求先 `git add` 才肯 commit（`Your pre-commit configuration is unstaged`），這是框架行為，不是 devguard 的問題。

格內 `exit｜E 錯誤 D 偏離 H 提示`。

| # | 專案 | SHA | 結構／工具鏈特徵 | 標準 | draft | check 前 | fix --yes | check 後 | check --full | install | doctor | pre-commit | pre-push |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | frostming/marko | `5611794991268c5a77dc4cc98cc369525b50d356` | **PDM**（`pdm.lock`、`pdm-backend`）、`setup.cfg`（flake8／isort／coverage）、pre-commit 框架（black、flake8、isort、mypy） | team@1.4.0 | 0｜1 個元件，2 個 TODO 理由（`python.minVersion` 3.10、`typecheck.strict` false）已填 | 1｜56E 2D 1H | 0｜改 `pyproject.toml`（`[tool.ruff]`、coverage branch）、新增 `.gitattributes`、`.vscode/settings.json` | 1｜87E 2D 1H | 1｜87E 2D 1H（測試 1,648 個全過） | 0｜改 `.pre-commit-config.yaml`、新增 `.claude/` | 1｜88E 2D 4H → 執行 `pre-commit install` 後 `framework-not-installed` 消失 | 1｜7E 2D（擋下 commit） | 預設 0；full 0（測試過） |
| 2 | tox-dev/pipdeptree | `0258069fa6b15083e855825b62b56f727e2cf582` | **Rust／meson 混合建置**（`meson-python`、`scikit-build-core`）、只有 `pylock.toml`、`[dependency-groups]`、`tox.toml`、pre-commit（`prek` 風格，含 `priority` 欄位） | team@1.4.0 | 0｜1 個元件 | 1｜13E 1H | 0｜改 `pyproject.toml`（per-file-ignores、coverage branch、`[tool.mypy]`）、新增 `.gitattributes`、`.vscode/` | 1｜10E 1H | 1｜11E 1H（pytest 收集失敗，見下） | 0｜改 `.pre-commit-config.yaml`、新增 `.claude/` | 1｜11E 4H | 1｜9E（擋下 commit） | 預設 0；full 1（1E，pytest 收集失敗，擋下 push） |
| 3 | pypa/build | `9a03927a4b0afe33ce40dbe5f36bf3bdbc612385` | **flit-core、沒有 lockfile**、`src/` 佈局、`tox.toml`、`tests/packages/*` 7 個 fixture 套件各有 `pyproject.toml`、pre-commit（24 個 hook） | team@1.4.0 | 0｜9 個元件（根目錄＋7 個 fixture＋`tests/packages/legacy/`），未修改草稿 | 1｜57E 9H | 0｜改根目錄與 7 個 fixture 的 `pyproject.toml`、新增 `.gitattributes`、`.vscode/` | 1｜38E 9H | 1｜48E 9H（71 個測試失敗，約 6 分鐘） | 0｜改 `.pre-commit-config.yaml`、新增 `.claude/` | 1｜39E 12H | 1｜10E（擋下 commit） | 預設 0；full 1（10E，測試失敗，擋下 push） |

#### frostming/marko
- **draft**：只有 `[tool.mypy.overrides]`、沒有 `[tool.ruff]`，所以 `draft` 沒有推出行寬；`python.minVersion` 與 `typecheck.strict` 因為專案支援 3.10、沒有 strict 而產生 TODO 理由，填寫後才跑 `check`。
- **doctor（安裝依賴前）**：7E 2D 3H。`環境/tool-missing`：「找不到 ruff：專案環境中沒有安裝」，提示 `uv add --dev "ruff>=0.17,<1"`。在 PDM 專案這個提示會把依賴搬到 uv，而且 `沒有提交 uv.lock` 也不是事實（有 `pdm.lock`）：**#213**。
- **check 前／fix／check 後**：`fix` 補了 `[tool.ruff]`（`line-length = 120`、標準的規則組）與 `[tool.coverage.run] branch = true`，因此 check 後的 ruff finding 從 56 增加到 87：沒有 `[tool.ruff]` 時 Ruff 只用預設規則，補上標準規則組後 `UP`、`B`、`SIM`、`S`、`N`、`C90` 才開始檢查，這是預期行為。其中 22 筆 `ruff/format` 來自專案用 black（行寬 88）、標準用 Ruff 行寬 120。
- **check --full**：1,648 個測試全過、覆蓋率達標，沒有 test／coverage finding。直接執行 `pytest --cov --cov-branch` 同樣 1,648 passed。mypy 的 2 筆（`noxfile.py` 的 `import nox`、`docs/conf.py` 的 `latex_elements`）與直接執行 `mypy .` 一致（nox 是本輪沒安裝的專案開發依賴）。
- **install／doctor**：`install` 在 `.pre-commit-config.yaml` 加兩個 `repo: local` 的 devguard 項目與 `minimum_pre_commit_version`／`default_stages`，第二次執行是「沒有需要修正的設定」。`install` 提示要自己執行 `pre-commit install --hook-type pre-commit --hook-type pre-push`；執行後 `doctor` 不再回報 `framework-not-installed`。
- **pre-commit**：改 `marko/helpers.py` 一行後 commit，7E 2D 擋下（`ruff/UP035` 等，都是該檔案本來就有的 finding）。
- **pre-push**：預設 1.0 秒、不跑檢查；`DEVGUARD_PRE_PUSH=full` 28.7 秒，跑完 1,648 個測試後通過。

#### tox-dev/pipdeptree
- **draft／doctor（安裝依賴前）**：沒有 `uv.lock`，`pylock.toml` 不被認得，回報 `沒有提交 uv.lock`：**#213**。
- **check 前／fix／check 後**：`fix` 補 `lint.per-file-ignores`（以 dotted key 加在 `[tool.ruff]` 下，沒有另開表頭，#105 的情況正常）、`run.branch = true`、`[tool.mypy] strict = true`。check 後剩 10E：`mypy` 對 `tools/version.py` 的 6 筆 `Final` 錯誤、`tests/test_extras_memory.py` 的 `wait4`（Windows 沒有）與 `no-any-return`、`ruff/RUF100`、`deps/lockfile-missing`，與直接執行 `ruff`、`mypy .` 一致。
- **check --full**：`pytest` 在收集階段失敗（4 個 error）：專案需要 Rust／meson 建置才能 import `pipdeptree`，本輪沒有建置，這是環境限制；直接執行 `uv run --no-sync pytest` 同樣 exit 2。devguard 以 `test/tool-failed` 回報，訊息帶 pytest 輸出，不誤導。
- **pre-commit**：9E 擋下。`pre-commit` 框架印出 15 行 `Unexpected key(s) present … priority` 警告，來自專案自己的設定（`prek` 的欄位），與 devguard 無關。
- **pre-push**：預設 1.0 秒、不跑檢查；`DEVGUARD_PRE_PUSH=full` 2.5 秒，pytest 收集失敗 → 1E，push 被擋下（exit 1）。

#### pypa/build
- **draft**：把 `tests/packages/` 下的 7 個測試 fixture 套件（各有 `pyproject.toml`）加上 `tests/packages/legacy/`（只有 `setup.py`）當成元件，共 9 個元件，`format.lineLength: 127` 是從根目錄 `pyproject.toml` 的 `[tool.ruff]` 推得並套用到每一個元件。沒有手動修改草稿（比照使用者直接接受草稿）。
- **check 前**：57E 9H。其中 fixture 元件的 `settings/target-version-missing`（7 筆，上層共用的設定不會被 `fix` 修改）、`deps/lockfile-missing`（9 筆）、`code/tool-failed`（21 筆）：每個有自己 `pyproject.toml` 的 fixture 元件，`uv run --no-sync` 以該目錄為 uv 專案而找不到 ruff／mypy／pytest（exit 2，`Failed to spawn`），devguard 沒有回報 `tool-missing` 與安裝提示：**#214**。`uv run --no-sync` 還在每個 fixture 目錄建了空的 `.venv`。
- **fix**：改了根目錄與 7 個 fixture 的 `pyproject.toml`（`[tool.mypy]`、`run.branch`），同時**無關地改了 `filterwarnings` 最後一個元素的行尾註解空白**：**#215**。
- **check --full**：根元件的 pytest 跑完 `71 failed, 248 passed, 49 skipped`，約 6 分鐘；直接執行 `pytest --cov --cov-branch` 同樣 `71 failed, 248 passed`。失敗原因是這台機器上 `NO_COLOR`／`FORCE_COLOR` 同時設定造成的 `UserWarning`（`test_parse_args` 等）與其他環境因素，與 devguard 無關。`tests/packages/legacy/` 元件沒有收集到任何測試，卻被報 `coverage/lines 36.7%`、`coverage/branches 4.8%`：pytest 沿用根目錄的設定，涵蓋的是根目錄的 `src/`；fixture 元件的覆蓋率沒有意義，歸入 #214 的 fixture 元件問題，未另開。
- **pre-commit**：10E 擋下；**pre-push**：預設 1.2 秒；`DEVGUARD_PRE_PUSH=full` 約 350 秒，測試失敗，push 被擋下。

#### 發現的問題
- #213 PDM（`pdm.lock`）與 PEP 751 `pylock.toml` 專案：`deps/lockfile-missing` 要求 `uv.lock`，缺工具時提示 `uv add --dev` — 新開（enhancement）。marko、pipdeptree。
- #214 Python 元件有自己的 `pyproject.toml` 卻沒有專案環境：缺工具被報成每個元件 4 筆 `tool-failed`，沒有 `tool-missing` 與安裝提示 — 新開（bug）。build 的 fixture 元件。
- #215 `fix` 改寫 `pyproject.toml` 時動到無關行：陣列最後一個元素的行尾註解空白多一格 — 新開（bug），與 #87、#111 同類。build。

#### 效能

環境：Windows 11 Home、Core i7-1165G7（4 核 8 緒）、64 GB。devguard 0.5.2（`npm run build:exe` 的 Windows x64 exe）。Python 3.14.7、uv 0.10.8、Ruff 0.17.4／0.17.5、mypy 2.4.1、pytest＋pytest-cov。專案內 `.venv`。每格至少 2 次，表中是中位數（秒）；「冷／暖」：第一次是 mypy 快取還不存在（或設定剛被 `fix` 改動）的冷啟動，之後是暖。同時間機器沒有其他工作；`check` 時 ruff／mypy／pytest 共用同一個 `.venv`。

###### 各步驟耗時（秒）

| 步驟 | marko | pipdeptree | build（9 個元件） |
|---|---|---|---|
| draft | 0.23 | 0.17 | 0.25 |
| doctor（安裝依賴前） | 0.51 | 0.54 | 0.66 |
| check 前（冷／暖） | 4.0／0.94 | 3.1／0.79 | 4.8／2.1 |
| fix --yes | 0.29 | 0.33 | 0.42 |
| check 後（冷／暖） | 0.89／0.92 | 2.2／0.87 | 2.7／2.4 |
| check --full | 30.0 | 3.0 | 358.8 |
| install --yes | 0.34 | 0.39 | 0.58 |
| doctor（安裝後） | 1.2 | 1.3 | 2.5 |
| pre-commit（`git commit`，只算 devguard hook，被擋下） | 1.6 | 1.5 | 1.5 |
| pre-push（預設，新 commit） | 1.0 | 1.0 | 1.2 |
| pre-push（`DEVGUARD_PRE_PUSH=full`） | 28.7 | 2.5（被擋下） | 350.5（被擋下） |

觀察：
- `check`「冷」比「暖」慢約 1–4 倍；`fix` 後設定檔變動，pipdeptree 與 build 的 check 後第一次也偏慢。
- `doctor` 約為 `check` 的 1.3–2 倍。
- pre-push 預設不跑任何檢查（約 1 秒是 Git 與 pre-commit 框架的啟動時間）；`full` 的耗時是測試本身。

###### 耗時拆解：devguard 與直接執行工具

直接執行用的是 devguard 同樣的指令（`uv run --no-sync <tool>`）：

| 專案 | `ruff check` | `ruff format --diff` | `mypy .` | `pytest --cov --cov-branch` | 直接合計 | devguard `check` | devguard `check --full` |
|---|---|---|---|---|---|---|---|
| marko | 0.12 | 0.11 | 0.71 | 26.7 | 27.6 | 0.92 | 30.0 |
| pipdeptree | 0.10 | 0.09 | 0.41 | 1.14（收集失敗） | 1.7 | 0.87 | 3.0 |
| build | 0.10 | 0.10 | 0.38（整個 repo 會因重複模組失敗，改以元件為單位） | 347.5 | 348.1 | 2.4 | 358.8 |

- marko：`check`（0.92）與直接跑 Ruff＋format＋mypy（0.94）相同，devguard 沒有額外開銷；`--full` 多出約 2.4 秒（約 8%），未進一步拆解（沒有逐項量測），量級可以接受。
- pipdeptree：`check` 0.87 對直接的 0.6，多約 0.3 秒；`--full` 3.0 對 1.7，多約 1.3 秒（未拆解）。絕對值小。
- build：`--full` 358.8 對 347.5＋0.6，多約 11 秒（3%），其中約 2.5 秒是 `check` 部分，其餘是 9 個元件各自的 `uv run --no-sync` 啟動與 fixture 元件的失敗處理；兩次直接 pytest 之間本身就差 0.7 秒。工具本身（pytest 5 分 47 秒，約 370 個測試含 49 個略過）佔 97%，**這不是 devguard 的額外開銷**。
- 多元件：build 的 9 個元件讓 `check` 從單一元件的約 0.9 秒變成約 2.4 秒，約每個元件 0.2 秒（每個元件各啟動 3 次 `uv run`）。

###### pre-commit 擴展性（`check --staged`，秒，3 次中位數）

每個檔案 append 一行 `# r4` 後 stage；「部分 staged」是 stage 後又修改同一個檔案（工作目錄與 index 內容不同）。檔案取自各專案排除 fixture／docs／examples 後的 `.py`；build 排除後只有 23 個檔案，所以「25」那列是 23。Ruff 欄是 `ruff check` 直接對同一批檔案的耗時。

| staged 檔案數 | marko | pipdeptree | build | 直接 `ruff check`（約） |
|---|---|---|---|---|
| 1 | 0.82 | 0.85 | 0.66 | 0.09 |
| 10 | 0.75 | 0.72 | 0.67 | 0.09 |
| 25（build 為 23） | 0.88 | 0.72 | 0.74 | 0.09 |
| 部分 staged，1 個檔案 | 0.80 | 0.79 | 0.95 | — |
| 部分 staged，10 個檔案 | 2.35 | 2.33 | 2.05 | — |

- **#205 的修正有效**：完整 staged 時 1／10／25 個檔案的耗時持平（0.7–0.9 秒），沒有隨檔案數成長。
- **部分 staged 仍逐檔執行**：1 個檔案 0.8 秒、10 個檔案 2.0–2.4 秒，約每個檔案 0.15 秒（逐檔以 stdin 傳給 ruff）。這是已知情況（#208 已說明），線性成長，只在同一個檔案同時有 staged 與未 staged 的修改時出現，數十個檔案時才會明顯；沒有另開 issue。
- 基準的 0.7–0.9 秒對 Ruff 本身的 0.1 秒：多出的部分未逐項拆解，其中 mypy 約 0.4 秒；與檔案數無關。

###### 跨專案觀察
- Python 的 `check` 幾乎都在 1 秒內（單一元件）；耗時主要落在測試（marko 27 秒、build 6 分鐘），而這與直接執行 pytest 的耗時相同，devguard 的額外開銷在 3–8% 以內。
- 元件數是 `check` 耗時的主要變因（每個元件約 0.2 秒），所以 `draft` 把測試 fixture 目錄也當成元件時（build）不只產生錯誤（#214），也讓 `check` 慢 2–3 倍。
- 沒有發現需要開效能 issue 的情況：沒有 devguard 額外開銷明顯超過直接執行工具，也沒有隨 staged 檔案數線性成長（部分 staged 是已知情況）。

#### 環境備註
- 安裝（使用者範圍、各專案內的 `.venv`，用 `uv venv` 與 `uv pip install`）：`ruff`（0.17.4／0.17.5）、`mypy` 2.4.1、`pytest`、`pytest-cov`；marko 另裝專案本身（`-e .`）與 `python-slugify`、`pygments`、`objprint`、`types-Pygments`；build 另裝專案本身與 `pytest-mock`、`pytest-rerunfailures`、`pytest-xdist`、`filelock`、`setuptools`、`wheel`、`virtualenv`、`uv`、`covdefaults`；pipdeptree 只裝 `pytest-mock`、`covdefaults`、`diff-cover`（專案本身需要 Rust／meson 建置，沒有安裝）。`pre-commit` 4.6.2 原本已安裝。
- doctor 在安裝依賴前（只有 `uv`）：三個專案都回報 `找不到 ruff：專案環境（<專案>\.venv）中沒有安裝`，提示 `uv add --dev "ruff>=0.17,<1"`（PDM 專案不適用，見 #213），另外 `.gitattributes` 缺 `* text=auto eol=lf`、`.pre-commit-config.yaml` 缺 `minimum_pre_commit_version`、框架沒有 devguard 項目（`install` 之後都解決）。
- 本輪的 `fix`、`install` 都沒有推到上游；push 只推到各專案的本機 bare remote。

### 7.3 Go


受測 devguard 0.5.2，Windows 11、Go 1.26.5、golangci-lint 2.15.0（先前已安裝）。3 個專案的 `draft` 都產生 **`team@1.4.0`**。
格式：`exit｜E 錯誤 D 偏離 H 提示`。「check 前」是填好 TODO 理由之後的第一次 `check`。
本輪專案刻意挑 Round 1–3 沒測過的工具鏈變化：**`.golangci.json`**（前幾輪只有 yml／yaml／toml）、**committed `vendor/` 目錄**（兩個專案）、**cgo 專案但沒有 C 編譯器**。

| # | 專案 | SHA | 結構／工具鏈特徵 | 標準 | draft | check 前 | fix --yes | check 後 | check --full | install | doctor | pre-commit | pre-push |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | rancher/local-path-provisioner | `a08d929edc9b07502e79229f867bda41116753e1` | 根模組＋`examples/distroless/` 巢狀模組，**`.golangci.json`**（v2，只啟用 govet／misspell／ineffassign），committed `vendor/`，Makefile | team@1.4.0 | 0｜2 元件（巢狀模組的 `go.minVersion` 1.23.0 附 TODO，手動填理由） | 1｜16E 1D 1H | 0｜在 `.golangci.json` 加 8 個 linter、`gocognit`／`depguard` 設定、`formatters`，新增 `.gitattributes`；保留原有 tab 縮排 | 1｜19E 1D 2H（設定全清，剩真實 lint：gocognit／gosec／cyclop／errorlint 等） | 1｜21E 1D 2H（`examples/distroless` 在 Windows build 失敗；根元件行覆蓋率 7%） | 0｜新增 `.claude/settings.json` 與 pre-commit／pre-push hook | 1｜19E 1D 7H | 1｜擋下（staged 的 `util.go` 有 2E：gocognit、gosec），用 `--no-verify` 前進 | 預設 0；`DEVGUARD_PRE_PUSH=full` 1，擋下（`manager [build failed]`＋覆蓋率 7%） |
| 2 | jesseduffield/lazygit | `54cc6af1d77b5a6cec3dc9ad0b203afdb4ad3451` | 單一大型模組（約 1,350 個 `.go`），**committed `vendor/`**，golangci v2（27 個 linter、已有 `.golangci.yml`）、`.vscode/`、Makefile／justfile | team@1.4.0 | 0｜1 元件，`ignore` 一支 `.py` | 1｜20E 0D 0H（缺 7 個 linter、`gofumpt` formatter、`.gitattributes`、VS Code 設定） | 0｜在既有 `.golangci.yml` 加 7 個 linter、`gofumpt`，改 `.gitattributes`、`.vscode/settings.json`、`tasks.json`；保留註解 | 1｜489E 0D 0H（gosec 230、gocognit 129、cyclop 124、misspell 5、deps 1） | 1｜491E（21 項測試失敗、覆蓋率 30.7%） | 0｜`.claude/settings.json`、hook | 1｜489E 0D 2H | 0｜放行（1 個格式乾淨的 staged 檔案）。第一次的測試編輯少了空行，被 `golangci-lint/fmt` 擋下，與直接 `golangci-lint fmt --diff` 一致 | 預設 0；full 1，擋下（21 項測試失敗＋覆蓋率 30.7%） |
| 3 | mattn/go-sqlite3 | `4cddc794daa0340d50de741dae025421bbdbba0c` | 單一模組，**cgo**（`import "C"`、`sqlite3-binding.c`），本機沒有 gcc（`CGO_ENABLED=0`），沒有 golangci 設定，Windows 專用檔案 | team@1.4.0 | 0｜1 元件（`go.minVersion` 1.21 附 TODO，手動填理由） | 1｜4E 1D 1H | 0｜新增 `.golangci.yml`、`.gitattributes` | 1｜2E 1D 1H（go.mod 不乾淨、golangci-lint 載入失敗） | 1｜3E 1D 1H（再加 `go test` build failed） | 0｜`.claude/settings.json`、hook | 1｜2E 1D 3H | 1｜擋下（`code/tool-failed`），用 `--no-verify` 前進 | 預設 0；full 1，擋下（`[build failed]`） |

#### local-path-provisioner
- **draft**：兩個元件，`examples/distroless/` 的 `go.mod` 宣告 `go 1.23.0`，推出附 TODO 的 `go.minVersion` 放寬；填理由後 `check` 才有進展。
- **check 前**：`.golangci.json` **有被認得**（不像 #85 的 `.golangci.toml`），7 個缺少的 linter 與 `formatters` 都以 `.golangci.json:5` 為位置回報。`examples/distroless` 的 `code/tool-failed`：`syscall.Umask` 在 Windows 沒有定義（直接執行 `golangci-lint run` 相同，是專案不支援 Windows，不是 devguard 的問題）。`go.mod` 因模組快取是空的得到 `deps/go-modules-missing`（提示 `go mod download`，行為符合 #83 的設計；專案有 `vendor/`，`go mod tidy` 仍需要模組快取）。`deps/banned`：直接依賴 `github.com/pkg/errors`。
- **fix --yes**：`.golangci.json` 的修改是合法 JSON，原本的 tab 縮排與其他區塊保留，沒有改壞（對照 #86、#105 的情況）。
- **check --full**：21E。`go test` 在根元件通過，但覆蓋率 7%，與直接 `go test -coverprofile` + `go tool cover -func` 的 7.0% 一致；`examples/distroless` `[build failed]` 是同一個 Windows 問題。
- **pre-commit**：staged 的 `util.go` 是專案原本就有的 gocognit／gosec finding（devguard 對整個 staged 檔案回報，不只是新增的行），是真實的標準違反。用 `--no-verify` 提交才能走到 push。
- **pre-push**：預設不阻擋（0.6 秒）；full 擋下。

#### lazygit
- **vendor**：committed `vendor/` 沒有被當成元件或被 lint 掃描（`check` 輸出沒有 `vendor/` 路徑），`draft` 也只產生一個元件。
- **draft**：`demo/fonts/fit_flog_symbols.py` 被加進 `ignore` 並附說明，沒有重演 #89。
- **fix --yes**：lazygit 的 `.golangci.yml` 有註解刻意不啟用 gofumpt（由 `scripts/gofumpt-check.sh` 另跑固定版本），標準要求的 `gofumpt` 還是被加進 `formatters.enable`，`.vscode/settings.json` 的 `formatting.gofumpt` 由 `false` 改成 `true`。這是標準要求（declared formatter）的行為，不是 bug，但專案有自己的理由時需要用 `overrides` 表達，值得在文件中提醒。
- **check 後 489E**：全是真實的 lint（gosec 230、gocognit 129、cyclop 124）；沒有出現 v1／v2 混合設定。`check` 完成時間 3–4 秒（golangci-lint 快取已暖）。
- **check --full**：21 項測試失敗（`TestBranchStatus`、`TestSetLightBackground`、`TestMerge` 等，顏色／終端機相關）與直接 `go test ./pkg/...` 的 21 項一致；覆蓋率 30.7%。
- **pre-commit**：格式乾淨的單檔 staged 通過（2.6 秒）。

#### go-sqlite3
- **cgo、沒有 gcc**：`CGO_ENABLED=0` 時 `import "C"` 的檔案被排除，測試檔因而找不到 `LoadExtension`、`Serialize` 等符號，`golangci-lint`（`code/tool-failed`）與 `go test`（`[build failed]`）都失敗。直接執行 `golangci-lint run`（exit 7）與 `go test ./...` 輸出相同，所以是環境問題。**標準要求的 linter 因此從沒真正執行**；`tool-failed` 訊息也沒有提到缺少 C 編譯器或 `CGO_ENABLED`（訊息被截斷在第一行，與 #97 同類的「看不到原因」，未另開 issue）。
- **go.mod**：`deps/go-mod-untidy` 是真實的：`go mod tidy -diff` 要把 `retract ( ... )` 區塊改成單行。
- **fix --yes**：新增 golangci-lint v2 格式的 `.golangci.yml` 與 `.gitattributes`，沒有問題。
- **pre-commit**：因 `tool-failed` 擋下每個 commit（環境因素：沒有 C 編譯器）；`--no-verify` 提交後 push 可走完。

#### 效能

環境：Windows 11、Core i7-1165G7（4 核 8 執行緒）、64 GB RAM、SSD、Go 1.26.5、golangci-lint 2.15.0、devguard 0.5.2（`build:exe`）。所有計時都是 wall clock，一次只跑一個命令（機器沒有其他負載）。一般步驟「冷」指該步驟第 1 次，golangci-lint 快取在 `fix` 改了設定之後失效；每格為中位數，括號為各次的值。`pre-push` 預設與 `DEVGUARD_PRE_PUSH=full` 各 2 次，pre-commit 2 次，其餘 `check` 類 2–3 次。

**各步驟耗時（秒）：**

| 步驟 | local-path-provisioner | lazygit | go-sqlite3 |
|---|---|---|---|
| draft | 0.4（0.42／0.42） | 0.3（0.33／0.31） | 0.1（0.15／0.14） |
| check 前（設定缺漏，golangci-lint 尚未執行 lint） | 3.9（3.9／3.8） | 3.1（3.3／2.9） | 3.4（4.4／2.4） |
| fix --yes | 1.3（1.4／1.2） | 0.7（0.7／0.7） | 0.3（0.4／0.3） |
| check 後（run1 冷、run2 暖） | 4.0（4.0／4.0） | 28.3（**52.3**／4.3） | 2.7（3.8／1.6） |
| check --full | 7.7（7.9／7.5） | 65.1（88.6／41.5；之後再量 61.9、140.8、43.6） | 2.0（1.9／2.1） |
| install | 0.3（0.26／0.25） | 0.3（0.30／0.28） | 0.3（0.32／0.27） |
| doctor | 4.9（4.5／5.3） | 3.7（3.6／3.8） | 1.9（1.9／1.9） |
| pre-commit（成功的 commit 或被擋下，見上表） | 5.7（8.9／2.4，擋下） | 2.6（3.0／2.2，通過） | 1.6（1.7／1.4，擋下） |
| pre-push 預設 | 0.6（0.7／0.4） | 0.4（0.5／0.4） | 0.4（0.4／0.3） |
| pre-push `DEVGUARD_PRE_PUSH=full` | 4.8（5.2／4.4） | 54.9（71.7／38.1） | 0.6（0.6／0.6） |

**拆解與對照直接執行工具**（同一個工作目錄、設定已被 `fix` 改過；「冷」是先 `golangci-lint cache clean`）：

| 項目 | local-path-provisioner | lazygit | go-sqlite3 |
|---|---|---|---|
| `devguard check` 冷 | 26.6 | 66.4 | 4.4 |
| 直接 `golangci-lint run` 冷 | 24.2 | 64.5 | 4.1 |
| `devguard check` 暖（3 次） | 5.0（6.2／4.0／5.0） | 3.6（4.8／3.6／3.2） | 1.5（1.5／1.5／1.8） |
| 直接 `golangci-lint run` 暖（3 次） | 2.0 | 2.7 | 1.1 |
| `devguard check --only lint`／`--only format` | 5.9／4.6 | 3.8／3.5 | 1.7／1.8 |
| 直接 `golangci-lint fmt --diff`（全專案） | 0.7 | **65.0** | 14.8 |
| `devguard check --full` | 8.5（再量 8.2） | 61.9（再量 43.6） | 2.2（再量 1.9） |
| 直接 `go test -count=1 -coverprofile ./...` | 3.2 | 39.7 | 0.5 |
| 直接 `go mod tidy -diff`（模組快取空時第 1 次，之後） | 54.1，0.2 | 17.2，0.2 | 0.2 |

- **冷的 check 幾乎全是 golangci-lint**：lazygit 冷 66.4 秒對直接 64.5 秒，devguard 額外開銷約 2 秒（3%）；暖時額外開銷約 1–3 秒（行程啟動、`go mod tidy -diff`、`go env` 等固定成本）。lazygit 在 `fix` 改了 `.golangci.yml` 之後，第一次 `check` 要 52 秒（快取失效），之後 4 秒；pre-commit 不受這個影響，因為它的快取通常已暖。
- **`check` 的格式檢查比直接 `golangci-lint fmt --diff` 快**：lazygit 全專案 `fmt --diff` 要 65 秒，devguard 的 `--only format` 只要 3.5 秒（原因未深入追查）。
- **`check --full`**：lazygit 的耗時幾乎全是 `go test`（devguard 41.5–62 秒，直接 `go test -coverprofile` 約 38–40 秒，加上 lint 約 3 秒與 tidy 約 0.2 秒），額外開銷小。但 **run 間差異很大**：同樣的命令在暖狀態下量到 41.5、43.6、61.9、88.6、140.8 秒，直接 `go test` 同期只在 38–41 秒之間（第一次冷 70.7 秒）；直接執行的工具也有同樣的離群值，不是 devguard 額外的耗時（離群原因未查明）。local-path-provisioner 的第一次 full 33.7 秒對其餘 7.5–8.5 秒也是同樣情況。
- **`check --full` 的 pre-push**（lazygit 54.9 秒）與一般 `check --full` 同級；預設的 pre-push 只花 0.4–0.6 秒，不重做測試。
- **模組快取是空的時候**：local-path-provisioner 直接 `go mod tidy` 第一次要 54 秒（下載模組）；devguard 以 `GOPROXY=off` 避免這個成本，改回報 `deps/go-modules-missing`。

**pre-commit 擴展性（`check --staged`，秒，3 次中位數，golangci-lint 快取暖，staged 內容格式乾淨）：**

| 專案 | staged 1 | staged 10 | staged 25 | 部分 staged 1 | 部分 staged 10 |
|---|---|---|---|---|---|
| local-path-provisioner（根元件只有 8 個 `.go`，10／25 都是 8 個） | 1.4（1.9／1.4／1.3） | 5.1（11.2／4.4／5.1） | 4.7（4.7／4.3／5.2） | 1.8（1.9／1.6） | 4.8（11.9／4.8／4.7） |
| lazygit | 1.4（2.5／1.3／1.4） | 4.0（9.4／3.3／4.0） | 6.5（16.5／6.0／6.5） | 2.4（3.4／1.4） | 3.6（9.9／3.6／3.6） |
| go-sqlite3 | 1.9（2.1／1.9／1.9） | 6.4（6.4／5.6／6.6） | 10.6（11.2／9.7／10.6） | 2.1（2.2／1.9） | 6.6（7.2／5.8／6.6） |

- **Go 的 pre-commit 仍隨 staged 檔案數線性成長**：go-sqlite3 的 1／10／25 為 1.9／6.4／10.6 秒（每個檔案約 0.35 秒），lazygit 為 1.4／4.0／6.5 秒（約 0.2 秒）。原因是 `formatStaged` 對每個 staged `.go` 檔案各啟動一次 `golangci-lint fmt --stdin`（再加上每個檔案一次 `git show :<path>`）。直接逐檔執行 `golangci-lint fmt --stdin` 在 go-sqlite3 25 個檔案要 9.6 秒（devguard 為 10.6 秒，即額外開銷主要就是這些行程）；直接一次 `golangci-lint fmt --diff <25 個檔案>` 只要 4.8 秒（lazygit：逐檔 4.1 秒對一次 1.7 秒）。→ #216
- 第一次執行（冷）明顯較慢（lazygit staged 25 的第 1 次 16.5 秒），之後落在中位數；暖冷差異的原因未深入追查。
- 部分 staged 的檔案（10 個）與完整 staged 同級（go-sqlite3 6.6 秒對 6.4 秒，lazygit 3.6 秒對 4.0 秒），Go 沒有 TypeScript 那種「部分 staged 才逐檔」的額外成本，因為 Go 本來就逐檔做格式。
- 與 #205 之後的 TypeScript 對照：Go 的 1→25 個檔案成長 4.6 倍（lazygit）到 5.6 倍（go-sqlite3），不符合「固定成本只付一次」的預期。

#### 發現的問題
- #216 Go pre-commit：check --staged 對每個 staged 檔案各執行一次 golangci-lint fmt --stdin，耗時隨檔案數線性成長 — 新開（效能）

沒有為其他觀察開 issue：
- `.golangci.json` 被正確辨識與修改（Round 3 的 `.golangci.toml` #85 沒有重現）。
- committed `vendor/` 沒有被掃描；模組快取為空時 `deps/go-modules-missing` 的提示（`go mod download`）符合 #83 的設計。
- lazygit 的 `gofumpt` 被標準要求加入，與專案註解的刻意選擇衝突：這是標準與 `overrides` 的使用方式，不是 devguard 的錯誤。
- go-sqlite3 在沒有 C 編譯器時 lint／測試都失敗，與直接執行工具相同；`tool-failed` 訊息沒有指出缺少 C 編譯器，屬於 #97 同類的訊息品質問題，未另開。

#### 環境備註
- 沒有安裝新工具：Go 1.26.5 與 golangci-lint 2.15.0 在 Round 3 之後已在使用者範圍；沒有 gcc（`doctor` 沒有回報，因為 devguard 不檢查 cgo 所需的 C 編譯器）。`doctor` 的提示只有 Claude Code 尚未執行過、VS Code CLI 無法列出擴充套件（exit 49）。
- 3 個專案都用 `git clone -c core.autocrlf=false --depth 1`，本機 bare remote 設 `receive.shallowUpdate true`。lazygit 與 local-path-provisioner 的模組快取一開始是空的（用 `GOPROXY=off` 的 devguard 回報缺模組），量測拆解時才用直接的 `go mod tidy` 下載。
- 注意：第一次跑第 2–5 步時不小心同時有兩份腳本在跑，所有量測作廢，已全部重跑並只採用單一執行的數據。

### 7.4 Java


受測 devguard 0.5.2，Windows 11、Temurin JDK 21.0.13、Maven 3.9.16（系統層）、Gradle 只透過專案的 `gradlew`。3 個專案的 `draft` 都產生 **`team@1.4.0`**。
格式：`exit｜E 錯誤 D 偏離 H 提示`。「check 前」是填好 TODO 理由之後的第一次 `check`。
本輪專案刻意挑 Round 1–3 沒測過的工具鏈變化：**沒有 Maven wrapper**（前三輪的 Maven 專案都有 `mvnw`）、**Gradle Kotlin DSL ＋ `buildSrc` 慣例 plugin（Spotless、JaCoCo 在 `buildSrc`）**、**Maven 專案自己設定 Checkstyle／PMD／RAT／JaCoCo 門檻（繼承自遠端 parent POM）**。三個專案都是 `--depth 1` clone。

| # | 專案 | SHA | 結構／工具鏈特徵 | 標準 | draft | check 前 | fix --yes | check 後 | check --full | install | doctor | pre-commit | pre-push |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | jhy/jsoup | `d90d57521d931db7bf7ee464a4c0a1a9293db088` | Maven 單模組，**沒有 `mvnw`**，multi-release jar（`<source>8`、profile 內 `release` 8／11），pom 沒有 Spotless／PMD／Checkstyle／JaCoCo | team@1.4.0 | 0｜1 元件（沒有推出 `java.minVersion`） | 1｜5E 0D 2H（缺 wrapper、PMD 規則集、Spotless／PMD plugin、Enforcer 規則） | 0｜新增 `pmd-ruleset.xml`、`.vscode/`；pom 與 wrapper 沒動 | 1｜4E 0D 2H | 先 2｜`找不到 mvnw`（0.4 秒，沒有跑測試）；`mvn -N wrapper:wrapper` 後 1｜4E（`mvnw test` 跑完 2,648 個測試全過，缺 JaCoCo 報告 `coverage/no-report`） | 0｜`.claude/settings.json`、pre-commit／pre-push hook | 1｜3E 0D 4H | 0｜放行（staged 的 Java 檔沒有任何 devguard 工具可跑，0.3 秒） | 預設 0；full 1，擋下（`coverage/no-report`） |
| 2 | apache/commons-csv | `fde765d64e409912013d7bb6b9a9b5784b9f2f56` | Maven 單模組，**沒有 `mvnw`**，parent `commons-parent`（遠端），pom 自己設 Checkstyle／PMD／SpotBugs／RAT／JaCoCo 門檻、`src/conf/checkstyle/` | team@1.4.0 | 0｜1 元件，`java.minVersion` 8 附 TODO，手動填理由 | 2｜只有 `找不到 mvnw`，**沒有任何 finding**（#217） | 0｜新增 `pmd-ruleset.xml`、`.gitattributes` 加 1 行 | 先 2（同上）；補 wrapper 後 1｜3E 1D 2H（PMD rulesets 沒指向 devguard 規則集、Enforcer、`mvnw` 缺 `spotless` prefix 的 `tool-failed`） | 1｜4E 1D 2H：`mvnw test` 在 Apache RAT 失敗，測試沒執行（`.devguard.yaml`、`pmd-ruleset.xml` 無授權標頭，#218） | 0｜`.claude/settings.json`、hook | 1｜3E 1D 4H | 1｜擋下（`tool-failed`：`No plugin found for prefix 'spotless'`），用 `--no-verify` 前進 | 預設 0；full 1，擋下（RAT） |
| 3 | wiremock/wiremock | `f6f6292dce92c1486a55bde845be42f57fded0fa` | **Gradle Kotlin DSL** 多專案（9 個子專案）＋`gradlew`，`buildSrc/` 慣例 plugin 帶入 Spotless 與 JaCoCo（根 `build.gradle.kts` 沒有），沒有 PMD／Checkstyle plugin，`libs` 之外有 `log4j:log4j` 直接依賴 | team@1.4.0 | 0｜1 元件，`build.tool: gradle` | 1｜5E 0D 1H（缺 PMD 規則集、`gradle.lockfile`、禁用套件 `log4j:log4j`、`pmdMain` 不存在的 `tool-failed`、`.gitattributes` eol） | 0｜新增 `pmd-ruleset.xml`、`.gitattributes`、`.vscode/` | 1｜3E 0D 1H（剩 lockfile、`log4j:log4j`、`pmdMain` 不存在） | 1｜4E 0D 1H：Gradle 跑完 5,359 個測試，2 個失敗（`ResponseDribbleAcceptanceTest`，時間相關，直接 `gradlew test` 相同） | 0｜`.claude/settings.json`、hook | 1｜3E 0D 3H | 1｜擋下（`pmdMain` 不存在），用 `--no-verify` 前進 | 預設 0；full 1，擋下（2 項測試失敗，104 秒） |

#### jhy/jsoup
- **沒有 wrapper**：`check` 以 `settings/wrapper-missing` 回報（提示 `mvn wrapper:wrapper`），exit 1；但 `check --full` 在 code／test 層找不到 `mvnw` 就 **exit 2**、不印 finding，只有兩行（0.4 秒）。依提示執行 `mvn -N wrapper:wrapper` 後才跑得動。同一個專案 `check` 與 `check --full` 對缺 wrapper 的處理不同；commons-csv 連 `check` 都 exit 2（#217）。
- **draft**：pom 在 compiler plugin 與 profile 裡以 `<source>8</source>`／`<release>8</release>` 指定 Java 8（multi-release），`draft` 沒有推出 `java.minVersion`，所以沒有偏離，也沒有 TODO。草稿能直接用。
- **fix --yes**：只新增 `pmd-ruleset.xml` 與 `.vscode/`。pom 的 Spotless／PMD／Enforcer 缺漏只能手動補（`fix` 預覽有印片段），符合設計；沒有產生 `checkstyle.xml`。
- **check --full（有 wrapper 後）**：`mvnw test` 跑完 2,648 個測試全過。沒有 JaCoCo 時測試**有**執行，只回報 `coverage/no-report`（#99 的修正有效）。
- **pre-commit**：pom 沒有 Spotless／PMD／Checkstyle plugin，staged 檢查沒有工具可跑，commit 放行；專案層級的 4 個錯誤不擋 commit（只在 staged 檔案有 finding 時擋，符合設計）。因此這個專案的 pre-commit 擴展性量測沒有意義（見效能）。
- **pre-push**：預設 0；full 擋下（`coverage/no-report`）。

#### apache/commons-csv
- **check 前**：exit 2，只有 `找不到 mvnw`，沒有 `settings/wrapper-missing`、Enforcer 等 finding。`fix --yes` 之後仍 exit 2。對照 jsoup（同樣沒有 wrapper）能列出所有 finding，差別在 pom 有 Checkstyle／PMD plugin 時 code 層會執行。已開 #217。
- **fix --yes**：新增 `pmd-ruleset.xml`，`.gitattributes` 加 `* text=auto eol=lf`。專案自己的 `src/conf/checkstyle/checkstyle.xml` 沒被動到（沒有重演 #100）。
- **check 後（補 wrapper）**：`settings/java-plugin-config` 正確指出 PMD 的 `rulesets` 沒有指向 `pmd-ruleset.xml`；`Spotless plugin 缺少` **沒有**回報（Spotless 可能由遠端 parent POM `commons-parent` 帶入，devguard 讀不到所以不判斷），結果 `spotless:check` 以 `No plugin found for prefix 'spotless'` 失敗，每次 `check` 與每個 commit 都帶這一筆 `tool-failed`。直接執行 `mvnw spotless:check` 相同。這是環境無法判定時的保守設計，訊息已經有原因（#97 修正後），沒有另開 issue。
- **check --full**：`mvnw test` 在 Apache RAT 失敗，列出的 unapproved 檔案是 `.devguard.yaml` 與 `pmd-ruleset.xml`，測試因此沒有執行。直接 `./mvnw test` 相同；把兩個檔案移開後測試跑完 989 個，3 個失敗（Windows 預設字元集，專案自己的問題）。已開 #218。
- **pre-commit**：被 Spotless 的 `tool-failed` 擋下，用 `--no-verify` 前進（`SKIP` 不適用，專案沒有自己的 hook）。
- **pre-push**：預設不阻擋；full 擋下（RAT，5 秒）。

#### wiremock/wiremock
- **buildSrc 慣例 plugin**：Spotless 與 JaCoCo 在 `buildSrc/src/main/kotlin/wiremock.common-conventions.gradle.kts`，根 `build.gradle.kts` 沒有。devguard 沒有誤報「缺 Spotless」或「缺 JaCoCo」（慣例 plugin 被視為無法判定而略過），直接執行 `gradlew spotlessCheck` 也確實能跑。
- **缺 PMD plugin**：沒有 `settings/java-plugin-missing`，而是 `code/tool-failed`：`Task 'pmdMain' not found in root project 'wiremock' and its subprojects.`。原因同樣是 PMD 可能由 `buildSrc` 帶入所以不判斷，直接 `gradlew pmdMain` 相同。因為 Gradle 一個 task 不存在整批失敗，已設定好的 Spotless 以外的檢查沒有結果；#98 描述的 Gradle 行為仍在，只是 `settings` 層現在對慣例 plugin 保守（未另開）。
- **deps**：`deps/banned` 正確指出 `build.gradle.kts:130` 的 `log4j:log4j`；`deps/lockfile-missing` 要求 `gradle.lockfile`。
- **fix --yes**：新增 `pmd-ruleset.xml`、`.gitattributes`、`.vscode/`；`build.gradle.kts` 與 `buildSrc` 沒動。
- **check --full**：Gradle 跑完 5,359 個測試（46 個略過），2 個失敗（`ResponseDribbleAcceptanceTest` 兩項，socket timeout／dribble 相關），與直接 `gradlew test --continue` 完全一致；第一次 devguard 只報其中 1 項（冷啟動時另一項通過），第二次報 2 項。覆蓋率沒有評估（測試失敗時不評估）。
- **pre-commit**：被 `pmdMain` 的 `tool-failed` 擋下，用 `--no-verify` 前進。
- **pre-push**：預設 0（0.4 秒）；full 擋下（2 項測試失敗，約 104 秒）。

#### 效能

環境：Windows 11、Core i7-1165G7（4 核 8 執行緒）、64 GB RAM、SSD、Temurin JDK 21.0.13、Maven 3.9.16、devguard 0.5.2（`build:exe`）。所有計時都是 wall clock，一次只跑一個命令（機器沒有其他負載）。Maven 與 Gradle 的本機快取（`~/.m2`、`~/.gradle`）一開始是空的，所以各專案第一次執行 Maven／Gradle 的步驟是「冷」（要下載 plugin、Gradle distribution，wiremock 還要編譯 `buildSrc`）。格內為中位數（括號為各次）；只跑 2 次的格，中位數＝兩次平均。pre-commit／pre-push 預設與 full 各 2 次。

**各步驟耗時（秒）：**

| 步驟 | jsoup | commons-csv | wiremock |
|---|---|---|---|
| draft | 0.2（0.21／0.13） | 0.2（0.19／0.12） | 0.2（0.23／0.11） |
| check 前（run1 冷、run2 暖） | 0.3（0.34／0.33） | 0.9（0.87／0.86，exit 2 中止） | **135.2**（**264.9**／7.4） |
| fix --yes | 0.3 | 0.6 | 0.7 |
| check 後（有 wrapper） | 0.4（0.34／0.38） | 15.2（**20.4**／10.0） | 13.8（17.4／10.2） |
| check --full | 36.9（**51.4**／22.5；補 wrapper 前 exit 2：0.4） | 18.0（21.2／14.8） | 236.0（**342.2**／129.7） |
| install | 0.3 | 0.5 | 0.3 |
| doctor | 1.1（1.07／1.10） | 10.4（10.3／10.6） | 22.5（22.8／22.3） |
| pre-commit | 0.3（0.3，放行） | 9.8（10.3／9.2，擋下） | 22.0（22.3／21.6，擋下） |
| pre-push 預設 | 0.3（0.32／0.28） | 0.5（0.6／0.3） | 0.4（0.4／0.3） |
| pre-push `DEVGUARD_PRE_PUSH=full` | 22.0（21.6／22.3） | 5.2（5.4／4.9，RAT 失敗） | 104.2（105.1／103.3） |

**拆解與對照直接執行工具**（同一個工作目錄，設定已被 `fix` 改過）：

| 項目 | jsoup | commons-csv | wiremock |
|---|---|---|---|
| `devguard check --full` | 22.5（暖） | 14.8（暖） | 129.7（暖）；冷 342.2 |
| 直接 `mvnw test`／`gradlew test` | 25.0（27.3／22.7） | 25.3（34.4／16.1；RAT 失敗時 5.6） | 103.8（103.3／104.4） |
| `devguard check`（code 層有執行） | — | 10.0（暖） | 10.2（暖，spotless 快取）／21.8（Java 檔改過後） |
| 直接 spotless | — | `mvnw spotless:check` 4.1（失敗） | `gradlew spotlessCheck` 20.8（20.5／21.2） |
| 直接 checkstyle | — | `mvnw checkstyle:check` 7.0（9.5／4.5） | `gradlew checkstyleMain` 1.8（task 不存在） |
| 直接 pmd | — | `mvnw pmd:check` 6.8（6.9／6.7） | `gradlew pmdMain` 2.1（task 不存在） |
| 工具啟動底線 | `mvnw -v` 2.1 | `mvnw -v` 2.1 | `gradlew help` 2.0（2.4／1.7） |

- **devguard 的額外開銷很小**。`check --full` 與直接執行測試的耗時相同（jsoup 22.5 對 22.7；wiremock 129.7 對 103.8，差的約 26 秒是同一次 Gradle 呼叫還包含 `spotlessCheck` 與編譯其他 task，不是 devguard 自己的時間；commons-csv 因 RAT 提早失敗）。devguard 本身的處理（draft、fix、install、純設定層的 check）全部在 1 秒內。
- **wiremock `check` 的 10 秒與 22 秒**：主要是 `spotlessCheck`。Java 檔案沒變時 Gradle 快取讓 `check` 約 10 秒；改過 Java 檔後 `spotlessCheck` 重新執行，devguard 的 `check`（21.4–22.2）與直接 `gradlew spotlessCheck`（20.5–21.2）幾乎相同，所以是工具本身慢，不是 devguard。`doctor`（22.5）與 pre-commit（22.0）也各自做一次這個檢查。
- **commons-csv 的 10 秒**：Maven 啟動約 2 秒，加上 plugin 執行（spotless 4、checkstyle 4.5–9.5、pmd 6.7）；devguard 約 10 秒介於單一與全部工具加總（約 15 秒）之間，沒有看出額外開銷。
- **冷啟動**：wiremock 第一次 `check` 265 秒（下載 Gradle distribution、編譯 `buildSrc`、解析依賴）；jsoup 第一次 `check --full` 51 秒（下載 surefire 等 plugin），暖後 22.5 秒；commons-csv 第一次 20 秒，暖後 10 秒。這些都是 Maven／Gradle 的首次成本。
- **`doctor` 會執行 code 層的 check**：wiremock 的 `doctor` 22.5 秒、commons-csv 10.4 秒，jsoup 只有 1.1 秒（沒有 code 層工具）。`doctor` 的耗時等同一次完整 `check`，與 Go 專案類似。

**pre-commit 擴展性（`devguard check --staged`，秒，3 次中位數，括號為各次）：**

| staged | jsoup | commons-csv | wiremock |
|---|---|---|---|
| 1 個檔案 | 0.2（0.2／0.2／0.2） | 9.6（9.6／9.5／9.8） | 22.1（24.0／22.1／21.4） |
| 10 個檔案 | 0.2（0.3／0.2／0.2） | 10.0（9.5／10.2／10.0） | 13.7（14.5／13.7／13.7） |
| 25 個檔案 | 0.3（0.3／0.3／0.3） | 9.6（9.4／10.0／9.6） | 13.8（13.7／13.8／13.8） |
| 部分 staged，10 個檔案（staged 後再改動） | 0.2（0.2／0.2／0.2） | 10.0（10.3／10.0／9.3） | 13.1（13.6／13.1／12.9） |
| 部分 staged，1 個檔案 | 0.2（0.2／0.2） | 10.1（10.3／9.9） | 21.8（22.0／21.7） |

- **耗時不隨 staged 檔案數成長**（#205 的修正在 Java 上成立）：Java 的 staged 檢查是對整個專案一次呼叫 Maven／Gradle（`spotless:check` 等），1 個檔案與 25 個檔案耗時相同。
- **部分 staged 也沒有逐檔執行**：Java 的部分 staged 與一般 staged 耗時相同（commons-csv 10.0 對 9.6），不像 Go（#216）或 Prettier（#209）有逐檔的路徑。
- **wiremock 的 1 個檔案反而比 10／25 個慢**（22 對 13.7）：1 個檔案的案例的檔案在 `perf-test/`、與 10／25 個的檔案集合不同，Gradle 的 `spotlessCheck` 快取狀態不同，沒有進一步拆解，並非 devguard 的耗時。
- **缺點（設計，不是 bug）**：不管 staged 幾個檔案都是整個專案的 `spotlessCheck`，所以只改 1 行的 commit 在 wiremock 也要 13–22 秒。沒有為此另開 issue，因為額外開銷小於或等於直接執行工具。
- jsoup 沒有可執行的 staged 工具，量到的是 devguard 自己的固定成本（約 0.2–0.3 秒），確認 devguard 本身不隨檔案數成長。
- **注意**：commons-csv 與 wiremock 的 staged 檢查都以 exit 1 結束（commons-csv 因 Spotless prefix 不存在、wiremock 因 `pmdMain` 不存在，wiremock 25 個檔案另有 Spotless 格式錯誤），所以量到的是「工具失敗」路徑的耗時。這些路徑都在第一次 Maven／Gradle 呼叫內完成。

#### 發現的問題
- #217 Maven 沒有 mvnw 但 pom 有 Checkstyle／PMD plugin：check 以 exit 2 中止且沒有任何 finding — 新開（commons-csv；對照 jsoup）
- #218 專案使用 Apache RAT 時，fix／draft 產生的 `pmd-ruleset.xml` 與 `.devguard.yaml` 沒有授權標頭，讓 `mvnw test` 在 RAT 失敗、測試不執行 — 新開（enhancement，commons-csv）

沒有為其他觀察開 issue：
- 沒有 Maven wrapper 時 `check --full` exit 2：與 #217 同一個行為，已在該 issue 說明。
- 遠端 parent POM（commons-csv）與 `buildSrc` 慣例 plugin（wiremock）造成「缺 plugin」只剩 `tool-failed`：是 `settings` 層對無法判定的情況保守，訊息已有原因（#97 修正後）。
- wiremock 的 2 項測試失敗與 commons-csv 的 3 項測試失敗，都與直接執行工具一致，是專案或環境（時間相關、Windows 字元集）的問題。
- Round 3 的 #99（沒有 JaCoCo 時測試不跑）、#100（`fix` 覆寫 checkstyle.xml）在本輪沒有重現：jsoup 的 `mvnw test` 在沒有 JaCoCo 時有執行，commons-csv 既有的 `src/conf/checkstyle/checkstyle.xml` 沒被動到。

#### 環境備註
- 沒有安裝新的 JDK 或 Maven／Gradle；`doctor` 沒有回報缺工具（Maven 與 JDK 已在使用者範圍）。`doctor` 的提示只有 Claude Code 尚未執行過、VS Code CLI 無法列出擴充套件。
- jsoup 與 commons-csv 沒有 `mvnw`，用 `mvn -N wrapper:wrapper`（約 10 秒）產生 wrapper 後才能跑 code／test 層。這些檔案只在本機工作目錄，沒有推到上游。
- 3 個專案都用 `git clone -c core.autocrlf=false --depth 1`，本機 bare remote 設 `receive.shallowUpdate true`。pre-push 各跑預設與 full 兩次，推到本機 bare remote 的不同分支名，沒有推到上游。
- commons-csv 的 pre-commit 測試檔案末端附加 `// r4`；該專案的檔案是 CRLF，Git 回報「CRLF will be replaced by LF」，與 `.gitattributes` 加入 eol 規則有關，沒有影響結果。

