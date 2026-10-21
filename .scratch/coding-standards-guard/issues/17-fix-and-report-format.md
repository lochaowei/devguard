# fix 行為與檢查報告格式

Type: grilling
Status: resolved
Blocked by:

## Question

`<cli> fix` 的整體行為，以及給人看、給 CI 看的檢查報告格式各是什麼？

已經確定的部分：
- git hook 不做修正。
- `.vscode/` 用 `jsonc-parser` 只改 CLI 管理的 key，修正前先預覽差異。
- `standard upgrade` 預設只預覽，加上 `--apply` 才套用。
- `.gitattributes` 的 `* text=auto eol=lf` 是跨語言共用的修正項目。
- Claude Code 的回饋格式：JSON `reason` 最多列 20 項，少於 4,000 字元。
- VS Code 的輸出格式：每個問題一行，`檔案:行:欄: 等級: 訊息 [規則]`。

尚待決定：
- **修正的範圍**：`fix` 能改哪些東西。
  - 工具設定檔：`pyproject.toml`、`.golangci.yml`、`pom.xml`、`vitest.config.ts`……
  - 程式碼格式：執行 `ruff format`、`spotless:apply` 等。
  - `.claude/`、`.vscode/` 與 git hook。
  - 使用者層級的設定（例如 `~/.m2/settings.xml`）：與「內部鏡像設定檢查」相關。
- **修正方式**：TOML、YAML、XML、JS/TS 設定檔要怎麼局部修改並保留註解；`vitest.config.ts` 這類程式碼形式的設定檔，能改到什麼程度。
- **互動方式**：預設先預覽、再確認套用，還是直接套用？非互動環境（CI、Claude 代為執行）怎麼處理？
- **報告格式**：
  - 給人看的文字報告怎麼依元件、等級（錯誤、偏離、提示）、防線分組。
  - 給 CI 用的 JSON 長什麼樣、是否支援 SARIF。
  - exit code 的語意：錯誤、只有偏離、只有提示時各回傳什麼。

## Answer

**兩個修正指令**
- `<cli> fix`：只修設定，範圍包括各工具的設定檔、`.claude/`、`.vscode/`、git hook，以及 `.gitattributes` 與 `.gitignore` 中屬於標準的規則。
- `<cli> fix --code [files]`：修程式碼，包括格式化（`ruff format`、`gofumpt`、`prettier --write`、`spotless:apply`）與可自動修正的 lint（`ruff check --fix`、`eslint --fix`、`golangci-lint run --fix`）。git hook 失敗時印出的就是這個指令。
- 使用者層級的設定（例如 `~/.m2/settings.xml`、使用者的 `.npmrc`）兩個指令都不會修改，只印出修改說明。

**依檔案類別決定修改方式**

| 類別 | 範例 | 做法 |
|---|---|---|
| CLI 全權產生 | `checkstyle.xml`、PMD ruleset、`.claude/rules/*`、`/standards-doctor` skill、git hook、Dependency-Check suppression 檔 | 整份重新產生，檔頭標示「由 CLI 產生」 |
| 結構化的共用檔 | `pyproject.toml` 的 `[tool.*]`、`.golangci.yml`、`tsconfig.json`、`.prettierrc`、`.vscode/*`、`.claude/settings.json` | 只修改 CLI 管理的 key，保留註解與順序（YAML 用 `yaml`，JSONC 用 `jsonc-parser`，TOML 用能保留格式的函式庫） |
| 建置檔與程式碼形式的設定檔 | `pom.xml`、`build.gradle`、`vitest.config.ts`、`eslint.config.js` | 不自動修改，只印出要套用的片段或 diff |

實作前須先查證：TypeScript 生態中是否有能保留註解的 TOML 修改函式庫。如果沒有，`pyproject.toml` 改歸第三類。

**互動方式**
- 互動式終端機：先預覽，確認後才套用。
- 加上 `--yes`：直接套用。
- 非互動環境且沒有加 `--yes`：只預覽，並以非 0 結束。
- Claude 代為修正：`/standards-doctor` 先徵得開發者同意，再執行 `fix --yes`。

**`check` 與 `doctor` 的差別**
- `check` 執行設定、一致性與程式碼檢查，供 CI 與 git hook 使用。
- `doctor` 再加上環境檢查：擴充套件、hook 是否安裝、`claude-last-seen`、鏡像設定。

**報告格式**
- 文字報告：依元件分組，再依等級排序（錯誤、偏離、提示）。每一項都附上修正方式，標明能否用 `fix` 處理。最後一行總結各等級的數量。提示預設只顯示數量，加上 `--verbose` 才展開。
- `--format json`：`{ standard, components[], findings[] }`。每個 finding 包含 `level`、`component`、`layer`（設定、環境、一致性、程式碼）、`rule`、`file`、`line`、`message`、`fix`。
- `--format sarif`：只輸出程式碼類問題。
- `--format vscode` 與 `--format claude` 已在先前的票中定案。

**exit code**
- `0`：通過（只有偏離或提示時也算通過）。
- `1`：有錯誤。
- `2`：CLI 本身出錯，例如參數錯誤、找不到工具、內部例外。
- 加上 `--strict` 時，偏離也算失敗，回傳 `1`。
