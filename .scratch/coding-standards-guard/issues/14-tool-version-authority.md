# 工具版本權威與一致性檢查

Type: grilling
Status: resolved
Blocked by: 07

## Question

每個 lint、型別檢查、測試工具的版本由誰決定、鎖在哪裡？如何讓 VS Code 擴充套件、Claude Code hook、git hook 實際執行的都是同一個版本？一致性檢查要比對哪些東西？

已知難點：
- Ruff 與 mypy 的 VS Code 擴充套件預設使用內建的工具版本。
- Checkstyle 擴充套件預設使用 9.3 版，設定檔路徑也要另外指定。
- Spotless 在 IDE 中沒有對應的擴充套件。
- Go 沒有內建的 coverage 門檻。
- 既有的 pre-commit 設定會把工具裝在自己的快取中。

候選做法：
- 工具版本跟著各語言自己的依賴管理（`package.json`、`pyproject.toml` / `uv.lock`、`go.mod` 的 tool、Maven / Gradle），專案宣告只指向它們。
- 由專案宣告直接鎖定工具版本。

依據：[四種語言的檢查工具鏈現況研究](03-language-toolchains.md)、[CLI 實作語言與分發方式決策](05-cli-runtime-decision.md)

## Answer

**版本由誰決定：分兩層**
- 預設標準為每個工具訂出**允許的版本範圍**，例如 `ruff >=0.15,<0.16`。
- 專案用各語言自己的依賴管理鎖定**確切版本**：
  - Python：`pyproject.toml` 的 dev group 加上 `uv.lock`
  - TypeScript：`devDependencies` 加上 lockfile
  - Go：`go.mod` 的 `tool`
  - Java：`pom.xml` 或 `build.gradle` 中的 plugin 版本
- CLI 檢查鎖定的版本是否落在範圍內。
- 專案若要使用範圍外的版本，視同放寬，必須照偏離規則寫 `reason` 與 `until`。

**golangci-lint 例外**：不放進 `go.mod` 的 `tool`。由團隊把指定版本的 binary 放到內部 Scoop bucket，版本寫在預設標準中；CLI 從 PATH 呼叫它，並檢查版本是否相符。

**CLI 一律執行專案環境中的工具**
- 執行方式：
  - Python：`uv run ruff`、`uv run mypy`
  - TypeScript：`node_modules/.bin/*`
  - Go：`go tool <名稱>`
  - Java：`./mvnw`、`./gradlew`
- 不使用全域安裝的工具。
- 工具尚未安裝時，CLI 不自行下載，而是報錯並附上一行安裝指令（例如 `uv sync`、`npm ci`），透過內部鏡像安裝。
- Claude Code 與 git hook 都經由 CLI 執行工具，所以自然一致。

**一致性檢查比對的項目與處理方式**

| 比對項目 | 不一致時 |
|---|---|
| 專案鎖定的版本是否落在預設標準的範圍內 | 錯誤 |
| VS Code 是否使用專案的工具：Ruff 與 mypy 擴充套件設為 `importStrategy: fromEnvironment`，直譯器指向 `.venv`；`typescript.tsdk` 指向專案的 `node_modules` | 錯誤，可用 `fix` 修正 |
| Checkstyle 擴充套件的 `java.checkstyle.version` 與設定檔路徑，是否和 Maven / Gradle plugin 相同 | 錯誤，可用 `fix` 修正 |
| 既有 pre-commit 框架中其他工具 hook 的 `rev`，是否和專案鎖定的版本相同 | 提示（真正的檢查由 CLI 執行，那些 hook 只是重複） |
| Pylance 內建的 pyright 版本 | 已知差異，接受（只影響選用 pyright 的專案） |

具體要產生哪些 VS Code 設定，由「VS Code workspace 設定設計」決定。
