# 內部鏡像設定檢查

Type: grilling
Status: resolved
Blocked by:

## Question

公司環境不允許下載外部檔案，所有工具與依賴都只能從公司內部鏡像取得。CLI 的設定檢查與環境檢查要怎麼確認每個工具都指向內部鏡像？需要決定：

- 各工具的鏡像設定放在哪裡、怎麼檢查：
  - Python：uv（`UV_INDEX_URL` / `uv.toml`）、pip
  - TypeScript：npm / pnpm / yarn（`.npmrc` 的 registry）
  - Go：`GOPROXY`、`GONOSUMDB` / `GOPRIVATE`、`GOTOOLCHAIN=local`
  - Java：Maven `settings.xml` 的 mirror、Gradle 的 repositories / init script
  - CLI 自身：Scoop bucket 指向的網址
- 內部鏡像的網址由誰提供、寫在哪裡：寫進預設標準、寫進專案宣告，還是放在使用者層級設定。
- 設定指向外部來源時，算錯誤還是提示？`<cli> fix` 能不能改寫使用者層級的設定檔（例如 `%USERPROFILE%\.m2\settings.xml`）？
- 開啟進階的弱點掃描時，各掃描工具的漏洞資料庫要從哪個內部來源取得（例如 Dependency-Check 指向內部 NVD 鏡像，pip-audit 是否可用）。

需要的事實：公司實際有哪些內部鏡像（Artifactory / Nexus 等）及其網址，由使用者在這張票中提供。

> 來自「工具版本權威與一致性檢查」的備註：內部 Scoop bucket 除了放 CLI 本身，也要放指定版本的 golangci-lint binary。

> 來自「VS Code workspace 設定設計」的備註：`code --install-extension` 會從 Marketplace 下載，在公司環境中不可行。需要決定 VS Code 擴充套件的內部來源（內部 VSIX 存放處或 Marketplace 代理），以及 `fix` 與 doctor 要怎麼提示安裝。

## 已知事實（使用者提供，2026-10-22）

- 內部套件庫使用 **Nexus**。實際網址目前連不上，規格中先用 dummy 網址代替：
  - 基本網址：`https://nexus.example.internal`
  - PyPI：`https://nexus.example.internal/repository/pypi-proxy/simple`
  - npm：`https://nexus.example.internal/repository/npm-proxy/`
  - Go：`https://nexus.example.internal/repository/go-proxy/`
  - Maven / Gradle：`https://nexus.example.internal/repository/maven-public/`
  - 工具 binary（CLI、golangci-lint）：`https://nexus.example.internal/repository/raw-tools/`
- VS Code 擴充套件：公司會提供**內部 marketplace**（dummy：`https://vsmarketplace.example.internal`）。
- 目前的鏡像設定方式：**由開發者各自修改**。

## Answer

**鏡像網址**
- 寫在預設標準中：`mirrors.pypi`、`mirrors.npm`、`mirrors.go`、`mirrors.maven`、`mirrors.vscode`、`mirrors.tools`，預設值為上方的 dummy 網址。
- 這幾項是**風格**項目，專案可以覆寫（例如部門自己的 Nexus），不需要寫理由。
- 網址異動時，發佈一個 minor 版本。

**設定的落地位置**：能放在專案層級的，由 CLI 產生並提交；只能放在使用者層級的，由 doctor 檢查並印出設定指令。

| 工具 | 位置 | fix 的處理方式 |
|---|---|---|
| uv | `pyproject.toml` 的 `[[tool.uv.index]]`（`default = true`） | 結構化共用檔，只改 CLI 管理的 key |
| npm / pnpm / yarn | 專案的 `.npmrc`（`registry=`） | 結構化共用檔，只改 CLI 管理的 key |
| Maven | `.mvn/maven.config` 加上 `--settings .mvn/settings.xml`（內含 mirror） | CLI 全權產生 |
| Gradle | `settings.gradle` 的 `dependencyResolutionManagement.repositories` | 建置檔，只印出片段 |
| Go | 使用者層級的 `go env -w GOPROXY=...` | doctor 印出指令；CLI 自己執行 Go 工具時直接帶入環境變數（連同 `GOTOOLCHAIN=local`） |

**設定指向外部來源時算錯誤。** Go 的 `GOSUMDB` 預設會連外部的 `sum.golang.org`，必須改為經由 Nexus 代理；若 Nexus 不支援，由公司決定是否關閉（實作時需查證 Nexus 是否支援）。

**帳密**（有些 Nexus 需要、有些不需要，依專案而定）
- 專案宣告新增 `mirrors.auth: none | env`，預設 `none`，屬於風格項目。
- `env` 模式統一使用環境變數 `NEXUS_USERNAME`、`NEXUS_PASSWORD`。專案層級的設定檔只引用這兩個變數，不寫入值：

  | 工具 | 引用方式 |
  |---|---|
  | npm | `.npmrc` 寫 `${NEXUS_NPM_AUTH}`（base64 格式） |
  | uv | `UV_INDEX_<名稱>_USERNAME` / `_PASSWORD` |
  | Maven | `.mvn/settings.xml` 的 `<server>` 寫 `${env.NEXUS_USERNAME}` |
  | Gradle | `ORG_GRADLE_PROJECT_*` 或 `~/.gradle/gradle.properties` |
  | Go | `%USERPROFILE%\_netrc` |

- 帳密絕不進 repo，CLI 也不保存。doctor 只檢查變數或 `_netrc` 是否存在，不讀取也不印出它們的值；缺少時說明如何在 Windows 設定使用者環境變數。
- npm 環境變數替換與 uv 各 index 的環境變數細節需在實作前查證。

**CLI 的分發**
- Scoop bucket 是一個放在公司內部 git 伺服器上的 repo。
- bucket 中的 manifest 指向 Nexus raw repository（`mirrors.tools`）裡的 CLI 與 golangci-lint exe。

**VS Code 擴充套件**
- 由公司內部 marketplace 提供（`mirrors.vscode`）。
- CLI 不檢查 VS Code 指向哪個 marketplace。缺少擴充套件時，提示開發者「請從公司內部 marketplace 安裝 `<id>`」並附上連結。
- 導入前提：所有推薦的擴充套件都必須能在內部 marketplace 取得，由團隊向 IT 確認。

**進階弱點掃描的資料來源**（預設關閉）
- 規格只記錄各工具可行的做法，開啟前需要查證：
  - Dependency-Check：使用內部 NVD 資料檔鏡像。
  - govulncheck：用 `-db` 指向內部鏡像。
  - npm audit：取決於 Nexus 的 npm 代理是否支援 audit。
  - pip-audit：取決於 Nexus 的 PyPI 代理是否保留漏洞資訊。
