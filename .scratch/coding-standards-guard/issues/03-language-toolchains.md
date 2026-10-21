# 四種語言的檢查工具鏈現況研究

Type: research
Status: resolved
Blocked by:

## Question

對 Python、Go、TypeScript、Java 各自整理現行主流工具，涵蓋標準的每個面向：

- coding standard / lint / format（例：ruff、golangci-lint、eslint + prettier / biome、checkstyle / spotless / PMD）
- complexity（cyclomatic / cognitive）如何設定上限
- test coverage 門檻（pytest-cov、go test -cover、vitest/jest、jacoco）
- dependency：lockfile、禁用 / 允許清單、弱點掃描（pip-audit、govulncheck、npm audit、OWASP dependency-check 等）
- 型別檢查（mypy / pyright、tsc）

每個工具註明：設定檔位置與格式、能否以 CLI 單獨執行、對應的 VS Code 官方擴充套件且是否讀同一份設定檔、Windows 支援情況、業界常見預設值（如 complexity 10、coverage 80%）。

產出：每語言一節的事實表，供四張「預設標準」票與「專案宣告格式」使用。

## Answer

- Python：Ruff（lint 與 format）、mypy 或 pyright、coverage.py `fail_under`、pip-audit。VS Code 擴充套件都讀同一份設定檔，但 Ruff 和 mypy 擴充套件內附自己的工具版本，有版本不一致的風險。
- Go：golangci-lint v2（`.golangci.yml`，必須寫 `version: "2"`，complexity 預設 cyclop 10、gocyclo/gocognit 30）與 govulncheck（不能忽略指定弱點，輸出 JSON 時一律 exit 0）。**Go 沒有原生的 coverage 門檻**。
- TypeScript：ESLint flat config（`complexity` 預設 20；擴充套件使用專案的 eslint）搭配 Prettier，或 Biome（認知複雜度預設 15 但不啟用、預設用 tab 縮排）。另有 tsc、Vitest/Jest thresholds、npm audit（預設有任何弱點就失敗）。
- Java：Checkstyle 與 PMD（complexity 都預設 10，PMD 認知複雜度 15）、Spotless、JaCoCo `check`、Dependency-Check（`failBuildOnCVSS` 預設 11，等於永遠不失敗）。VS Code 的 Checkstyle 擴充套件要另外指定設定檔路徑與版本（預設 9.3），Spotless 在 IDE 沒有對應。
- 共同點：業界常見 complexity 10、認知複雜度 15、coverage 80%，但各工具的 coverage 預設都是「不檢查」。在 Windows 上，Prettier 與 Biome 預設 `lf`，Spotless 依 `.gitattributes`，換行需要統一。

[研究結果](../research/03-language-toolchains.md)
