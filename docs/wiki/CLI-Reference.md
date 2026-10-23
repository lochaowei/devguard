# CLI 指令與報告格式參考

## 指令總覽

```text
用法：devguard <指令> [選項]

指令：
  check [檔案…]  檢查專案宣告（.devguard.yaml）與程式碼；指定檔案時只檢查這些檔案
  fix            修正設定：先預覽，確認後套用；--yes 直接套用
  draft          沒有 .devguard.yaml 時，依偵測到的元件與工具設定產生宣告草稿（不覆寫既有檔案）

選項：
  --only <類別>         只跑一類程式碼檢查：lint|format|typecheck
  --full                跑全部檢查（不能與檔案一起使用）
  --format <格式>       輸出格式：text|json|sarif|vscode|claude（預設 text）
  --strict              偏離也算失敗
  --verbose             展開所有提示
  --cwd <dir>           專案根目錄（預設為目前目錄）
  --yes                 fix：不詢問，直接套用
  --version             顯示版本
  -h, --help            顯示用法說明
```

---

## `devguard check` 的檢查層（Check Layers）

`devguard check` 會依序執行 [`CHECK_LAYERS`](../../src/check.ts) 中的 11 道可插拔檢查層，並將所有發現的問題（`Finding`）合併為單一報告：

| 順序 | 檢查層 ID | 分類（`layer`） | 檢查內容 |
|---|---|---|---|
| 1 | `declaration` | `config` | 解析 `.devguard.yaml`、驗證標準版本、比對覆寫項目與偏離理由/到期日、檢查同語言風格一致性 |
| 2 | `uncovered-files` | `config` | 找出未被任何宣告元件涵蓋的四語言程式檔並發出提示 |
| 3 | `python-settings` | `config` | 檢查 `pyproject.toml` 的 Ruff（`target-version`、`line-length`、`lint.select`、`mccabe`、`flake8-tidy-imports`）與 mypy / pyright 設定 |
| 4 | `settings-go` | `config` | 檢查 `go.mod` 的 Go 版本與 `.golangci.yml`（`version: "2"`、linters、formatters、`cyclop`、`gocognit`、`gomodguard`、`depguard`） |
| 5 | `settings-java` | `config` | 檢查 Maven `pom.xml` / Gradle 建置檔版本與 plugin、Wrapper 是否存在、`checkstyle.xml`、PMD ruleset、`lombok.config` |
| 6 | `deps` | `config` | 檢查各語言 lockfile 是否提交至 git（含 `go mod tidy -diff`、Maven Enforcer、Gradle `gradle.lockfile`），以及直接依賴是否違反 `deps.banned` |
| 7 | `settings-typescript` | `config` | 檢查 `package.json`（`engines.node`）、`tsconfig.json`、ESLint flat config、Prettier、Biome、Vitest / Jest 覆蓋率門檻設定 |
| 8 | `tool-versions` | `consistency` | 從 lockfile / 建置檔讀出鎖定的工具版本（以及 PATH 上的 `golangci-lint` 版本），核對是否落在標準的 `tools.*` 版本範圍內 |
| 9 | `gitattributes` | `config` | 檢查 repo 根目錄 `.gitattributes` 是否包含 `* text=auto eol=lf` |
| 10 | `code` | `code` | 呼叫各元件環境中的工具執行 `lint`、`format`、`typecheck`（支援 `[檔案…]` 與 `--only` 過濾） |
| 11 | `tests` | `code` | **僅在 `--full`（且未指定 `--only`）時執行**：跑各元件的測試套件並驗證行 / 分支覆蓋率是否達標 |

---

## `devguard fix`：設定修正

`devguard fix` 會執行設定相關檢查層（`FIX_LAYERS`：`declaration`、`python-settings`、`settings-go`、`settings-java`、`settings-typescript`、`gitattributes`），收集所有 `Finding` 附帶的修補指令（`Repair`），並依 **4 種檔案類別** 規劃變更：

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
| `0` | 檢查通過（無錯誤；若僅有偏離 `deviation` 或提示 `hint` 亦為 `0`） |
| `1` | 檢查失敗（有 `error`；或加上 `--strict` 時有 `deviation`），或 `fix` 未套用待寫入變更 |
| `2` | CLI 用法或執行環境錯誤（例如未知指令、不支援的格式、`--full` 與檔案同時指定、檔案不在 repo 內、`draft` 時 `.devguard.yaml` 已存在） |
