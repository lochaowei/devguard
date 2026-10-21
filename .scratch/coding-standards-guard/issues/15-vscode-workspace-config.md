# VS Code workspace 設定設計

Type: grilling
Status: resolved
Blocked by: 08, 09, 10, 11, 14

## Question

第一道防線的 workspace 設定由 CLI 產生，內容應該包含什麼？已確定：`tasks.json` 使用 `"type": "process"` 搭配 problem matcher，另有一個 `runOn: folderOpen` 的任務執行 `<cli> doctor --quiet`。尚待決定：

- 每種語言要推薦哪些擴充套件（`extensions.json`）。
- `settings.json` 如何讓擴充套件讀專案共用的設定檔，並使用專案鎖定的工具版本。
- 如何偵測「推薦的擴充套件已安裝且已啟用」（環境檢查），例如透過 `code --list-extensions`。
- 產生的設定如何與開發者既有的 `.vscode/` 設定合併。

> 來自「Claude Code 防線整合設計」的備註：依照各防線的分工，VS Code 負責用擴充套件即時顯示 lint、格式與型別檢查的結果，測試與覆蓋率則以可手動執行的 task 提供。各語言要讓擴充套件使用專案工具的設定（例如 Ruff 與 mypy 的 `importStrategy: fromEnvironment`、`typescript.tsdk`、Checkstyle 的版本與設定檔路徑），已在「工具版本權威與一致性檢查」中列為一致性檢查項目。

## Answer

CLI 只產生專案宣告中用到的語言的設定。monorepo 只在 repo 根目錄放一份 `.vscode/`，各元件的差異用語言區段（例如 `[python]`）與 `workingDirectories` 這類設定表達。

**`extensions.json`**

| 語言 | `recommendations` | `unwantedRecommendations` |
|---|---|---|
| Python | `ms-python.python`、`charliermarsh.ruff`、`ms-python.mypy-type-checker` | `ms-python.black-formatter`、`ms-python.isort`、`ms-python.flake8`、`ms-python.pylint` |
| Go | `golang.go` | — |
| TypeScript | `dbaeumer.vscode-eslint`、`esbenp.prettier-vscode`（改用 Biome 時換成 `biomejs.biome`）、`vitest.explorer` | 選定其中一套後，另一套列為不推薦 |
| Java | `vscjava.vscode-java-pack`、`shengchen.vscode-checkstyle` | — |

**`settings.json`（只動 CLI 管理的 key）**
- **Python**
  - 存檔時用 Ruff 格式化，並執行 `fixAll` 與 `organizeImports`。
  - `ruff.importStrategy`、`mypy-type-checker.importStrategy` 都設為 `fromEnvironment`。
  - `python.defaultInterpreterPath` 指向 `.venv`。
  - mypy 的 `cwd` 設為 `${nearestConfig}`。
- **Go**
  - `go.lintTool` 設為 `golangci-lint-v2`，`go.lintOnSave` 設為 `package`。
  - gopls 開啟 `formatting.gofumpt: true`。
- **TypeScript**
  - 存檔時用 Prettier（或 Biome）格式化，並執行 `source.fixAll.eslint`。
  - `typescript.tsdk` 指向 `node_modules/typescript/lib`。
  - `eslint.workingDirectories` 列出各 TS 元件的目錄。
- **Java**
  - `java.checkstyle.configuration` 指向專案的 `checkstyle.xml`，`java.checkstyle.version` 與 Maven / Gradle plugin 的版本相同。
  - **Java 檔案關閉 `formatOnSave`**：IDE 的格式化結果與 palantir 不一致，所以格式化改用 Spotless task。
- **共通**：`files.eol: "\n"`。

**`tasks.json`**（一律使用 `"type": "process"`）
- `standards: doctor`：`<cli> doctor --quiet`，設定 `runOn: folderOpen`。
- `standards: check`：`<cli> check --format vscode`，搭配 CLI 提供的 problem matcher。輸出格式是每個問題一行：`檔案:行:欄: 等級: 訊息 [規則]`。
- `standards: fix`：`<cli> fix`。
- `standards: test & coverage`：`<cli> check --full --only test`。
- `standards: format (Spotless)`：只在有 Java 元件時產生。

**環境檢查**
- 用 `code --list-extensions --show-versions` 偵測已安裝的擴充套件。（能不能分辨「已安裝但被停用」尚未驗證，實作時需要確認。）
- 缺少推薦的擴充套件時回報錯誤；裝了不推薦的擴充套件時給提示。
- 擴充套件的安裝來源（內部 VSIX 來源或 Marketplace 代理）由「內部鏡像設定檢查」決定。

**與既有設定合併**
- 使用 Microsoft 的 `jsonc-parser` 做局部修改，保留原有的註解與格式。
- CLI 管理的 key 被改動時算錯誤；`fix` 會先預覽差異，再改回來。
- `settings.json`、`extensions.json`、`tasks.json` 必須提交。若 `.gitignore` 忽略了整個 `.vscode/`，CLI 會提示改成 `.vscode/*` 並加上 `!.vscode/settings.json` 等例外規則。
