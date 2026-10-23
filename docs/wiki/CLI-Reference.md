# CLI 指令與報告格式參考

## 指令總覽

```text
用法：devguard <指令> [選項]

指令：
  check [檔案…]  檢查專案宣告（.devguard.yaml）與程式碼；指定檔案時只檢查這些檔案
  doctor         check 加上環境檢查（工具、git hook、VS Code、Claude Code、鏡像帳密、標準更新）；只回報並附上修正指令
  fix            修正設定（工具設定檔、.vscode/、.claude/、git hook）：先預覽，確認後套用；--yes 直接套用
  fix --code [檔案…]  修正程式碼（格式化與可自動修正的 lint），修正後回報剩餘問題
  install        產生各防線的設定並安裝 git pre-commit 與 pre-push hook：先預覽，確認後套用；--yes 直接套用
  hook <名稱>    給 hook 呼叫：git-pre-commit|git-pre-push|claude-session-start|claude-post-edit|claude-stop
  draft          沒有 .devguard.yaml 時，依偵測到的元件與工具設定產生宣告草稿（不覆寫既有檔案）
  standard upgrade [目標版本]
                 預覽標準升級；--apply 才修改宣告與設定檔，並透過內部鏡像執行套件管理指令

選項：
  --staged              check：只檢查 staged 的檔案，與 pre-commit hook 相同（不能與檔案、--full 或 --only 一起使用）
  --only <類別>         只跑一類程式碼檢查：lint|format|typecheck
  --full                跑全部檢查，包含測試、覆蓋率與弱點掃描（不能與檔案一起使用）
  --format <格式>       輸出格式：text|json|sarif|vscode|claude（預設 text）
  --strict              偏離也算失敗
  --verbose             展開所有提示
  --quiet               doctor：只輸出有問題的項目（錯誤與偏離），沒有問題時不輸出
  --exit-zero           doctor：有問題時也以 0 結束（給 Claude Code skill 嵌入結果用）
  --cwd <dir>           專案根目錄（預設為目前目錄）
  --code                fix：修正程式碼而不是設定
  --yes                 fix / install：不詢問，直接套用
  --apply               standard upgrade：實際套用升級
  --version             顯示版本
  -h, --help            顯示用法說明
```

---

## `devguard check` 的檢查層（Check Layers）

`devguard check` 會依序執行 [`CHECK_LAYERS`](../../src/check.ts) 中的 15 道可插拔檢查層，並將所有發現的問題（`Finding`）合併為單一報告；`devguard doctor` 再加上第 16 道 `environment` 層（工具、git hook、VS Code 擴充套件、Claude Code、鏡像帳密、標準更新）：

| 順序 | 檢查層 ID | 分類（`layer`） | 檢查內容 |
|---|---|---|---|
| 1 | `declaration` | `config` | 解析 `.devguard.yaml`、驗證標準版本、比對覆寫項目與偏離理由/到期日、檢查同語言風格一致性 |
| 2 | `uncovered-files` | `config` | 找出未被任何宣告元件涵蓋的四語言程式檔並發出提示 |
| 3 | `settings-python` | `config` | 檢查 `pyproject.toml` 的 Ruff（`target-version`、`line-length`、`lint.select`、`mccabe`、`flake8-tidy-imports`）與 mypy / pyright 設定 |
| 4 | `settings-go` | `config` | 檢查 `go.mod` 的 Go 版本與 `.golangci.yml`（`version: "2"`、linters、formatters、`cyclop`、`gocognit`、`gomodguard`、`depguard`） |
| 5 | `settings-java` | `config` | 檢查 Maven `pom.xml` / Gradle 建置檔版本與 plugin、Wrapper 是否存在、`checkstyle.xml`、PMD ruleset、`lombok.config` |
| 6 | `deps` | `config` | 檢查各語言 lockfile 是否提交至 git（含 `go mod tidy -diff`、Maven Enforcer、Gradle `gradle.lockfile`），以及直接依賴是否違反 `deps.banned` |
| 7 | `settings-typescript` | `config` | 檢查 `package.json`（`engines.node`）、`tsconfig.json`、ESLint flat config、Prettier、Biome、Vitest / Jest 覆蓋率門檻設定 |
| 8 | `tool-versions` | `consistency` | 從 lockfile / 建置檔讀出鎖定的工具版本（以及 PATH 上的 `golangci-lint` 版本），核對是否落在標準的 `tools.*` 版本範圍內 |
| 9 | `gitattributes` | `config` | 檢查 repo 根目錄 `.gitattributes` 是否包含 `* text=auto eol=lf` |
| 10 | `mirrors` | `config` | 檢查專案層級的鏡像設定（uv、npm、Maven、Gradle）是否指向宣告的內部鏡像（§10） |
| 11 | `claude-code` | `config` | 檢查 `.claude/` 的 rules、hooks 與 `/standards-doctor` 是否與標準一致（§7.3） |
| 12 | `vscode` | `config` | 檢查 `.vscode/` 的 extensions、settings、tasks（§7.2） |
| 13 | `code` | `code` | 呼叫各元件環境中的工具執行 `lint`、`format`、`typecheck`（支援 `[檔案…]`、`--staged` 與 `--only` 過濾） |
| 14 | `tests` | `code` | **僅在 `--full`（且未指定 `--only`）時執行**：跑各元件的測試套件並驗證行 / 分支覆蓋率是否達標 |
| 15 | `vuln` | `code` | **僅在 `--full` 且標準開啟弱點掃描時執行**：各語言的弱點掃描（§5.3） |

---

## `devguard fix`：設定修正

`devguard fix` 會執行標為 `fixable` 的設定相關檢查層（`FIX_LAYERS`：`declaration`、`settings-python`、`settings-go`、`settings-java`、`settings-typescript`、`gitattributes`、`mirrors`、`claude-code`、`vscode`），並加上被修改過的 devguard git hook，收集所有 `Finding` 附帶的修補指令（`Repair`），並依 **4 種檔案類別** 規劃變更：

1. **CLI 全權產生（`generated`）**
   - 對象：`checkstyle.xml`、`pmd-ruleset.xml`（及 `pmd.xml`、`config/pmd/*.xml`）、`dependency-check-suppressions.xml`、`.mvn/settings.xml`、`.mvn/maven.config`、`.claude/rules/*`、`.claude/skills/standards-doctor/*`、`.githooks/*`
   - 行為：整份重新產生，並在檔頭自動加上 `由 CLI 產生（devguard），請勿手動修改；執行 devguard fix 重新產生` 註解。
2. **結構化的共用檔（`managed`）**
   - 對象：`pyproject.toml`、`.golangci.yml` / `.golangci.yaml`、`tsconfig.json`、`.prettierrc` / `.prettierrc.json`、`biome.json` / `biome.jsonc`、`package.json`、`.gitattributes` 等
   - 行為：使用格式專用修補器（TOML 用 `@decimalturn/toml-patch`、YAML 用 `yaml`、JSON / JSONC 用 `jsonc-parser`），**只修改 CLI 管理的 key**，完整保留原有的註解、空行與欄位順序。
3. **建置檔與程式碼形式的設定檔（`snippet`）**
   - 對象：`pom.xml`、`build.gradle(.kts)`、`eslint.config.js`、`vitest.config.ts` 等
   - 行為：**不自動寫入檔案**，只在終端機印出應手動套用的設定片段。
4. **使用者層級設定（`user`）**
   - 對象：repo 目錄以外的路徑（如 `~/.m2/settings.xml`、使用者的 `.npmrc`）
   - 行為：**絕不自動修改**，只印出修改說明。

### 互動與 Exit Code 規則

- **互動式終端機（TTY）**：先顯示每個待寫入檔案的 LCS diff 預覽與需手動套用的片段，詢問是否套用；確認後寫入並回傳 `0`，取消則不寫入並回傳 `1`。
- **加上 `--yes`**：印出預覽後直接寫入所有 `generated` 與 `managed` 檔案，回傳 `0`。
- **非互動環境（如 CI / pipe）且未加 `--yes`**：印出預覽，若有任何待寫入的檔案則不寫入並回傳 `1`（若無須修改則回傳 `0`）。

---

## 輸出格式（`--format`）

退出碼（exit code）永遠只取決於檢查結果本身，**不會因為切換 `--format` 而改變**。

| 格式 | 適用對象 | 輸出特性 |
|---|---|---|
| `text` | 開發者終端機（預設） | 依元件分組，按「錯誤 → 偏離 → 提示」排序；標示 `[規則]`、`檔案:行` 與修正方式（可由 `devguard fix` 自動處理者會特別標註）；提示預設折疊為數量，`--verbose` 時展開 |
| `json` | CI、自動化腳本 | 輸出 `{ standard, components, findings }` JSON，每個 finding 含 `level`、`layer`、`rule`、`message`、`component`、`file`、`line`、`column`、`fix`、`fixable` |
| `sarif` | GitHub Code Scanning 等平台 | SARIF 2.1.0 JSON，**只包含 `layer === "code"` 的問題** |
| `vscode` | VS Code Problem Matcher | 每行一筆：`檔案:行:欄: 等級: 訊息 [規則]` |
| `claude` | Claude Code Hook / Skill | 精簡文字列表，最多列出前 **20 項**（其餘顯示「…還有 N 項」），總長度保證 **少於 4,000 字元** |

## Exit Code 定義

| Exit Code | 意義 |
|---|---|
| `0` | 檢查通過（無錯誤；若僅有偏離 `deviation` 或提示 `hint` 亦為 `0`），或 `fix` / `install` 已套用完成（或無須修改） |
| `1` | 檢查失敗（有 `error`；或加上 `--strict` 時有 `deviation`），或 `fix` / `install` 未套用待寫入變更（使用者取消，或非互動環境未加 `--yes`） |
| `2` | CLI 用法或執行環境錯誤（例如未知指令、不支援的格式、`--full` 與檔案同時指定、檔案不在 repo 內、`draft` 時 `.devguard.yaml` 已存在、`check` 時專案工具尚未安裝） |

---

## `devguard install` 與三道防線細節

`devguard install` 結合了 `devguard fix` 的設定檔產生、Claude Code 初次建置（`.claude/`），以及 git hooks 安裝（`pre-commit`、`pre-push`）：

### 1. VS Code 防線（`.vscode/`）
- 在 repo 根目錄維護單一份 `.vscode/settings.json`、`.vscode/extensions.json`、`.vscode/tasks.json`（皆須提交至 Git）。
- 自動針對專案包含的語言寫入推薦與不推薦的擴充套件、存檔格式化（Java 例外：關閉 `formatOnSave` 以免與 Spotless Palantir 規則衝突）、專案本地工具路徑（Python `.venv`、TypeScript `node_modules/typescript/lib`、Java `checkstyle.xml` 版本與路徑），以及 `standards: doctor`（開啟資料夾自動執行）、`standards: check`、`standards: fix`、`standards: test & coverage`、`standards: format (Spotless)` 等 tasks。

### 2. Claude Code 防線（`.claude/`）
- **`.claude/rules/standards-<元件>.md`**：以 frontmatter `paths` 綁定元件目錄與副檔名，於 Claude 讀寫該元件時載入規範摘要。
- **`.claude/settings.json`**：註冊三個 hook：
  - `SessionStart` → `devguard hook claude-session-start`（執行 `doctor --quiet` 並寫入 `.git/devguard/claude-last-seen`）
  - `PostToolUse`（matcher `Edit|Write`）→ `devguard hook claude-post-edit`（對剛編輯的檔案執行 lint + format，有誤時回傳 `decision: "block"`）
  - `Stop` → `devguard hook claude-stop`（對工作區所有變更檔案執行 lint + format + typecheck；若 `stop_hook_active` 為 true 且仍失敗則放行並顯示 `systemMessage`，防止無限迴圈）
- **`.claude/skills/standards-doctor/SKILL.md`**：提供 `/standards-doctor` 指令（`disable-model-invocation: true`），嵌入 `devguard doctor --format claude --exit-zero` 結果並在開發者同意後執行 `fix --yes`。

### 3. git hook 防線（`pre-commit` / `pre-push`）
- **原生安裝**：預設寫入 `.git/hooks/pre-commit` 與 `.git/hooks/pre-push`（含 `devguard-hook` 標記與 sha256 checksum）。
- **既有框架注入**：若 repo 已存在 `.pre-commit-config.yaml`（pre-commit）、`.husky/`（husky）或 `lefthook.yml` / `.toml` / `.json`（lefthook），CLI 不覆寫原有 hook，而是在框架設定中注入 `devguard hook git-pre-commit` 與 `devguard hook git-pre-push`。
- **部分 staged（partially staged）處理**：`pre-commit`（及 `check --staged`）不做 `git stash`，單檔工具（`ruff`、`eslint`、`prettier`、`biome`、`golangci-lint fmt --stdin`）透過 `git show :<path>` 讀取 staged 內容由 stdin 檢查；跨檔或無 stdin 模式的工具（`mypy`、`pyright`、`tsc`、`golangci-lint run`、Java wrapper）則檢查工作區檔案並印出提示。

---

## `devguard doctor`：本機環境檢查項目

`devguard doctor` 除了執行 `check` 的 15 道檢查層外，還會執行 `environment` 層（只回報並附上修正指令，不自動修改本機環境）：

1. **專案工具與啟動器是否已安裝**：檢查 `.venv`、`node_modules/.bin`、`go.mod` tool、Maven/Gradle wrapper，以及 PATH 上的 `golangci-lint`（`check` 遇到缺工具會直接以 exit `2` 中止；`doctor` 則將其列為一筆 `error` 並繼續跑完所有檢查）。
2. **git hook 安裝狀態**：檢查 `core.hooksPath` 是否衝突或被停用（如指向 `/dev/null`）、hook 檔案是否存在且 checksum 未被篡改（或既有框架已注入且 `pre-commit install` 已執行）。
3. **VS Code 擴充套件**：透過 `code --list-extensions --show-versions` 檢查推薦擴充套件是否已安裝（缺少為 `error`），以及是否安裝了不推薦的衝突擴充套件（`hint`）。
4. **Claude Code 環境**：檢查 `claude --version` 是否達到 `claude.minVersion`（預設 `2.1.295`），並檢查 `.git/devguard/claude-last-seen` 確認資料夾是否已被信任且執行過 hook。
5. **Go 使用者層級鏡像**：檢查 `go env GOPROXY` 與 `GOSUMDB` 是否指向內部鏡像，且 `GOSUMDB` 未被設為 `off`。
6. **內部鏡像帳密變數（`mirrors.auth: env`）**：只檢查環境變數或憑證檔是否存在（**絕不讀取或印出內容**）：
   - Python（uv）：`UV_INDEX_NEXUS_USERNAME` / `UV_INDEX_NEXUS_PASSWORD`（或 `NEXUS_USERNAME` / `NEXUS_PASSWORD`）
   - TypeScript（npm/pnpm/yarn）：`.npmrc` 引用的環境變數（如 `NEXUS_NPM_AUTH` 或 `NEXUS_NPM_TOKEN`）
   - Java（Maven）：`NEXUS_USERNAME` / `NEXUS_PASSWORD`
   - Java（Gradle）：`ORG_GRADLE_PROJECT_nexusUsername` / `ORG_GRADLE_PROJECT_nexusPassword`
   - Go：`NETRC` 指向的檔案或 `%USERPROFILE%\_netrc`
7. **標準版本更新提示**：若 CLI 內建了比 `.devguard.yaml` 更新的預設標準版本，提示執行 `devguard standard upgrade`。

---

## `devguard standard upgrade`：升級預設標準

當 CLI 內建了新版預設標準時：

```bash
devguard standard upgrade [目標版本]          # 預覽變更（不寫入檔案）
devguard standard upgrade [目標版本] --apply  # 實際套用升級
```

- **預覽內容**：列出舊版與目標版本的標準差異、專案既有 `overrides` 在新版下的重新判定結果（例如原本的收緊在新版已成為預設值而可移除，或原本的值在新版變成放寬而需補理由）、設定檔 diff，以及需要透過內部鏡像執行的套件管理指令（`uv`、`npm`、`go`）。
- **`--apply`**：更新 `.devguard.yaml` 的 `standard` 欄位、套用設定檔修補，並透過內部鏡像執行套件更新指令（Java 建置檔只印出修改片段，由開發者手動更新）。
