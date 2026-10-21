# 預設標準：Go

Type: grilling
Status: resolved
Blocked by: 03, 07

## Question

Go 的預設標準是什麼？決定工具選型與各項門檻：golangci-lint 啟用的 linter、complexity 上限、coverage 門檻、dependency 規則（go.sum、禁用清單、弱點掃描工具），以專案宣告格式寫下。

> 來自「預設標準：Python」的備註：`deps.ignoredVulns`（需寫理由與到期日）預計四種語言共用，但 govulncheck 不支援忽略指定弱點，CLI 必須自行過濾它的 JSON 輸出；另外，govulncheck 在 JSON 模式下一律回傳 0，失敗與否也要由 CLI 判定。風格類項目（例如格式化設定）不需要理由。

## Answer

Go 預設標準（`team@1.0.0` 草案）。「類型」欄表示判斷「哪個方向算更嚴格」的方式，定義見[專案宣告格式](07-project-declaration-format.md)與[預設標準：Python](08-default-standard-python.md)（風格類型）。

| 標準項目 | 預設值 | 類型 | 落地方式 |
|---|---|---|---|
| `go.minVersion` | `1.26`（若專案 `go.mod` 寫的版本更高，以專案為準） | 下限 | `go.mod` 的 `go` 指令 |
| `lint.tool` | `golangci-lint`（v2） | 工具選擇 | `.golangci.yml`（`version: "2"`） |
| `lint.rules` | v2 預設組（`errcheck, govet, ineffassign, staticcheck, unused`）+ `gosec, revive, errorlint, bodyclose, misspell, cyclop, gocognit, gomodguard_v2, depguard` | 禁用清單同類（移除 linter 算放寬，新增算收緊） | `linters.enable` |
| `format.tools` | `gofumpt` + `goimports` | **風格** | golangci-lint `formatters`；VS Code gopls `formatting.gofumpt: true` |
| `complexity.cyclomatic` | `10` | 上限 | `cyclop.max-complexity` |
| `complexity.cognitive` | `15` | 上限 | `gocognit.min-complexity` |
| `coverage.lines` | `80`（排除帶 `// Code generated ... DO NOT EDIT.` 標頭的檔案與 `mocks/`） | 下限 | CLI 執行 `go test -coverprofile`，解析 `go tool cover -func` 的 total |
| `test.race` | 本機不強制（Windows 需要 cgo/gcc），留給 CI | — | — |
| `deps.lockfile` | `true`：`go.mod` + `go.sum` 必須提交，且 `go mod tidy -diff` 不能有差異 | 布林 | CLI 檢查 |
| `deps.vulnScan` | `false`（進階項目，預設關閉） | 布林 | 開啟後才套用以下兩項 |
| `deps.vulnFailOn` | 任何等級（govulncheck 沒有嚴重度分級） | 嚴重度 | CLI 以 source 模式執行 `govulncheck -json`，自行判定結果 |
| `deps.ignoredVulns` | 空；每一項都要寫 `reason` 與 `until` | 新增項目算放寬 | CLI 從 JSON 結果中扣除（govulncheck 本身不支援忽略） |
| `deps.banned` | `github.com/pkg/errors`、`github.com/golang/protobuf` | 禁用清單 | `gomodguard_v2` |
| `deps.bannedApis` | `io/ioutil` | 禁用清單 | `depguard`（必須寫明確規則，否則預設只允許標準庫） |

### 修訂（2026-10-22，來自[預設標準：Java](11-default-standard-java.md)）

公司環境不允許下載外部檔案，因此弱點掃描改為**進階項目，預設關閉**（`deps.vulnScan: false`）。專案自行開啟算收緊，不需要寫理由。上表中 `deps.vulnFailOn` 與 `deps.ignoredVulns` 只在開啟後才套用。所有工具與依賴都只能透過公司內部鏡像取得。

另外，CLI 執行 Go 工具時要強制設定 `GOTOOLCHAIN=local`，避免 `go.mod` 要求較新版本時自動下載工具鏈。
