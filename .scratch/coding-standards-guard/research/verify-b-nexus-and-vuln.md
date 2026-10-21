# 查證 B：Nexus 代理 Go sumdb 與弱點掃描工具的內網資料來源

對應 SPEC.md §5.3、§10.2、§12 第 4 項、§13 第 3 與第 5 項。查證日期：2026-10-22。前提：Nexus Repository 3.x（版本未知，以目前文件為準），開發者無法直接連外網。

---

## 1. §13-3：Nexus 的 Go 代理能否代理 `sum.golang.org`

**判定：⚠ 有條件**。Nexus 的 **Go proxy repository 本身不代理 sumdb**。要改用另一個 **raw proxy repository**，指向 `https://sum.golang.org`，再用 `GOSUMDB` 的 URL 欄位指過去。go 命令**不會**自動經由 Nexus 的 GOPROXY 取得 sumdb。

### 事實

- Sonatype 文件寫明 Go proxy repository 只存模組，不存 checksum 資料。要快取 checksum 資料（選用），需要建立一個 raw (proxy) repository，Remote storage URL 設為 `https://sum.golang.org`，並且**取消勾選 Strict Content Type Validation**。
  - https://help.sonatype.com/en/create-a-go-repository.html
- Go 的 sumdb 代理協定：client 先 GET `<proxyURL>/sumdb/<sumdb-name>/supported`。
  - 200：之後只透過該 proxy 存取 sumdb，不再直連。
  - 404 或 410：直連資料庫，也就是 `GOSUMDB` 裡的 URL，沒寫 URL 就用 `https://<name>`。
  - 其他回應：視為資料庫無法使用。
  - 來源：https://go.googlesource.com/proposal/+/master/design/25530-sumdb.md 。cmd/go 的 `modfetch/sumdb.go` 也是這樣實作：探測 `sumdb/<name>/supported`，收到 `fs.ErrNotExist` 時退回 `c.direct`。原始碼：https://github.com/golang/go/blob/master/src/cmd/go/internal/modfetch/sumdb.go
  - go.dev/ref/mod：「If a proxy in `GOPROXY` does this, the `go` command will not connect to the checksum database directly.」
- Nexus 的 Go proxy 對 `/sumdb/sum.golang.org/supported` 回 404。有社群案例的 `-x` 輸出證實這一點，結果 go 改成直連 `sum.golang.org`，在內網因此失敗；改用 raw proxy 並設定 `GOSUMDB` 後才可用。
  - https://community.sonatype.com/t/problem-getting-golang-proxy-repository-to-work/16122
  - 換句話說，自動機制在這裡**不會生效**，必須在 `GOSUMDB` 裡明確寫出 URL。
- `GOSUMDB` 的格式是 `name[+publickey] [url]`。`sum.golang.org` 的公鑰內建在 go 命令中，所以可以寫成 `GOSUMDB="sum.golang.org https://nexus.example.internal/repository/go-sum-proxy"`。
  - 用 `strings.Fields` 拆欄位，最多兩欄，第一欄透過 `knownGOSUMDB` 補上公鑰。
  - 簽章仍然用 sum.golang.org 的公鑰驗證，所以中間經過 Nexus 不會降低安全性。
  - 社群案例中出現的「malformed verifier id」錯誤，是因為 `+` 後面接了錯誤的公鑰。不要自己填公鑰。
- 其他變數，來源 go.dev/ref/mod 的 Environment variables：
  - `GOPRIVATE`：私有模組路徑的 glob 清單，是 `GONOPROXY` 與 `GONOSUMDB` 的預設值。
  - `GONOSUMDB`：符合的模組不經 sumdb 驗證。未設定時沿用 `GOPRIVATE`。
  - `GONOPROXY`：符合的模組直接從 VCS 取得，不經 proxy。
  - `GOINSECURE`：允許用 HTTP 等不安全方式取得，**不會**關閉 sumdb 驗證。
  - `GOFLAGS`：預設旗標，例如 `-mod=mod`，與 sumdb 無直接關係。go.dev/ref/mod 已說明舊的 `-insecure` 旗標不應再使用。
- `GOSUMDB=off` 的代價，引用 go.dev/ref/mod：「all unrecognized modules are accepted, at the cost of giving up the security guarantee of verified repeatable downloads for all modules」。
  - 也就是說，沒在 `go.sum` 裡的新模組完全不驗證。如果 Nexus 快取或上游被竄改，不會被發現。
  - 官方建議改用 `GOPRIVATE`/`GONOSUMDB` 只排除特定模組。

### 建議修改 SPEC.md

- §10.2 Go 那一列的「位置」改為 `go env -w GOPROXY=<mirrors.go> GOSUMDB="sum.golang.org <mirrors.gosumdb>"`，並在 §10.1 新增一列：`mirrors.gosumdb` = `https://nexus.example.internal/repository/go-sum-proxy`，註明「Nexus raw proxy → https://sum.golang.org，關閉 Strict Content Type Validation」。
- §10.2 第二點改為：「`GOSUMDB` 必須明確帶 URL 指向 `mirrors.gosumdb`。Nexus 的 Go proxy 對 `/sumdb/*/supported` 回 404，go 會退回直連而失敗。`GOSUMDB=off` 視為**錯誤**；內部模組用 `GOPRIVATE`/`GONOSUMDB` 排除。doctor 檢查 `GOSUMDB` 的第一欄是否為 `sum.golang.org`，並且不帶自訂公鑰。」
- §12 第 4 項改為：「Nexus 上建立 raw proxy `go-sum-proxy` 指向 sum.golang.org（除非公司決定關閉 sumdb，此時須明文接受風險）」。§13 第 3 項標記為已查證。

---

## 2. §13-5：各弱點掃描工具在內網的資料來源

### 2a. OWASP Dependency-Check

**判定：⚠ 有條件（可行，但需要一台能連 NVD API 的機器定期產生鏡像）**

- NVD 資料有兩種取得方式：
  - NVD API，需要 `nvdApiKey`。
  - 自架的 data feed：CLI 用 `--nvdDatafeed`，Maven 用 `nvdDatafeedUrl`，若需帳密再加 `nvdDatafeedServerId`。URL 樣板為 `https://internal.server/cache/nvdcve-{0}.json.gz`，`{0}` 會被替換成年份或 `modified`。
  - https://dependency-check.github.io/DependencyCheck/data/mirrornvd.html
  - https://dependency-check.github.io/DependencyCheck/dependency-check-maven/configuration.html
- 產生鏡像用 Open Vulnerability Project 的 `vulnz` CLI：`vulnz cve --cache --directory ./cache`，建議每天執行。
  - 產出 `nvdcve-YYYY.json.gz`/`.meta`、`nvdcve-modified.*` 與 `cache.properties`。
  - 另有 Docker image `jeremylong/open-vulnerability-data-mirror`，內含 Apache httpd。
  - 這些都是靜態檔，可以上傳到 Nexus **raw hosted** repository 提供下載（屬推論，文件只說用 web server，沒有點名 Nexus）。
  - 產生鏡像的那台機器需要能連 NVD API（沒有 API key 也能跑，但很慢）。
  - https://github.com/jeremylong/open-vulnerability-cli
- 需要連網的其他資料來源，與關閉或改指內網的方式：

  | 來源 | 關閉 | 改指鏡像 |
  |---|---|---|
  | CISA KEV（8.0.0 起預設開啟） | `--disableKnownExploited` / `knownExploitedEnabled=false` | `--kevURL` / `knownExploitedUrl` |
  | RetireJS | `--disableRetireJs` / `retireJsAnalyzerEnabled=false` | `--retireJsUrl` / `retireJsUrl`（檔名必須是 `jsrepository.json`） |
  | Hosted suppressions | `--disableHostedSuppressions` / `hostedSuppressionsEnabled=false`（下載失敗只會警告） | `--hostedSuppressionsUrl` |
  | Sonatype OSS Index（需要帳號，無法鏡像） | `--disableOssIndex` / `ossIndexAnalyzerEnabled=false` | — |
  | Central analyzer | Maven plugin 預設已關 | 改用 `nexusAnalyzerEnabled` + `nexusUrl` |
  | Node/Yarn/pnpm Audit | `--disableNodeAudit` / `--disableYarnAudit` / `--disablePnpmAudit` | `nodeAuditAnalyzerUrl` |

  來源：https://dependency-check.github.io/DependencyCheck/data/index.html 、https://dependency-check.github.io/DependencyCheck/dependency-check-cli/arguments.html
- 另一種做法：由一台更新節點建好 H2 資料庫，或使用集中式資料庫，其他節點用 `--noupdate` / `autoUpdate=false`。

**建議修改 SPEC.md §5.3：**「Dependency-Check：`nvdDatafeedUrl` 指向 `mirrors.tools` 下的 NVD 鏡像（由 IT 以 vulnz 每日產生並上傳到 raw hosted repository）。KEV 與 RetireJS 改指內部鏡像或關閉。OSS Index 一律關閉。Node Audit 關閉。」§12 新增：「IT 提供能連 NVD API 的排程節點與 raw hosted repository」。

### 2b. govulncheck

**判定：✅ 可行**

- `-db` 接受 `http://`、`https://`、`file://`。資料庫只要實作靜態 GET API 即可：`/index/db.json`、`/index/modules.json`、`/index/vulns.json`、`/ID/<id>.json`。這些端點沒有 query 參數也不需要特殊 header，所以靜態檔案系統就能提供。
  - 從 http(s) 讀取時會要求 `.json.gz`，從 file 讀取時用 `.json`。
  - 整包可以從 `https://vuln.go.dev/vulndb.zip` 下載。
  - https://go.dev/doc/security/vuln/database
  - https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck
- 內網做法：
  - (1) Nexus **raw proxy** 指向 `https://vuln.go.dev`。只用 GET，最簡單。index 檔的 metadata max age 要設短，否則資料會過時。屬推論，Sonatype 沒有專門文件。
  - (2) 下載 `vulndb.zip`，在本機解壓後用 `-db file:///…`。或放在 raw hosted repository，但要確認或補上 `.json.gz` 檔。zip 內是否附帶 `.gz` 檔〔未驗證〕。
- **Nexus 的 Go proxy repository 無法提供這份資料**：它只實作 GOPROXY 模組協定，不是 vulndb API。
- 注意：govulncheck 本身要先透過 `GOPROXY`（Nexus）安裝，這部分可行。

**建議修改 SPEC.md §5.3：**「govulncheck：`-db <mirrors.govulndb>`，預設為 Nexus raw proxy → https://vuln.go.dev。離線時可用 `vulndb.zip` 解壓後的 `file://` 路徑。」§10.1 新增 `mirrors.govulndb`。

### 2c. npm audit 經由 Nexus npm proxy

**判定：⚠ 有條件（需要 Sonatype Repository Firewall 授權；沒有 Firewall 時的行為沒有文件說明）**

- Sonatype 文件：npm audit 的資料來源是 Repository Firewall，「Requires a license for Sonatype Repository Firewall」，支援 proxy 與 group repository。npm 7 以上依 root organization policies 評估，app_id header 只有 npm 6 支援。結果快取 12 小時。
  - https://help.sonatype.com/en/npm-audit.html
- Nexus 已實作 **bulk endpoint**（`/-/npm/v1/security/advisories/bulk`）。3.82.0 的 NEXUS-47013 讓唯讀與匿名使用者也能呼叫 bulk endpoint，3.88.0 修正 group 的 audit 追蹤。所以 **3.82 以前的版本，唯讀帳號可能無法使用**。
  - https://help.sonatype.com/en/sonatype-nexus-repository-3-82-0-release-notes.html
  - https://help.sonatype.com/en/sonatype-nexus-repository-3-88-0-release-notes.html
- 沒有 Firewall 授權時，Nexus 是否把 audit 請求轉給 npmjs、或直接回錯誤，**官方文件沒有說明**〔未驗證〕。即使會轉送，內網的 Nexus 本身仍需能連 registry.npmjs.org。
- npm 端的變化：npm 7 起改用 bulk endpoint，失敗時才退回 quick audit。根據 JFrog 公告（不是 npm 官方原文），npm 已在 **2026-07-15 永久停用** `/-/npm/v1/security/audits` 與 `/audits/quick`，現在回 410。
  - 受影響的 client：npm ≤7、pnpm ≤10、Yarn ≤3 會失敗。npm 8+、pnpm 11+、Yarn 4+ 使用 bulk endpoint，不受影響。
  - https://docs.npmjs.com/cli/v10/commands/npm-audit
  - https://jfrog.com/help/r/artifactory-npm-legacy-audit-api-endpoints-retired
- Edition：Nexus 的 OSS/Community 或 Pro 本身不提供 audit 資料，需要另購 Firewall（或 Lifecycle）。
  - https://www.sonatype.com/blog/new-in-nexus-repository-3.23-nexus-intelligence-via-npm-audit

**建議修改 SPEC.md §5.3：**「npm audit：只有在公司有 Sonatype Repository Firewall 授權、且 npm proxy 已啟用 Firewall audit 時才可用。需要 Nexus ≥ 3.82（唯讀帳號可用 bulk endpoint）與 npm ≥ 8 / pnpm ≥ 11。doctor 用一次 POST `/-/npm/v1/security/advisories/bulk` 探測。回 4xx/5xx 時，`deps.vulnScan` 對 TypeScript 元件視為不可用（提示，不算錯誤）。」§12 新增：「確認是否有 Repository Firewall 授權」。

### 2d. pip-audit 經由 Nexus PyPI proxy

**判定：❌ 不可行（以 Nexus PyPI proxy 作為漏洞來源）；⚠ 有條件（改用 OSV 自架或 HTTP 轉送代理）**

- pip-audit 的 `-s/--vulnerability-service` 有三種：`pypi`（預設）、`osv`、`esms`。
  - `pypi` service 的 URL **寫死**為 `https://pypi.org/pypi/{name}/{version}/json`，讀取 `vulnerabilities` 欄位，**不能設定**。`--index-url` 只用於 pip 解析依賴。
  - 如果回應中沒有 `vulnerabilities` 欄位，pip-audit 會當成「沒有漏洞」，有**靜默漏報**的風險。
  - `esms`（ecosyste.ms）的 URL 同樣寫死。
  - `osv` 可以用 `--osv-url` 改指自訂端點，預設是 `https://api.osv.dev/v1/query`，使用 POST。
  - https://github.com/pypa/pip-audit/blob/main/README.md
  - https://github.com/pypa/pip-audit/blob/main/pip_audit/_service/pypi.py
- Nexus PyPI repository 支援 PEP 503 Simple API，3.93 起支援 PEP 691 JSON，3.94 起支援 PEP 700。文件**沒有提到** PyPI 的 JSON API（`/pypi/<name>/<ver>/json`）或 `vulnerabilities` 欄位。況且 pip-audit 根本不會去 Nexus 查。
  - https://help.sonatype.com/en/pypi-repositories.html
- Nexus raw proxy 只代理 GET，無法代理 OSV 的 POST `/v1/query`（屬推論）。
- 可行的替代方案：
  - (1) 公司的 HTTPS 轉送代理放行 `api.osv.dev`，pip-audit 經由 `HTTPS_PROXY` 連出。
  - (2) 自架 OSV 相容 API，再用 `--osv-url` 指過去。
  - (3) 改用 **osv-scanner** 的 `--offline-vulnerabilities`：讀取本機 `{ecosystem}/all.zip`，來源是 `https://osv-vulnerabilities.storage.googleapis.com/<ECOSYSTEM>/all.zip`，可以用 Nexus raw proxy 或 raw hosted 提供。同一支工具涵蓋 PyPI、npm、Go、Maven。
  - https://google.github.io/osv-scanner/usage/offline-mode/

**建議修改 SPEC.md §5.3：**「pip-audit：不能經由 Nexus PyPI proxy 取得漏洞資料（PyPI service 的 URL 寫死為 pypi.org）。只有使用 `-s osv --osv-url <內部 OSV 相容端點>`，或公司放行 api.osv.dev 時才可用。否則改用 osv-scanner 離線模式，資料檔放在 `mirrors.tools`。」建議 §13 新增一項：「評估以 osv-scanner 離線模式統一取代 npm audit / pip-audit 的可行性」。

---

## 總結

| 項目 | 判定 | 關鍵 |
|---|---|---|
| Go sumdb 經由 Nexus | ⚠ | 需要另建 raw proxy，`GOSUMDB="sum.golang.org <url>"`；Go proxy 對 `/sumdb/*/supported` 回 404 |
| Dependency-Check | ⚠ | vulnz 產生 NVD 鏡像並放到 raw hosted；KEV/RetireJS 改指鏡像，OSS Index 與 Node Audit 關閉 |
| govulncheck | ✅ | `-db` 指向 raw proxy → vuln.go.dev，或用 `file://` |
| npm audit | ⚠ | 需要 Firewall 授權、Nexus ≥3.82、npm ≥8 |
| pip-audit | ❌/⚠ | PyPI service 寫死 pypi.org；只能用 OSV（`--osv-url`）或改用 osv-scanner 離線模式 |
