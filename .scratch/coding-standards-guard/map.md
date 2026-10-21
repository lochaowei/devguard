# Map: 多語言開發規範三道防線 plugin

Label: wayfinder:map

## Destination

一份定案的**實作規格**：一支以 CLI 為核心的工具（由 CLI 在專案中產生 VS Code、Claude Code、git hook 的設定），讓 Java / Python / Go / TypeScript 專案能以「預設標準 + 專案宣告」這一份單一事實來源，同時驅動並**檢查 + 修正**三道防線（VS Code、Claude Code、pre-commit）。規格中每種語言、每道防線都有明確選型，可直接交付實作。

## Notes

- 領域用語見 [GLOSSARY.md](../../GLOSSARY.md)（標準、預設標準、專案宣告、偏離、防線、檢查、修正）。每個 session 先讀它。
- 每張 grilling 票都要呼叫 `grilling` 與 `domain-modeling` skill；新名詞即時寫入 GLOSSARY.md。
- 已定的大前提（終點 grilling 的結論）：
  - 先檢查再修正；檢查三層：設定 / 環境 / 一致性。
  - 三道防線共用同一套底層工具與設定檔，只差觸發時機。
  - 專案宣告為主、偵測既有設定檔為輔（無宣告時依既有設定產生草稿）。
  - 專案可放寬標準，但須在宣告中寫理由，檢查時標示為偏離。
  - 支援多 repo 與 monorepo（一個 repo 多語言，依目錄套用）。
  - dependency 規範 = lockfile/版本鎖定 + 禁用/允許清單；弱點掃描是**進階項目，預設關閉**。
  - **公司環境不允許下載外部檔案**：所有工具與依賴都只能透過公司內部鏡像取得，CLI 本身不連外網。
  - Claude Code 防線 = 事前（`.claude/rules` 告知標準）+ 事中（PostToolUse / Stop hook 執行檢查並回饋）+ 診斷（`/standards-doctor` skill）；不做 plugin。
  - VS Code 防線只用 workspace 設定（settings / extensions / tasks），不自寫 extension。
- 平台以 **Windows** 為主（路徑、換行、hook 用的 shell 都要考慮）。
- 預設標準的**內容**在本地圖內定案；各專案自訂規範的內容不在此決定。
- 溝通語言：繁體中文。

## Decisions so far

<!-- one line per closed ticket: [title](link): gist -->

- [CLI 實作語言與 Windows 分發選項研究](issues/01-cli-runtime-options.md)：Windows 上單一 `.exe` 最穩（hook exec form 不吃 npm `.cmd` shim）；若採 pre-commit 則 Python 本來就在，Python CLI 缺點縮小。
- [Claude Code 擴充機制研究](issues/04-claude-code-mechanisms.md)：事前用 `.claude/rules` 依路徑注入（plugin 內需用 skill）、事中用 PostToolUse `Edit|Write` hook 以 exit 2 回饋（Bash 改檔不觸發）、診斷即 skill；團隊安裝靠 `.claude/settings.json` 的 marketplace 設定（需 workspace trust）。
- [pre-commit 框架比較研究（多語言 + Windows）](issues/02-precommit-framework-options.md)：四種做法在 Windows 上都靠 Git for Windows 的 sh 執行 hook；husky 與 pre-commit 會在 `core.hooksPath` 上衝突；pre-commit 的 staged-only 最完整但工具裝在自己的快取（與 IDE 版本分離）、無原生 Java；lefthook 是單一 binary 且用專案自己的依賴，較易與 IDE 版本一致。
- [四種語言的檢查工具鏈現況研究](issues/03-language-toolchains.md)：Python / TS / Go 的 VS Code 擴充套件可讀專案同一份設定檔，Java（Checkstyle 擴充套件需另設路徑與版本、Spotless 無 IDE 對應）只部分可行；Ruff / mypy 擴充套件內建版本會與專案鎖定版本漂移；各弱點掃描工具的失敗語意不一致，需由 CLI 統一判定。
- [CLI 實作語言與分發方式決策](issues/05-cli-runtime-decision.md)：TypeScript + Bun 編譯成單一 `.exe`，透過自架 Scoop bucket 分發；三道防線都直接呼叫 PATH 上的 `<cli>` 專用子指令；由 CLI 自己安裝 git hook（只做檢查、找不到 CLI 就擋下），遇到既有框架改為注入；用 VS Code `folderOpen` 任務與 Claude Code `SessionStart` 執行 doctor，催促開發者安裝。
- [pre-commit 框架決策](issues/06-precommit-framework-decision.md)：併入上一張決策，結論是不採用任何 hook 框架。
- [專案宣告格式](issues/07-project-declaration-format.md)：根目錄單一 YAML（暫名 `.standards.yaml`），`standard@版本` 加上元件清單（目錄 + 語言）；放寬要寫 `{value, reason, until?}` 並標示為偏離，過期就變回錯誤；檔案歸屬取路徑最長且語言相符的元件，找不到時依副檔名推定語言、套用預設標準；沒有宣告時依既有設定產生帶 TODO 理由的草稿。
- [預設標準：Python](issues/08-default-standard-python.md)：Ruff 負責 lint 與 format（行寬 120、循環複雜度 10）；mypy strict（可改用 pyright）；pytest-cov 覆蓋率 80% 含分支；uv lockfile；（進階）開啟弱點掃描後，pip-audit 有任何弱點就擋；宣告模型新增「風格」類型，覆寫不需要理由。
- [預設標準：Go](issues/09-default-standard-go.md)：Go 1.26 起；golangci-lint v2 用預設組再加安全、錯誤處理、複雜度、禁用清單等 linter；gofumpt + goimports；循環複雜度 10、認知複雜度 15；覆蓋率 80%，由 CLI 解析判定；`go mod tidy -diff` 必須乾淨；（進階）開啟弱點掃描後，govulncheck 有任何弱點就擋；強制 `GOTOOLCHAIN=local`；`-race` 留給 CI。
- [預設標準：TypeScript](issues/10-default-standard-typescript.md)：Node 22 起；ESLint 的 `strictTypeChecked` 加 Prettier（可改用 Biome）；行寬 120、換行 LF，並由 `.gitattributes` 統一換行；tsconfig strict 再加三個選項；循環複雜度 10、認知複雜度 15（sonarjs）；Vitest 四項覆蓋率都 80%；npm 的 lockfile 必須提交；（進階）開啟弱點掃描後，npm audit 遇 high 以上就擋。
- [預設標準：Java](issues/11-default-standard-java.md)：Java 17 起；Maven 或 Gradle 都可以，但必須提交 wrapper；Spotless 用 palantir（行寬 120）；Checkstyle 與 PMD 檢查循環複雜度 10、認知複雜度 15；JaCoCo 行與分支覆蓋率都要 80%；Maven 用 Enforcer、Gradle 用 lockfile 鎖定依賴；**四種語言的弱點掃描都改為進階項目，預設關閉；只能使用內部鏡像**。
- [工具版本權威與一致性檢查](issues/14-tool-version-authority.md)：預設標準訂出工具的版本範圍，專案用各語言的依賴管理鎖定確切版本；CLI 一律執行專案環境中的工具，未安裝時報錯而不自行下載；golangci-lint 的 binary 放在內部 Scoop bucket；一致性檢查比對版本範圍、VS Code 是否使用專案的工具、Checkstyle 版本，以及既有 pre-commit 的 `rev`。
- [預設標準的版本發佈與專案升級方式](issues/12-standards-versioning.md)：標準內建在 CLI 中，不需連網即可解析；major 版本代表可能讓原本通過的專案失敗；專案宣告寫確切版本；CLI 支援目前與前一個 major 版本；`standard upgrade` 預設只預覽，加上 `--apply` 才套用；被棄用的版本過了截止日就回報錯誤。
- [Claude Code 防線整合設計](issues/13-claude-code-integration.md)：不做 plugin，由 CLI 產生 `.claude/settings.json` 的 hooks、依元件產生 rules 與 `/standards-doctor` skill；PostToolUse 只檢查被編輯的檔案，Stop 檢查這一輪改過的所有檔案；`onFailure: block`；以 `claude-last-seen` 檔案間接偵測資料夾是否已信任；訂出各防線執行哪些檢查，並新增 pre-push hook 負責測試與覆蓋率。
- [VS Code workspace 設定設計](issues/15-vscode-workspace-config.md)：依語言訂出推薦與不推薦的擴充套件；`settings.json` 讓擴充套件使用專案的工具，Java 關閉存檔時格式化、改用 Spotless task；`tasks.json` 提供 doctor（開啟資料夾時執行）、check（搭配 problem matcher）、fix、測試等任務；用 `jsonc-parser` 只修改 CLI 管理的 key；三個設定檔必須提交。
- [fix 行為與檢查報告格式](issues/17-fix-and-report-format.md)：`fix` 修設定、`fix --code` 修程式碼，使用者層級設定都不碰；依檔案類別分成整份重新產生、只改 CLI 管理的 key、只印片段三種做法；預設先預覽，`--yes` 直接套用；`check` 不含環境檢查，`doctor` 包含；提供文字、JSON、SARIF 報告；exit code 0 / 1 / 2，加 `--strict` 時偏離也算失敗。
- [內部鏡像設定檢查](issues/16-internal-mirror-config.md)：鏡像網址（Nexus，目前為 dummy）寫在預設標準中；能放在專案層級的鏡像設定就提交進 repo，Go 只能放使用者層級，由 doctor 印出指令；指向外部來源算錯誤；需要帳密時以 `mirrors.auth: env` 引用 `NEXUS_*` 環境變數，帳密絕不進 repo；Scoop bucket 放在內部 git，binary 放在 Nexus raw；VS Code 擴充套件從內部 marketplace 安裝。

## Not yet specified

（目前沒有。所有票都已解決，規格已彙整為 [SPEC.md](../../SPEC.md)。）

## Out of scope

- 授權（license）檢查：之後另行處理。
- 自寫 VS Code extension：官方語言擴充套件已能即時顯示問題。
- Claude Code plugin 與 marketplace：改由 CLI 在專案中產生 `.claude/` 設定，不需要另外安裝，也不需要內部 marketplace。
- CI（第四道防線）：不在本次範圍，但 CLI 設計須能直接在 CI 執行。
- 實作本身：本地圖只產出規格。
- 標準的治理流程（誰能修改、如何審核、多久發佈一次）：屬於組織流程，由團隊自訂；規格只要求原始檔放在內部 repo，且依版本號規則發佈。
