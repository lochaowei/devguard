# devguard

讓 Java、Python、Go、TypeScript 專案的開發規範（coding standard、complexity、test coverage、dependency）用**一份設定**同時落實到三道防線，並幫開發者快速確認自己的環境是否設定正確。

| 防線 | 時機 | devguard 做什麼 |
|---|---|---|
| 第一道：VS Code | 撰寫時 | 產生並檢查 workspace 設定，讓擴充套件即時顯示問題 |
| 第二道：Claude Code | Claude 編輯檔案時 | 產生 `.claude/` 的 rules、hooks 與 `/standards-doctor`，事前告知標準、事中檢查回饋 |
| 第三道：git hook | commit / push 時 | 安裝 pre-commit 與 pre-push hook，擋下不合格的變更 |

單一事實來源是 **預設標準**（內建在 CLI，例如 `team@1.0.0`）加上專案自己的 **專案宣告** `.devguard.yaml`。完整設計見 [SPEC.md](SPEC.md)，用語定義見 [GLOSSARY.md](GLOSSARY.md)，詳細使用手冊與各語言對照表見 [docs/wiki/Home.md](docs/wiki/Home.md)。

## 目前狀態

**v0.1.0 開發進度（PR #29 `feat/spec-implementation`）**：已完成核心的 **`devguard check`**、**`devguard fix`**、**`devguard draft`** 與 **Bun 單一執行檔打包腳本**：

- **專案宣告與草稿**：解析並檢查 `.devguard.yaml`（9 種標準項目類型、覆寫與偏離規則、到期日檢查、未涵蓋程式檔提示），以及依既有設定產生宣告草稿（`devguard draft`）。
- **四語言設定檢查與一致性檢查**：檢查 Python（`pyproject.toml`）、Go（`.golangci.yml`、`go.mod`）、TypeScript（`tsconfig.json`、ESLint、Prettier、Biome、Vitest / Jest、`package.json`）、Java（`pom.xml`、`build.gradle(.kts)`、`checkstyle.xml`、PMD ruleset、`lombok.config`）與共通 `.gitattributes`（`* text=auto eol=lf`）。
- **依賴規則與工具版本範圍**：檢查各語言 lockfile 是否提交（含 `go mod tidy -diff`、Maven Enforcer `banDynamicVersions` / `dependencyConvergence`、Gradle `gradle.lockfile`）、直接依賴是否包含禁用套件（`deps.banned`），以及鎖定的工具版本與 `golangci-lint` 是否落在標準允許的範圍內（`tools.*`）。
- **四語言程式碼檢查**：透過專案環境鎖定的工具執行 lint、format 與 typecheck（Ruff、mypy / pyright、golangci-lint、ESLint、Prettier、Biome、`tsc`、Spotless、Checkstyle、PMD），支援指定檔案與 `--only lint|format|typecheck`。
- **測試與覆蓋率檢查（`check --full`）**：執行 pytest + `coverage json`、`go test` + `go tool cover`、Vitest / Jest、Maven / Gradle test + JaCoCo XML，分別驗證測試通過與行 / 分支覆蓋率門檻。
- **五種報告格式**：支援 `text`、`json`、`sarif`、`vscode`、`claude` 輸出格式。
- **設定修正（`devguard fix`）**：依檔案類別重新產生 CLI 全權管理檔、修補結構化共用設定檔（保留註解與順序），或印出建置檔與使用者層級設定片段；支援互動式 diff 預覽與 `--yes`。
- **Windows 單一 `.exe` 打包與探測**：提供 Bun `--compile` 打包腳本、無 Node 環境 smoke test 與 Windows 子程序行為探測（SPEC §13 T2）。

其餘防線整合與進階功能依 [SPEC.md](SPEC.md) 逐步實作，見下方[路線圖](#路線圖)。

## 快速開始

需要 Node.js **22.18 以上**（直接執行 TypeScript 原始碼需要 Node 內建的 type stripping）。

```bash
npm install
```

```bash
# 檢查專案宣告、工具設定、依賴、工具版本與程式碼
npm run devguard -- check

# 執行完整檢查（含測試與覆蓋率門檻）
npm run devguard -- check --full

# 預覽並修正不合規的設定檔
npm run devguard -- fix

# 尚無 .devguard.yaml 時，依既有設定產生宣告草稿
npm run devguard -- draft
```

正式發佈時，devguard 會用 Bun 打包成單一 `devguard.exe`，透過公司內部的 Scoop bucket 安裝（SPEC §3.1）。

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

### 還沒有宣告：`devguard draft`

專案還沒有 `.devguard.yaml` 時（`check` 會回報「找不到 .devguard.yaml」並建議這個指令），執行：

```bash
devguard draft [--cwd <dir>]
```

依偵測到的元件與既有的工具設定產生**草稿**並寫入 `.devguard.yaml`（SPEC §4.3）：

- **元件**：每個 `.py`、`.go`、`.ts`、`.java` 檔歸屬於最近一層有該語言建置或工具檔（`pyproject.toml` / `setup.py` / `setup.cfg` / `requirements.txt`、`go.mod`、`package.json` / `tsconfig.json`、`pom.xml` / `build.gradle(.kts)` / `settings.gradle(.kts)`）的目錄，沒有的話歸屬 repo 根目錄；monorepo 會產生多個元件。Java 的多模組建置以最外層的建置檔為一個元件。
- **覆寫**：沿用設定檢查讀取的工具設定（`pyproject.toml`、`.golangci.yml` / `go.mod`、`pom.xml`、tsconfig / ESLint / Prettier / Biome / Vitest 等）。與預設相同的值省略；比預設嚴格的值、風格項目直接寫入；比預設寬鬆的值寫成 `{value, reason: "TODO: …"}`，**填寫理由之前 `check` 會回報錯誤**。
- **不覆寫**：`.devguard.yaml` 已存在時不做任何修改，以 exit code `2` 結束。

產生後請確認元件是否正確、填寫所有 `TODO` 理由（可加 `until`），再執行 `devguard check`。

### 工具版本範圍

`check` 會讀出各元件用依賴管理鎖定的工具版本（`uv.lock` / `poetry.lock`、`package-lock.json`、`go.mod` 的 `tool`、`pom.xml` / `build.gradle(.kts)` 中的 plugin 版本），超出標準的版本範圍（`tools.<工具>` 項目，例如 `tools.ruff: ">=0.17,<0.18"`）就回報錯誤。golangci-lint 例外：從 PATH 呼叫 `golangci-lint --version` 核對，不符時提示 `scoop update golangci-lint`。

要使用範圍外的版本，在宣告中放寬範圍並寫理由，依偏離規則處理：

```yaml
    overrides:
      tools.ruff:
        value: ">=0.17,<0.19"
        reason: "升級到 0.18 中"
        until: 2027-01-31
```

> **待團隊訂定**：`team@1.0.0` 中各工具的版本範圍與 golangci-lint 的指定版本目前都是**佔位值**（SPEC §12 第 5 項），在 [src/standard/team-1.0.0.ts](src/standard/team-1.0.0.ts) 以 `placeholderRange` 與 `TODO` 標註，發佈前必須換成團隊訂定的範圍。

## 指令

```
devguard check [檔案…] [--only lint|format|typecheck] [--full] [--format text|json|sarif|vscode|claude] [--strict] [--verbose] [--cwd <dir>]
devguard fix [--yes] [--cwd <dir>]
devguard draft [--cwd <dir>]
devguard --version
devguard --help
```

| 指令 / 選項 | 說明 |
|---|---|
| `check [檔案…]` | 依序執行專案宣告、未涵蓋檔案、四語言設定、依賴規則、工具版本、`.gitattributes` 與程式碼檢查；指定檔案時，程式碼檢查只針對這些檔案 |
| `fix` | 檢查設定並規劃修正：互動式終端機先預覽 diff、確認後套用；非互動環境未加 `--yes` 時只預覽並以 exit code `1` 結束 |
| `draft` | 沒有 `.devguard.yaml` 時，依偵測到的元件與既有設定產生宣告草稿（不覆寫既有檔案） |
| `--only <類別>` | 只執行單一類別的程式碼檢查：`lint`、`format` 或 `typecheck` |
| `--full` | 執行全部檢查（包含各元件的完整測試與行 / 分支覆蓋率門檻檢查；不能與檔案參數同時使用） |
| `--format text` | 預設。依元件、等級（錯誤、偏離、提示）分組，附上修正方式並標註能否用 `fix` 處理，最後一行是總結 |
| `--format json` | `{ standard, components[], findings[] }`，供 CI 或其他工具使用 |
| `--format sarif` | SARIF 2.1.0 格式（只包含 `code` 層的程式碼問題），供程式碼審查平台使用 |
| `--format vscode` | 單行 `檔案:行:欄: 等級: 訊息 [規則]` 格式，供 VS Code problem matcher 解析 |
| `--format claude` | 精簡回饋格式（最多列 20 項、少於 4,000 字元），供 Claude Code 讀取 |
| `--strict` | 偏離也算失敗（回傳 exit code `1`） |
| `--verbose` | 在 `text` 格式中展開所有提示（預設只顯示提示數量） |
| `--yes` | `fix`：不詢問確認，直接套用設定修正 |
| `--cwd <dir>` | 指定專案根目錄（預設為目前工作目錄） |

**exit code**：`0` 通過（只有偏離或提示也算通過；`fix` 無須修改或已套用完成）、`1` 有錯誤（或 `--strict` 時有偏離；`fix` 使用者取消或非互動環境未加 `--yes` 且有待修正項目）、`2` CLI 本身出錯（例如參數錯誤、檔案不在專案目錄內、`draft` 時宣告檔已存在）。

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

## 開發

| 指令 | 用途 |
|---|---|
| `npm test` | 執行測試（Vitest） |
| `npm run test:coverage` | 測試並檢查覆蓋率（四項門檻皆為 80%） |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint（typescript-eslint `strictTypeChecked`，循環複雜度上限 10） |
| `npm run format` / `format:check` | Prettier（行寬 120、LF） |
| `npm run build:exe [-- x64\|arm64]` | 用 Bun（≥ 1.2.23）打包成 `dist/devguard-windows-<arch>.exe`，含圖示與版本資訊。交叉編譯的目標沒有圖示與版本資訊（Bun 的限制） |
| `npm run smoke:exe [-- <exe>]` | 從 PATH 移除 Node 後，對 exe 執行 `--version` 與 `check`（範例專案） |
| `npm run t2:probe` / `build:t2-probe` | SPEC §13 T2：子程序行為探測，先在 Node 下跑基準，再打包成 `dist/t2-probe-windows-<arch>.exe` 執行比對 |

devguard 本身也遵守 SPEC §6.3 的 TypeScript 預設標準，並以 [.devguard.yaml](.devguard.yaml) 宣告自己。

### 目錄結構

```
src/
  cli.ts                 指令列入口（check、fix、draft）
  check.ts               devguard check 的檢查層組合與執行入口
  draft.ts               devguard draft：偵測元件與既有設定並產生 .devguard.yaml 草稿
  scope.ts               check 的檔案範圍、--only 類別與 --full 參數解析
  standard/              內建的預設標準（team@1.0.0）與版本查找
  declaration/           宣告檔的解析、覆寫比對、套用、檔案歸屬
  layers/                可插拔檢查層（宣告、未涵蓋檔案、四語言設定、依賴、工具版本、.gitattributes、程式碼、測試與覆蓋率）
  settings/              Python、Go、TypeScript、Java 工具設定檔解析與比對，以及 Java 設定檔產生器
  deps/                  各語言依賴清單解析與禁用套件比對
  versions/              版本範圍解析，以及從 lockfile / 建置檔讀出鎖定的工具版本
  code/                  四語言程式碼檢查器（lint、format、typecheck）
  testing/               四語言測試執行與覆蓋率報告解析（--full）
  fix/                   devguard fix：檔案分類、設定修補（YAML/JSONC/TOML/行規則）、diff 預覽與互動確認
  tools/                 專案環境工具執行器（uv run、node_modules/.bin、go tool、mvnw/gradlew）
  process/               外部程序執行與 Windows .cmd/.bat shim
  repo/                  Git 檔案列舉與元件歸屬
  report/                finding 型別、text/json/sarif/vscode/claude 報告格式、exit code
  xml/                   輕量 XML 解析（供 Maven pom.xml、Checkstyle、PMD、JaCoCo 使用）
test/                    Vitest 單元與整合測試
scripts/                 exe 打包、smoke test、T2 子程序探測
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
- [x] 偵測各工具的設定檔、四語言設定檢查與依既有設定產生宣告草稿 `devguard draft`（§4.3、§6、§8，#3–#7）
- [x] 依賴規則（lockfile 與禁用清單）與工具版本一致性檢查（§5.2、§5.4、§8，#8–#9）
- [x] 四語言程式碼檢查（lint、format、typecheck）與 `--only` / 檔案範圍（§6、§7.1，#10–#13）
- [x] 測試與覆蓋率檢查 `devguard check --full`（§6、§7.1，#14）
- [x] 報告格式：`text`、`json`、`sarif`、`vscode`、`claude`（§11，#15）
- [x] `devguard fix`：依檔案類別修正設定檔（§9，#17）
- [ ] `devguard fix --code`：自動修正程式碼（§9.1，#16）
- [ ] `devguard install` 與 git hook：pre-commit、pre-push、注入既有 hook 框架（§7.4，#18–#20）
- [ ] `devguard doctor`、內部鏡像與帳密檢查（§7.4、§10，#21、#24）
- [ ] 第一道防線：VS Code `.vscode/` 的 extensions、settings、tasks（§7.2，#22）
- [ ] 第二道防線：Claude Code `.claude/` 的 rules、hooks 與 `/standards-doctor`（§7.3，#23）
- [ ] 進階：弱點掃描（§5.3，#25）
- [ ] `devguard standard upgrade` 與棄用版本（§5.5，#26）
- [x] Bun 單一 `.exe` 打包腳本、smoke test 與 T2 子程序探測（§3.1、§13，#27）
- [ ] 簽章與內部 Scoop bucket 發佈（§3.1，#28）

導入前需要團隊或 IT 確認的事項見 SPEC §12，實作初期要實機測試的項目見 SPEC §13。
