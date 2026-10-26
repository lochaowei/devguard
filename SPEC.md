# 規格書：多語言開發規範三道防線工具

> 狀態：規格定案，可交付實作（2026-10-22）
> 來源：wayfinder 地圖 [map.md](.scratch/coding-standards-guard/map.md) 的 17 張決策票。每一節都附上來源票的連結；本文件與票的內容不一致時，以**本文件**為準（本文件已納入所有修訂）。
> 用語定義見 [GLOSSARY.md](GLOSSARY.md)。
> 名稱：CLI 名為 `devguard`，宣告檔為 `.devguard.yaml`。佔位符號：所有 Nexus 網址都是 dummy。
> 查證：§13 原列的 9 個項目已於 2026-10-22 查證，結果見 `.scratch/coding-standards-guard/research/verify-*.md`，修正已併入本文；剩下必須實機測試或由他人決定的項目，列在 §12 與 §13。

---

## 1. 目標與範圍

團隊以 Java、Python、Go、TypeScript 開發，每種語言都有規範（coding standard、complexity、test coverage、dependency），但不一定每個人都會遵守。本工具讓每個專案用**一份單一事實來源**（預設標準 + 專案宣告），驅動並**檢查、修正**三道防線：

| 防線 | 時機 | 作用 |
|---|---|---|
| 第一道：VS Code | 撰寫時 | 擴充套件即時顯示問題 |
| 第二道：Claude Code | Claude 編輯檔案時 | 事前告知標準、事中檢查並回饋、提供診斷指令 |
| 第三道：git hook | commit 與 push 時 | pre-commit 擋下不合格的變更；pre-push 跑完整測試 |

**核心原則**
- 先檢查，再修正。修正一定先預覽，或由開發者明確下指令才執行。
- 三道防線共用同一套底層工具與設定檔，差別只在觸發時機。
- 檢查分三層：**設定檢查**（設定檔是否符合標準）、**環境檢查**（本機是否真的生效）、**一致性檢查**（三道防線用的工具與版本是否相同）。
- 開發者主要使用 **Windows**。
- **公司環境不允許下載外部檔案**：所有工具與依賴都只能透過公司內部的 Nexus 與內部 marketplace 取得，CLI 本身不連外網。

**範圍外**
- 授權（license）檢查
- 自寫 VS Code extension
- Claude Code plugin 與 marketplace
- CI（第四道防線）。不在範圍內，但 CLI 必須能直接在 CI 執行
- 標準的治理流程（誰能修改、審核方式、發佈頻率）

---

## 2. 架構

```
            ┌────────────── 預設標準（內建在 CLI，team@x.y.z）
            │                       ＋
            │               專案宣告 .devguard.yaml
            ▼
        ┌────────┐   產生 / 檢查 / 修正
        │ devguard  │──────────────────────────────┐
        └────────┘                              │
     ▲      ▲       ▲                           ▼
     │      │       │                .vscode/  .claude/  .git/hooks
 VS Code  Claude   git hook          各工具設定檔（ruff、eslint、golangci…）
  task    hook    (sh 一行)
```

- **CLI 是唯一的權威**。三道防線都只呼叫 `devguard` 的子指令，各防線的設定檔只有一行。
- CLI 一律執行**專案環境中鎖定版本的工具**，不使用全域安裝的工具。
- 不使用任何第三方 hook 框架，也不做 Claude Code plugin。

來源：[CLI 實作語言與分發方式決策](.scratch/coding-standards-guard/issues/05-cli-runtime-decision.md)、[pre-commit 框架決策](.scratch/coding-standards-guard/issues/06-precommit-framework-decision.md)、[Claude Code 防線整合設計](.scratch/coding-standards-guard/issues/13-claude-code-integration.md)

---

## 3. CLI 本身

### 3.1 實作與分發

- **語言**：TypeScript。CLI 本身也遵守 §6.3 的 TypeScript 預設標準。
- **打包**：用 Bun `--compile` 打包成單一 `.exe`（windows-x64、windows-arm64），這是唯一的發佈形式。
  - Bun 必須 **≥1.2.23**（已在 1.4.4 驗證，見 §13 T1、T2）。
  - 在 **Windows runner 上建置**，因為交叉編譯時無法設定 `--windows-icon` 與版本資訊。windows-arm64 在 x64 主機上交叉編譯時，Bun 會從外網下載 arm64 runtime，所以在無法連外的環境必須改在 arm64 的 Windows 上建置。
  - 建置後執行 smoke test：在 PATH 中沒有 Node 的情況下跑 `devguard --version` 與 `devguard check`。
  - exe **不簽章**（原本規劃的 signtool 簽章已取消，見 #28）。
- **分發**：以 **GitHub Release** 發佈建置好的 exe。推送 `v<版本>` tag 時，`.github/workflows/release.yml` 在 Windows runner 上執行測試、建置兩個 exe、跑 smoke test，並把 `devguard-windows-x64.exe`、`devguard-windows-arm64.exe` 與 `SHA256SUMS.txt` 附加到 release。tag 必須和 `package.json` 的版本相同。
  - 開發者下載 exe、改名為 `devguard.exe` 並放進 PATH；更新時用新版取代。CLI 找不到或版本過舊時，訊息會指向 release 頁面。
  - 放在 PATH 上的是真正的 `.exe`，Claude Code 的 exec form hook 可以直接呼叫。
  - 原本規劃的內部 Scoop bucket 與 Nexus raw repository 已取消（#28）。
- **golangci-lint** 仍是 §5.2 的例外：使用預設標準指定版本的 binary，由開發者放到 PATH，CLI 從 PATH 呼叫並核對版本。
- **預設標準內建在 CLI 中**（見 §5.5），所以 CLI 不需要連網就能解析專案宣告。

來源：[CLI 實作語言與 Windows 分發選項研究](.scratch/coding-standards-guard/research/01-cli-runtime-options.md)、[CLI 實作語言與分發方式決策](.scratch/coding-standards-guard/issues/05-cli-runtime-decision.md)、[內部鏡像設定檢查](.scratch/coding-standards-guard/issues/16-internal-mirror-config.md)

### 3.2 指令一覽

| 指令 | 用途 |
|---|---|
| `devguard install` | 在專案中產生各防線的設定（`.vscode/`、`.claude/`、git hook、工具設定檔、鏡像設定），並安裝 pre-commit 與 pre-push hook |
| `devguard check [檔案…] [--staged] [--full] [--only <類別>] [--format text\|json\|sarif\|vscode\|claude] [--strict] [--verbose]` | 執行設定、一致性與程式碼檢查，不含環境檢查。指定檔案時只對這些檔案跑程式碼檢查。供 CI 與 git hook 使用。`--staged` 只檢查 staged 的檔案，內容與 pre-commit hook 相同 |
| `devguard doctor [--quiet] [--exit-zero] [--format …]` | `check` 加上環境檢查（擴充套件、hook 是否安裝、Claude Code、鏡像、帳密變數是否存在）。`--exit-zero`：有問題時也以 0 結束，給 `/standards-doctor` skill 嵌入結果用（§7.3） |
| `devguard draft` | 專案尚無 `.devguard.yaml` 時，依偵測到的元件與既有工具設定產生宣告草稿（§4.3），不覆寫既有檔案 |
| `devguard fix [--yes]` | 修正**設定**（§9） |
| `devguard fix --code [files] [--yes]` | 修正**程式碼**：格式化與可自動修正的 lint |
| `devguard standard upgrade [目標版本] [--apply]` | 預覽或套用標準升級（§5.5） |
| `devguard hook git-pre-commit` / `git-pre-push` | 給 git hook 呼叫 |
| `devguard hook claude-post-edit` / `claude-stop` / `claude-session-start` | 給 Claude Code hook 呼叫，從 stdin 讀取 hook 的 JSON 輸入 |

- 每個指令都接受 `--cwd <dir>`，指定專案根目錄（預設為目前目錄）。
- 各 `hook` 子指令自行處理該防線的輸入格式與 exit code 語意。
- CLI 執行 Go 工具時，一律帶入 `GOTOOLCHAIN=local`。golangci-lint 與套件管理指令另外帶入鏡像相關的環境變數；`go tool <名稱>` 與 `go mod` 等檢查用的指令則帶入 `GOPROXY=off`，確保檢查時不會下載任何模組（模組不在快取中時，該次執行失敗，而不是改為下載）。
- **`.cmd` / `.bat` 檔一律透過 `cmd.exe /d /s /c` 執行**，例如 `code.cmd`、`mvnw.cmd`、`gradlew.bat`、`npm.cmd`。這類檔案無法直接當作程序啟動。

---

## 4. 專案宣告（`.devguard.yaml`）

放在 repo 根目錄的單一 YAML 檔。

```yaml
standard: team@1.0.0            # 繼承哪一版預設標準（必須寫確切版本）
components:                     # 元件 = 目錄 + 語言
  - path: ./
    language: python
  - path: backend/
    language: go
  - path: web/
    language: typescript
    overrides:
      complexity.cyclomatic: 8              # 收緊：直接寫值
      lint.tool: biome                      # 允許清單內的替代工具：直接寫值
      format.printWidth: 100                # 風格項目：直接寫值
      coverage.lines:                       # 放寬：必須寫理由，可加到期日
        value: 60
        reason: "舊程式碼補測試中，2027 Q1 回到 80"
        until: 2027-03-31
mirrors:
  auth: env                     # none（預設）| env，見 §10.3
ignore:                         # 選填：不歸屬任何元件、不受檢查的路徑，見 §4.1
  - examples/
  - third_party/
  - "**/*.pb.go"
```

### 4.1 元件與檔案歸屬

- 一個元件 = 一個 `path` 加一個 `language`。同一個目錄有多種語言時，就寫成多個元件。
- 每個檔案歸屬於**路徑前綴最長、而且語言和副檔名相符**的元件。
- 沒有元件涵蓋的程式檔，**依副檔名推定語言**，套用該語言的預設標準（不含覆寫），並提示「建議在宣告中補上元件」。
- 頂層 `ignore` 是字串清單，列出範例、第三方嵌入原始碼、自動產生檔等不受檢查的路徑。一般路徑符合該檔案或該目錄底下的所有檔案；glob（`*`、`?` 不跨越 `/`，`**` 跨越多層）符合的路徑或符合的目錄底下的所有檔案。路徑相對於 repo 根目錄。
  - 符合的檔案不歸屬任何元件、不提示「建議補上元件」，也不交給 `check`、`fix --code` 與各 hook 的程式碼、測試與弱點掃描檢查，即使在命令列上指定或已 staged。
  - 以整個目錄為單位執行的工具（元件的 `eslint .`、`tsc`、`mypy` 等）仍依各自的設定決定範圍。
  - 不是非空字串的清單時：**錯誤**（`declaration/invalid`），整份清單不生效。
- 四種語言以外的檔案不在檢查範圍內。例外：指定檔案時（含 `--staged` 與各 hook，見 §7.1），TypeScript 元件內 formatter（Prettier 或 Biome）會處理的非原始碼檔案只做格式檢查。

### 4.2 覆寫規則

每個標準項目都有一個**類型**，用來判斷覆寫是收緊還是放寬：

| 類型 | 更嚴格的方向 | 例子 |
|---|---|---|
| 上限 | 值越小越嚴格 | `complexity.cyclomatic` |
| 下限 | 值越大越嚴格 | `coverage.lines`、`*.minVersion` |
| 布林 | `true` 較嚴格 | `typecheck.strict`、`deps.lockfile`、`deps.vulnScan` |
| 嚴重度 | 等級越低越嚴格（low < moderate < high < critical） | `deps.vulnFailOn` |
| 禁用清單 / 規則集 | 移除項目算放寬，新增項目算收緊 | `deps.banned`、`lint.rules` |
| 工具選擇 | 改用允許清單內的工具算替代，不算偏離；改用清單外的工具算放寬 | `lint.tool` |
| 版本範圍 | 超出範圍算放寬 | 各工具的版本範圍 |
| **風格** | 沒有嚴格或寬鬆之分，可以直接覆寫，不算偏離 | `format.*`、`mirrors.auth` |
| **鏡像** | 改成預設鏡像同一台主機上的其他 repository 視同風格；改成其他主機算放寬 | `mirrors.pypi`、`mirrors.npm` 等網址 |

- **放寬**時必須寫成 `{value, reason, until?}`。
  - 沒有理由，或理由仍是 `TODO`：**錯誤**。
  - 有理由：標示為**偏離**，不擋人，但一直列在報告中。
  - 超過 `until`：再變回**錯誤**。
- 覆寫不存在的項目、值的型別錯誤、重複宣告同一個元件：**錯誤**。
- 鏡像網址改到內部主機以外屬於放寬，必須寫理由並一直列為偏離；這樣 §10.2「設定指向外部來源是錯誤」不會被宣告悄悄繞過。
- 同一個 repo 裡，同語言的元件風格不一致時：**提示**。
- `deps.ignoredVulns` 中的每一項都比照偏離處理，必須有 `reason` 與 `until`。

### 4.3 沒有宣告時

CLI 依偵測到的工具設定檔產生**草稿**：
- 與預設相同的項目省略。
- 比預設寬鬆的項目帶上 `TODO` 理由，要填寫之後才算通過。
- `draft --ignore <路徑或 glob>`（可重複）：符合的檔案不用來推斷元件，清單原樣寫進草稿的 `ignore`。

可直接移植的參考實作（`Std` 模組中的 `resolve`、`lookup`、`draftFromDetected`、`checkToolConfigs`）：[prototypes/07-project-declaration.prototype.html](.scratch/coding-standards-guard/prototypes/07-project-declaration.prototype.html)

來源：[專案宣告格式](.scratch/coding-standards-guard/issues/07-project-declaration-format.md)、[預設標準：Python](.scratch/coding-standards-guard/issues/08-default-standard-python.md)（新增風格類型）

---

## 5. 預設標準：共通部分

### 5.1 跨語言共通項目

| 項目 | 預設值 | 類型 |
|---|---|---|
| `complexity.cyclomatic` | 10 | 上限 |
| `complexity.cognitive` | 15（Python 不適用） | 上限 |
| `coverage.lines` | 80 | 下限 |
| `deps.lockfile` | `true`（各語言的落地方式不同） | 布林 |
| `deps.vulnScan` | **`false`**（進階項目，見 §5.3） | 布林 |
| `deps.ignoredVulns` | 空 | 新增項目算放寬 |
| `claude.minVersion` | `2.1.295`（`onFailure: block` 需要此版本） | 下限 |
| `mirrors.pypi` / `npm` / `go` / `maven` / `vscode` / `tools` 等 | 見 §10.1 | 鏡像（§4.2） |
| `mirrors.auth` | `none` | 風格 |
| 各工具的版本範圍 | 發佈 `team@1.0.0` 時訂定，例如 `ruff >=0.17,<0.18`、`golangci-lint >=2.12`（`gomodguard_v2` 從 v2.12.0 才有） | 版本範圍 |

**跨語言共用的修正項目**：`.gitattributes` 必須包含 `* text=auto eol=lf`（Prettier、Biome 預設使用 LF，Spotless 依 `.gitattributes` 決定換行）。

### 5.2 工具版本的權威

- 預設標準訂出每個工具**允許的版本範圍**。
- 專案用各語言自己的依賴管理鎖定**確切版本**：
  - Python：`pyproject.toml` 的 dev group 加上 `uv.lock`
  - TypeScript：`devDependencies` 加上 lockfile
  - Go：`go.mod` 的 `tool`
  - Java：`pom.xml` / `build.gradle` 中的 plugin 版本
- **golangci-lint 例外**：不放進 `go.mod` 的 `tool`。使用指定版本的 binary，由開發者放到 PATH，CLI 從 PATH 呼叫並核對版本。
- CLI 執行工具的方式：
  - Python：`uv run <tool>`；Poetry 專案（最近的 lockfile 是 `poetry.lock`）直接執行專案內 `.venv` 中的工具，所以 Poetry 必須設定 `virtualenvs.in-project true`
  - TypeScript：`node_modules/.bin/<tool>`
  - Go：`go tool <名稱>`
  - Java：`./mvnw` / `./gradlew`
- 工具尚未安裝時，CLI **不會自行下載**，而是報錯並附上一行安裝指令（例如 `uv sync`、`poetry config virtualenvs.in-project true && poetry install`、`npm ci`），透過內部鏡像安裝。

來源：[工具版本權威與一致性檢查](.scratch/coding-standards-guard/issues/14-tool-version-authority.md)

### 5.3 弱點掃描（進階項目）

公司環境不允許下載外部檔案，所以四種語言都**預設關閉**（`deps.vulnScan: false`）。
- 專案自行開啟算收緊，不需要寫理由。
- 開啟後才套用各語言的 `deps.vulnFailOn` 與 `deps.ignoredVulns`。
- 執行時機：只在 pre-push、`check --full` 與 CI。

各工具在內網的資料來源（已查證）：

| 工具 | 可行性 | 做法 |
|---|---|---|
| govulncheck | ✅ 可行 | `-db` 指向 `mirrors.govulndb`（Nexus raw proxy，指向 `https://vuln.go.dev`），或解壓 `vulndb.zip` 後使用 `file://` 路徑。Nexus 的 Go proxy 無法提供這份資料。 |
| OWASP Dependency-Check | ⚠ 有條件 | `nvdDatafeedUrl` 指向 Nexus raw hosted repo 中的 NVD 鏡像。IT 需要一台能連到 NVD API 的機器，每天執行 `vulnz cve --cache` 並上傳結果。KEV 與 RetireJS 要指向鏡像，或用 `--disableKnownExploited`、`--disableRetireJs` 關閉。OSS Index、Node Audit 與 Maven Central analyzer 一律關閉（`--disableOssIndex`、`--disableNodeAudit`、`-DcentralAnalyzerEnabled=false`）。plugin 一律以確切版本呼叫（pom 鎖定的版本，否則用標準指定的版本），不讓 Maven 自行挑選最新版。 |
| npm audit | ⚠ 有條件 | 需要 Sonatype Repository Firewall 授權、Nexus ≥3.82、npm ≥8（或 pnpm ≥11）。舊的 `/audits` 端點已於 2026-07-15 退役，只能使用 bulk 端點。doctor 會探測 bulk 端點，無法使用時給提示，不算錯誤。 |
| pip-audit | ❌ 無法透過 Nexus PyPI | pip-audit 的 pypi 來源寫死為 pypi.org；若回應中缺少 `vulnerabilities` 欄位，它會直接回報「沒有弱點」而不發出警告。可行的替代：`-s osv --osv-url <內部端點>`，或改用 osv-scanner 的離線模式（讀取 Nexus raw 上的 `all.zip`），見 §13。 |

來源：[預設標準：Java](.scratch/coding-standards-guard/issues/11-default-standard-java.md)、[內部鏡像設定檢查](.scratch/coding-standards-guard/issues/16-internal-mirror-config.md)

### 5.4 禁用清單

| 語言 | 套件（`deps.banned`） | API（`deps.bannedApis`） |
|---|---|---|
| Python | `pycrypto`、`nose` | 空（Ruff TID251） |
| Go | `github.com/pkg/errors`、`github.com/golang/protobuf`（gomodguard_v2） | `io/ioutil`（depguard） |
| TypeScript | `moment`、`request`、`node-fetch` | 空（ESLint `no-restricted-imports`） |
| Java | `log4j:log4j`、`junit:junit` | `sun.*`（Checkstyle `IllegalImport`） |

清單之後由團隊補充。

### 5.5 版本發佈與升級

- **發佈**：預設標準內建在 CLI 中。每個 CLI 版本都附帶目前 major 版本與前一個 major 版本的所有標準版本。標準的原始檔放在一個內部 repo。
- **版本號的意義**：
  - **major**：可能讓原本通過的專案失敗。例如收緊、新增規則、工具版本範圍改成不相容的範圍。
  - **minor**：不會讓任何專案失敗。例如新增選用項目、新增替代工具、放寬、擴大相容的工具版本範圍、更換鏡像網址。
  - **patch**：只修改說明。
- **專案宣告寫確切版本**。
  - 有 minor 或 patch 更新時，doctor 建議升級。
  - 宣告的版本比 CLI 內建的新：**錯誤**，提示從 GitHub Release 下載新版 devguard（§3.1）。
  - 宣告的版本已經不在 CLI 中：**錯誤**，提示升級標準。
- **`devguard standard upgrade`**：預設只預覽，內容包括：
  - 標準項目的差異
  - 對本專案的影響（哪些覆寫變得多餘、哪些會成為新的偏離或錯誤）
  - 需要調整的工具版本
  - 需要執行的套件管理指令

  加上 `--apply` 才實際修改宣告與設定檔，並透過內部鏡像執行套件管理指令。預覽不會詢問；有變更待套用時以 `1` 結束（§11）。
- **強制升級**：團隊可以把某個標準版本標為棄用並設定截止日。截止日之前只顯示提示，之後回報錯誤。

來源：[預設標準的版本發佈與專案升級方式](.scratch/coding-standards-guard/issues/12-standards-versioning.md)

---

## 6. 各語言的預設標準（`team@1.0.0` 草案）

### 6.1 Python

| 項目 | 預設值 | 落地方式 |
|---|---|---|
| `python.minVersion` | 3.11（專案的 `requires-python` 較高時以專案為準） | Ruff `target-version`、mypy `python_version` |
| `lint.tool` | `ruff`，lint 與 format 都用它 | `pyproject.toml [tool.ruff]` |
| `lint.rules` | `E, W, F, I, B, UP, C90, SIM, N, S, TID`；測試檔放寬 `S101` | 一律寫入 `lint.select`（會取代 Ruff 的預設規則集；Ruff 0.16 起預設規則大幅增加），不使用 `extend-select`；`per-file-ignores` |
| `format.lineLength` | 120（風格） | Ruff `line-length` |
| `complexity.cyclomatic` | 10 | Ruff C901 `max-complexity` |
| `typecheck.tool` | `mypy`；允許替代工具 `pyright` | `[tool.mypy]` / `[tool.pyright]` |
| `typecheck.strict` | `true` | mypy `strict` / pyright `strict` |
| `test.tool` | pytest + pytest-cov | — |
| `coverage.lines` | 行覆蓋率與分支覆蓋率**各自**都要達到 80%（`branch = true`），與 TS、Java 一致 | CLI 執行 `coverage json`，從 `totals` 分別計算行與分支的覆蓋率並自行判定。不使用 `fail_under`，因為它在 branch 模式下檢查的是行加分支的合併總數。 |
| `deps.manager` | `uv`；允許替代工具 `poetry` | — |
| `deps.lockfile` | `uv.lock`（或 `poetry.lock`）必須提交；只有不帶 hash 的 `requirements.txt` 不算 lockfile | CLI 檢查 |
| 進階：`deps.vulnFailOn` | 任何等級 | 先執行 `uv export --frozen --no-emit-project --format requirements.txt -o <tmp>`，再執行 `pip-audit -r <tmp> --disable-pip`（匯出結果預設帶 hash）；`ignoredVulns` 轉成 `--ignore-vuln`；資料來源見 §5.3 |

來源：[預設標準：Python](.scratch/coding-standards-guard/issues/08-default-standard-python.md)

### 6.2 Go

| 項目 | 預設值 | 落地方式 |
|---|---|---|
| `go.minVersion` | 1.26（`go.mod` 較高時以專案為準） | `go.mod` |
| `lint.tool` | golangci-lint v2，**≥2.12** | `.golangci.yml`（`version: "2"`） |
| `lint.rules` | v2 預設組加上 `gosec, revive, errorlint, bodyclose, misspell, cyclop, gocognit, gomodguard_v2, depguard` | `linters.enable`；depguard 一定要寫明確規則 |
| `format.tools` | gofumpt + goimports（風格） | golangci-lint formatters；gopls `formatting.gofumpt` |
| `complexity.cyclomatic` / `cognitive` | 10 / 15 | `cyclop.max-complexity`（預設 10）/ `gocognit.min-complexity`，**必須明確設為 15**（預設 30） |
| `coverage.lines` | 80，排除 `// Code generated … DO NOT EDIT.` 與 `mocks/` | CLI 解析 `go tool cover -func` 的 total |
| `test.race` | 本機不強制（Windows 需要 cgo / gcc），交給 CI | — |
| `deps.lockfile` | `go.mod` 與 `go.sum` 必須提交，且 `go mod tidy -diff` 必須乾淨 | CLI 檢查 |
| 進階：`deps.vulnFailOn` | 任何等級 | `govulncheck -json`（source 模式），由 CLI 判定結果並過濾 `ignoredVulns` |

來源：[預設標準：Go](.scratch/coding-standards-guard/issues/09-default-standard-go.md)

### 6.3 TypeScript

| 項目 | 預設值 | 落地方式 |
|---|---|---|
| `node.minVersion` | 22 | `engines.node: ">=22"` |
| `lint.tool` | `eslint+prettier`；允許替代工具 `biome` | flat config + `.prettierrc` / `biome.json` |
| `lint.rules` | typescript-eslint `strictTypeChecked` | flat config |
| `format.printWidth` / `endOfLine` | 120 / `lf`（風格） | Prettier |
| `typecheck.strict` | `strict`，加上 `noUncheckedIndexedAccess`、`noImplicitOverride`、`noFallthroughCasesInSwitch` | `tsconfig.json`，用 `tsc --noEmit` 檢查 |
| `complexity.cyclomatic` / `cognitive` | 10 / 15 | ESLint `complexity` / `eslint-plugin-sonarjs` 的 `cognitive-complexity`（**授權為 LGPL-3.0-only，需法務確認，見 §12**）；使用 Biome 時改開 `noExcessiveCognitiveComplexity` |
| `test.tool` | `vitest`；允許替代工具 `jest` | — |
| `coverage.lines` | lines、branches、functions、statements 都是 80；覆蓋率必須涵蓋元件所有的原始碼，不只被測試 import 的檔案 | `coverage.thresholds` / `coverageThreshold.global`；並且必須設定 `coverage.include` / `collectCoverageFrom`，否則為錯誤 |
| `deps.manager` | `npm`；允許替代工具 `pnpm`、`yarn` | — |
| `deps.lockfile` | lockfile 必須提交；CI 使用 `npm ci` | CLI 檢查 |
| 進階：`deps.vulnFailOn` | `high`（含 dev 依賴） | `npm audit --json`，由 CLI 依 GHSA 過濾 `ignoredVulns` |

來源：[預設標準：TypeScript](.scratch/coding-standards-guard/issues/10-default-standard-typescript.md)

### 6.4 Java

| 項目 | 預設值 | 落地方式 |
|---|---|---|
| `java.minVersion` | 17（新專案建議 21 以上） | `maven.compiler.release` / Gradle toolchain |
| `build.tool` | Maven 或 Gradle，必須提交 wrapper | CLI 一律透過 wrapper 呼叫 |
| `format.tool` | Spotless 搭配 palantir-java-format（4 空白、120 欄，風格） | `spotless:check` / `spotless:apply` |
| `lint.tool` / `lint.rules` | Checkstyle（以 `google_checks.xml` 為基礎，移除與 palantir 衝突的格式類規則）+ PMD quickstart | `checkstyle.xml`、PMD ruleset（由 CLI 產生）。內建設定**不含**複雜度與 import 規則，產生時必須自行加入：Checkstyle 的 `IllegalImport`、`CyclomaticComplexity`（max 10），以及 PMD 的 `CognitiveComplexity`（reportLevel 15）。PMD quickstart 中的複雜度規則預設是註解掉的。 |
| `complexity.cyclomatic` / `cognitive` | 10 / 15 | Checkstyle / PMD |
| `test.tool` | JUnit 5 | — |
| `coverage.lines` | JaCoCo BUNDLE 層級，LINE 與 BRANCH 都要 0.80；排除 Lombok 產生的程式碼 | `jacoco:check`；在 `lombok.config` 設定 `lombok.addLombokGeneratedAnnotation = true` |
| `deps.lockfile` | Maven：Enforcer 的 `banDynamicVersions`（一條規則同時禁止版本範圍、LATEST / RELEASE 與 SNAPSHOT）加上 `dependencyConvergence`；Gradle：dependency locking 加上 `gradle.lockfile` | — |
| 進階：`deps.vulnFailOn` | CVSS 7 | OWASP Dependency-Check；`ignoredVulns` 轉成 suppression 檔；NVD API key 不由 CLI 管理，doctor 只檢查有沒有設定 |

來源：[預設標準：Java](.scratch/coding-standards-guard/issues/11-default-standard-java.md)

---

## 7. 三道防線

### 7.1 各防線執行的檢查

| 檢查 | VS Code | Claude PostToolUse | Claude Stop | git pre-commit | git pre-push |
|---|---|---|---|---|---|
| lint、格式 | 擴充套件即時顯示 | 被編輯的檔案 | 這一輪改過的檔案 | staged 檔案 | — |
| 型別檢查 | 擴充套件即時顯示 | — | 這一輪改過的檔案 | staged 檔案所屬的元件 | — |
| 依賴規則（lockfile、禁用清單） | — | — | — | 只在依賴相關檔案被 staged 時 | — |
| 測試與覆蓋率 | 可手動執行的 task | — | — | — | 完整執行 |
| 進階：弱點掃描 | — | — | — | — | 開啟時執行 |

`devguard check --full` 與 CI 執行全部檢查。

指定檔案時（檔案參數、`--staged`、pre-commit、Claude 的兩個 hook），formatter 會處理的非原始碼檔案（Prettier 的 `.json`、`.md`、`.yaml`、`.css`…，Biome 的 `.json`、`.css`…）也交給所屬的 TypeScript 元件做格式檢查，範圍與整個元件的檢查一致；只有這類檔案時不跑 lint 與型別檢查。

### 7.2 第一道：VS Code

CLI 只為專案用到的語言產生設定。monorepo 只在 repo 根目錄放一份 `.vscode/`。

**`extensions.json`**

| 語言 | 推薦 | 不推薦 |
|---|---|---|
| Python | `ms-python.python`、`charliermarsh.ruff`、`ms-python.mypy-type-checker` | black-formatter、isort、flake8、pylint |
| Go | `golang.go` | — |
| TypeScript | `dbaeumer.vscode-eslint`、`esbenp.prettier-vscode`（使用 Biome 時改為 `biomejs.biome`）、`vitest.explorer` | 未選用的那一套 |
| Java | `vscjava.vscode-java-pack`、`shengchen.vscode-checkstyle` | — |

**`settings.json`**（只修改 CLI 管理的 key）
- **Python**
  - 存檔時用 Ruff 格式化，並執行 fixAll 與 organizeImports。
  - Ruff 與 mypy 擴充套件設為 `importStrategy: fromEnvironment`。
  - `python.defaultInterpreterPath` 指向 `.venv`。
  - mypy 的 `cwd` 設為 `${nearestConfig}`。
- **Go**
  - `go.lintTool: golangci-lint-v2`，`go.lintOnSave: package`。
  - gopls 設定 `formatting.gofumpt: true`。
- **TypeScript**
  - 存檔時用 Prettier 或 Biome 格式化，並執行 `source.fixAll.eslint`。
  - `js/ts.tsdk.path` 指向 `node_modules/typescript/lib`，並設定 `js/ts.tsdk.promptToUseWorkspaceVersion`（舊的 `typescript.tsdk` 已於 2026-05 棄用）。
  - `eslint.workingDirectories` 列出各 TS 元件。
- **Java**
  - `java.checkstyle.configuration` 與 `java.checkstyle.version` 與建置設定相同。
  - Java 檔案**關閉 `formatOnSave`**，因為 IDE 的格式化結果和 palantir 不一致。
- **共通**：`files.eol: "\n"`。

**`tasks.json`**（一律使用 `"type": "process"`）
- `standards: doctor`：`runOn: folderOpen`
- `standards: check`：`--format vscode`，搭配 problem matcher
- `standards: fix`
- `standards: test & coverage`
- `standards: format (Spotless)`：只在有 Java 元件時產生

**環境檢查**
- 用 `code --list-extensions --show-versions` 偵測擴充套件（透過 `cmd.exe` 執行）。這個指令只能判斷「是否已安裝」：被停用的擴充套件也會列出，而且只涵蓋預設 profile。CLI 沒有可靠的方式判斷是否已啟用（狀態存在 VS Code 內部的 `state.vscdb`，不是公開 API）。
- 缺少推薦的擴充套件時回報**錯誤**，提示「請從公司內部 marketplace 安裝 `<id>`」並附上連結；訊息另外註明「若已安裝但被停用，請在 VS Code 中啟用」。
- 裝了不推薦的擴充套件時給**提示**。

**提交規則**：`settings.json`、`extensions.json`、`tasks.json` 必須提交。如果 `.gitignore` 忽略了 `.vscode/`，CLI 提示改成 `.vscode/*` 並加上例外規則。

來源：[VS Code workspace 設定設計](.scratch/coding-standards-guard/issues/15-vscode-workspace-config.md)

### 7.3 第二道：Claude Code

由 `devguard install` 產生並提交以下檔案。開發者信任資料夾後才會生效。

- **`.claude/settings.json` 的 hooks**：全部以 exec form 呼叫 `devguard`。`SessionStart` 與 `PostToolUse` 設定 `onFailure: "block"`；`Stop` 不設定，因為 `onFailure` 對 `Stop` 無效。
  - `SessionStart`：`devguard hook claude-session-start`。執行 `doctor --quiet`（結果進入 Claude 的 context），並寫入 `.git/devguard/claude-last-seen`（舊版寫入的 `.git/standards-guard/claude-last-seen` 仍然承認）。
  - `PostToolUse`（matcher `Edit|Write`）：`devguard hook claude-post-edit`。只對被編輯的那個檔案做 lint 與格式檢查。
  - `Stop`：`devguard hook claude-stop`。用 `git status` 找出工作目錄中所有尚未 commit 的修改與新檔案（包含透過 Bash 改的），做 lint、格式與型別檢查。
- 專案的工具尚未安裝時，各 hook 把它當成一項錯誤回報（附安裝指令），不會讓 hook 本身失敗，其餘檢查照常執行。
- **回饋給 Claude 的方式**
  - exit 0 加上 JSON：`decision: "block"` 與 `reason`。
  - `reason` 最多列 20 項，其餘寫「還有 N 項」，總長度少於 4,000 字元。
  - 當 `stop_hook_active` 為 true 且檢查仍失敗時，放行，並用 `systemMessage` 告知開發者，避免 Claude 陷入修正迴圈。
- **`.claude/rules/standards-<元件>.md`**
  - frontmatter 的 `paths` 對應元件的目錄與副檔名，只在 Claude 讀寫相關檔案時載入。
  - 內容是精簡的工具、門檻、禁用清單、目前的偏離與理由，每份少於 200 行。
  - 開頭標註「由 CLI 產生」。
- 產生的 `.claude/` 檔案（rules、skill、`settings.json`）本身就符合 Prettier 的格式；`settings.json` 依宣告的 `format.printWidth` 決定陣列是否排成一行。專案用 Prettier 格式化它們不會改變內容，也不會被回報為與標準不一致。
- **`.claude/skills/standards-doctor/SKILL.md`**
  - 設定 `disable-model-invocation: true`，只有開發者能呼叫。
  - 以 `` !`devguard doctor --format claude --exit-zero` `` 嵌入檢查結果（`!` 指令以非 0 結束時整個 skill 會中止，所以必須加 `--exit-zero`）；經開發者同意後，Claude 再執行 `fix --yes`。
  - `allowed-tools` 同時允許 `Bash(devguard *)` 與 `PowerShell(devguard *)`。沒有安裝 Git Bash 的機器會改用 PowerShell 執行；若指令不被允許，整個 skill 呼叫都會中止。
- **環境檢查**
  - Claude Code 版本必須達到 `claude.minVersion`。
  - 專案有 `.claude/` 設定、但沒有 `claude-last-seen` 檔案時提示：「Claude Code 的 hook 可能從未執行過，或尚未信任此資料夾」。

來源：[Claude Code 擴充機制研究](.scratch/coding-standards-guard/research/04-claude-code-mechanisms.md)、[Claude Code 防線整合設計](.scratch/coding-standards-guard/issues/13-claude-code-integration.md)

### 7.4 第三道：git hook

- **安裝方式**
  - `devguard install` 安裝 `pre-commit` 與 `pre-push` 兩個 hook，內容都是一行 POSIX sh，例如 `exec devguard hook git-pre-commit`，由 Git for Windows 附帶的 sh 執行。
  - 檔案內含 CLI 標記與 checksum。
  - 不使用 pre-commit、lefthook 或 husky 等框架。
- **既有 hook 框架**：專案已經在用這類框架時，CLI 不覆寫它的 hook，而是在它的設定中注入一條呼叫 `devguard` 的項目：
  - pre-commit：一條 `language: unsupported` 的 local hook
  - husky：`.husky/pre-commit` 中加一行
  - lefthook：加一個 job（YAML、TOML、JSON / JSONC 設定檔都支援）
- **找不到 CLI**：擋下 commit。錯誤訊息附上安裝指令，並提示可用 `--no-verify` 暫時略過。
- **部分 staged 的檔案**：不做 stash，也不還原任何檔案。
  - formatter 與單檔 linter 改用 `git show :<path>` 取出 **staged 版本**，再以 stdin 交給工具檢查，例如 `ruff check|format --stdin-filename`、`eslint --stdin --stdin-filename`、`prettier --stdin-filepath`、`biome lint|format --stdin-file-path`，以及 Go 的格式檢查 `golangci-lint fmt --stdin`（套用設定中的 gofumpt、goimports）。這可以避免最常見的誤判：工作目錄已經格式化，但 commit 進去的版本沒有。
  - 型別檢查（mypy、pyright、tsc）、golangci-lint 與 Java 工具（Spotless、Checkstyle、PMD）沒有 stdin 模式，而且本來就會讀磁碟上的其他檔案，所以仍然檢查工作目錄的版本。
  - 印出的警告要說明哪些檢查用的是工作目錄版本。
- **hook 只做檢查、不做修正**：失敗時印出 `devguard fix --code <files>`。
- **「已安裝」的環境檢查**
  1. 讀取 `core.hooksPath` 及其設定來源。
  2. 若使用既有框架，確認其設定中有呼叫 CLI 的項目；使用 pre-commit 框架時，另外確認 `pre-commit install --hook-type pre-commit --hook-type pre-push` 已執行（hooks 目錄中有 pre-commit 產生的 hook）。沒有使用框架時，確認 hook 檔存在、有 CLI 標記，且 checksum 正確。
  3. `core.hooksPath` 指向 `/dev/null` 或不存在的目錄時，回報錯誤。
- **促使開發者安裝**：VS Code 的 folderOpen task 與 Claude Code 的 SessionStart 都會執行 doctor。doctor 只回報問題並附上 `devguard install` 指令，不會自動安裝。

來源：[pre-commit 框架比較研究](.scratch/coding-standards-guard/research/02-precommit-framework-options.md)、[CLI 實作語言與分發方式決策](.scratch/coding-standards-guard/issues/05-cli-runtime-decision.md)

---

## 8. 一致性檢查

| 比對項目 | 不一致時 |
|---|---|
| 專案鎖定的工具版本是否落在預設標準的範圍內 | 錯誤 |
| VS Code 是否使用專案的工具（Ruff 與 mypy 的 `fromEnvironment`、直譯器、`js/ts.tsdk.path`；舊的 `typescript.tsdk` 也接受） | 錯誤，可用 `fix` 修正 |
| Checkstyle 擴充套件的版本與設定檔路徑，是否和建置設定相同 | 錯誤，可用 `fix` 修正 |
| `.claude/` 與 `.vscode/` 中由 CLI 產生或管理的內容，是否和目前的標準相符 | 錯誤，可用 `fix` 修正 |
| 工具設定檔的值與宣告不一致：設定檔較寬鬆 | 錯誤，`fix` 改回宣告的值 |
| 工具設定檔的值與宣告不一致：設定檔較嚴格 | 提示，建議把宣告同步成設定檔的值 |
| 既有 pre-commit 框架中其他工具 hook 的 `rev` 與專案鎖定的版本不同 | 提示 |
| Pylance 內建的 pyright 版本 | 已知差異，接受 |

來源：[工具版本權威與一致性檢查](.scratch/coding-standards-guard/issues/14-tool-version-authority.md)

---

## 9. 修正（`fix`）

### 9.1 範圍

- `devguard fix`：修正**設定**，包括工具設定檔、`.claude/`、`.vscode/`、git hook（重新產生被修改過的 devguard hook；尚未安裝的 hook 由 `install` 安裝），以及 `.gitattributes`、`.gitignore`、`lombok.config` 中屬於標準的規則。
- `devguard fix --code [files]`：修正**程式碼**，包括 `ruff format`、`gofumpt`、`prettier --write`、`spotless:apply`，以及 `ruff check --fix`、`eslint --fix`、`golangci-lint run --fix`。
- **使用者層級的設定一律不修改**，只印出修改說明，例如 `~/.m2/settings.xml`、使用者的 `.npmrc`、`go env`、環境變數。

### 9.2 依檔案類別決定修改方式

| 類別 | 範例 | 做法 |
|---|---|---|
| CLI 全權產生 | `checkstyle.xml`、PMD ruleset、`.claude/rules/*`、`/standards-doctor` skill、git hook、Dependency-Check suppression 檔、`.mvn/settings.xml`、`.mvn/maven.config` | 整份重新產生，檔頭標示「由 CLI 產生」 |
| 結構化的共用檔 | `pyproject.toml` 的 `[tool.*]`、`.golangci.yml`、`tsconfig.json`、`.prettierrc`、`.npmrc`、`.vscode/*`、`.claude/settings.json` | 只修改 CLI 管理的 key，並保留註解與順序（YAML 用 `yaml`，JSONC 用 `jsonc-parser`，TOML 用 `@decimalturn/toml-patch`；`@shopify/toml-patch` 需要在執行時載入 wasm，可能無法打包進 Bun exe） |
| 建置檔與程式碼形式的設定檔 | `pom.xml`、`build.gradle`、`settings.gradle`、`vitest.config.ts`、`eslint.config.js` | 不自動修改，只印出要套用的片段或 diff |

### 9.3 互動方式

- 互動式終端機：先預覽，確認後才套用。
- 加上 `--yes`：直接套用。
- 非互動環境且沒有加 `--yes`：只預覽，並以非 0 結束。
- 由 Claude 代為修正：經開發者同意後，執行 `fix --yes`。

來源：[fix 行為與檢查報告格式](.scratch/coding-standards-guard/issues/17-fix-and-report-format.md)

---

## 10. 內部環境

### 10.1 鏡像網址（dummy，正式導入前替換）

| 項目 | 預設值 |
|---|---|
| `mirrors.pypi` | `https://nexus.example.internal/repository/pypi-proxy/simple` |
| `mirrors.npm` | `https://nexus.example.internal/repository/npm-proxy/` |
| `mirrors.go` | `https://nexus.example.internal/repository/go-proxy/` |
| `mirrors.gosumdb` | `https://nexus.example.internal/repository/go-sumdb-proxy/`（raw proxy，指向 `https://sum.golang.org`，需關閉 Strict Content Type Validation） |
| `mirrors.govulndb` | `https://nexus.example.internal/repository/go-vulndb-proxy/`（raw proxy，指向 `https://vuln.go.dev`；只在開啟弱點掃描時使用） |
| `mirrors.osv` | `https://osv.example.internal/v1/query`（OSV 相容的查詢端點，給 `pip-audit -s osv --osv-url` 使用；Nexus raw proxy 無法代理 POST，需自架或由轉送代理放行；只在開啟弱點掃描時使用） |
| `mirrors.nvd` | `https://nexus.example.internal/repository/nvd-mirror/`（raw hosted，放 vulnz 產生的 `nvdcve-*.json.gz`；Dependency-Check 的 `nvdDatafeedUrl` 為 `<mirrors.nvd>nvdcve-{0}.json.gz`；只在開啟弱點掃描時使用） |
| `mirrors.maven` | `https://nexus.example.internal/repository/maven-public/` |
| `mirrors.tools` | `https://nexus.example.internal/repository/raw-tools/` |
| `mirrors.vscode` | `https://vsmarketplace.example.internal`（公司內部 marketplace） |

### 10.2 設定的落地位置

| 工具 | 位置 | 層級 |
|---|---|---|
| uv | `pyproject.toml` 的 `[[tool.uv.index]]`（`name = "nexus"`、`default = true`；需要登入時再加 `authenticate = "always"`） | 專案，提交 |
| npm / pnpm / yarn | 專案的 `.npmrc`（`registry=`） | 專案，提交 |
| Maven | `.mvn/maven.config`（`--settings .mvn/settings.xml`）+ `.mvn/settings.xml`（mirror） | 專案，提交 |
| Gradle | `settings.gradle` 的 `dependencyResolutionManagement.repositories` | 專案；CLI 只印出片段 |
| Go | `go env -w GOPROXY=…`、`GOSUMDB` | 使用者；doctor 印出指令；CLI 自己執行 Go 工具時直接帶入 |

- 設定指向外部來源時：**錯誤**。
- **Go 的 checksum 資料庫**：Nexus 的 Go proxy 無法代理 sumdb（`/sumdb/sum.golang.org/supported` 會回 404，go 隨即改為直連，在內網會失敗）。
  - 設定 `GOSUMDB="sum.golang.org <mirrors.gosumdb>"`，沿用官方公鑰。
  - 內部模組用 `GOPRIVATE` / `GONOSUMDB` 排除。
  - `GOSUMDB=off` 算**錯誤**：關閉後，凡是 `go.sum` 中還沒有的模組，都會在未經驗證的情況下被接受。

### 10.3 帳密

有些 Nexus 需要登入，有些不需要，**依專案而定**。

- `mirrors.auth: env` 時，統一使用環境變數 `NEXUS_USERNAME`、`NEXUS_PASSWORD`。專案層級的設定檔只引用變數：

  | 工具 | 引用方式 |
  |---|---|
  | npm（**例外**） | `.npmrc` 寫 `//nexus.example.internal/repository/npm-proxy/:_auth=${NEXUS_NPM_AUTH}`，值是 `username:password` 的 base64；或改用 `:_authToken=${NEXUS_NPM_TOKEN}`。帳密相關的 key 必須帶 registry 前綴；npm 不接受明文的 `_password`，所以無法直接使用 `NEXUS_USERNAME` / `NEXUS_PASSWORD`。 |
  | uv | `UV_INDEX_NEXUS_USERNAME` / `UV_INDEX_NEXUS_PASSWORD`（名稱取自 index 的 `name`，轉成大寫，非英數字元換成 `_`） |
  | Maven | `.mvn/settings.xml` 的 `<server>` 寫 `${env.NEXUS_USERNAME}`；`<server>` 的 id 必須和 mirror 的 id 相同 |
  | Gradle | repository 的 `name` 設為 `nexus`，並加上 `credentials(PasswordCredentials)`，即可讀取 `ORG_GRADLE_PROJECT_nexusUsername` / `ORG_GRADLE_PROJECT_nexusPassword`（或 `~/.gradle/gradle.properties`） |
  | Go | `NETRC` 環境變數所指的檔案；沒有設定時用 `%USERPROFILE%\_netrc`。只寫主機名稱，僅適用 HTTPS |

- 帳密**絕不進 repo**，CLI 也不保存。`fix`、`install` 與 `standard upgrade` 的預覽、印出的片段與報告中，一律遮蔽帳密的值（`.npmrc` 的 `_auth` / `_authToken` / `_password`、Maven 的 `<username>` / `<password>`、網址中的 `user:password@`）；只引用環境變數（`${…}`）的值照常顯示。
- doctor 只檢查這些變數或 netrc 檔是否存在（Go 先看 `NETRC`，再看 `_netrc`），**不讀取也不印出它們的值**。這一點對 npm 特別重要：`.npmrc` 引用的變數不存在時，npm 不會報錯，而是把 `${VAR}` 原樣送出，最後得到 401。

來源：[內部鏡像設定檢查](.scratch/coding-standards-guard/issues/16-internal-mirror-config.md)

---

## 11. 檢查報告與 exit code

**`check` 與 `doctor` 的差別**
- `check`：設定、一致性與程式碼檢查。
- `doctor`：`check` 再加上環境檢查。

**輸出格式**

| 格式 | 用途 | 內容 |
|---|---|---|
| `text`（預設） | 給人看 | 依元件分組，再依等級排序（錯誤、偏離、提示）；每一項附上修正方式，並標明能否用 `fix` 處理；最後一行總結各等級的數量；提示預設只顯示數量，`--verbose` 才展開 |
| `json` | CI、工具 | `{ standard, components[], findings[] }`；每個 finding 包含 `level`、`component`、`layer`（設定、環境、一致性、程式碼）、`rule`、`file`、`line`、`message`、`fix` |
| `sarif` | 程式碼審查平台 | 只包含程式碼類問題 |
| `vscode` | problem matcher | 每個問題一行：`檔案:行:欄: 等級: 訊息 [規則]` |
| `claude` | Claude Code | 最多 20 項，少於 4,000 字元 |

**exit code**
- `0`：通過（只有偏離或提示時也算通過）。
- `1`：有錯誤。
- `2`：CLI 本身出錯，例如參數錯誤、找不到工具、內部例外。
  - 找不到工具：`check` 以 `2` 結束並印出安裝指令。`doctor` 與各 hook 則把它回報成一項**錯誤**（環境層，附安裝指令），其餘檢查照常執行，所以剛 clone 的專案也能看到缺少的 hook 與 `devguard install` 提示（§7.3、§7.4）。
- 加上 `--strict` 時，偏離也算失敗，回傳 `1`。
- 會修改檔案的指令沒有套用待寫入的變更時也回傳 `1`：`fix`、`fix --code`、`install` 被拒絕或在非互動環境沒有 `--yes`；`standard upgrade` 沒有 `--apply` 而有變更待套用（只預覽、不詢問，讓 CI 能偵測「需要升級」）。

來源：[fix 行為與檢查報告格式](.scratch/coding-standards-guard/issues/17-fix-and-report-format.md)

---

## 12. 導入前提（由團隊或 IT 確認）

1. 以真實的 Nexus 網址取代 §10.1 的 dummy 網址。
2. §7.2 推薦的 VS Code 擴充套件，都能在公司內部 marketplace 取得。
3. 開發者能從 GitHub Release 下載 devguard 的 exe（§3.1），並取得預設標準指定版本的 golangci-lint binary。
4. 在 Nexus 上建立 `mirrors.gosumdb` raw proxy（指向 `https://sum.golang.org`，關閉 Strict Content Type Validation）。
5. 訂出 `team@1.0.0` 中各工具的確切版本範圍，以及 golangci-lint 的指定版本。
6. 開發者的機器上有 Git for Windows（git hook 的 sh 依賴它）。
7. 確認公司內部 marketplace 的類型。Microsoft 的私有 marketplace 需要 GitHub Enterprise，透過 `ExtensionGalleryServiceUrl` policy 設定；依原始碼推斷，`code --install-extension` 不會讀這個 policy（尚未實機確認）。
8. **法務確認**：`eslint-plugin-sonarjs` 的授權是 LGPL-3.0-only。如果不允許使用，TypeScript 的認知複雜度要改用其他方式檢查。確認之前，devguard 自己的原始碼也沒有加入這個 plugin，認知複雜度暫不檢查（`devguard check` 對自己會一直顯示這一項提示）。
9. 只在打算開啟進階弱點掃描時才需要：
   - 一台能連到 NVD API 的機器，每天更新 Nexus raw hosted repo 中的 NVD 鏡像（給 Dependency-Check 使用）
   - `mirrors.govulndb` raw proxy
   - 確認是否有 Sonatype Repository Firewall 授權（npm audit 需要）

## 13. 待實機測試或待決定的事項

原列的 9 個查證項目已完成（2026-10-22），修正已併入本文。查證紀錄：
- [verify-a-toml-and-auth.md](.scratch/coding-standards-guard/research/verify-a-toml-and-auth.md)
- [verify-b-nexus-and-vuln.md](.scratch/coding-standards-guard/research/verify-b-nexus-and-vuln.md)
- [verify-c-toolchain-facts.md](.scratch/coding-standards-guard/research/verify-c-toolchain-facts.md)
- [verify-d-vscode-bun-claude.md](.scratch/coding-standards-guard/research/verify-d-vscode-bun-claude.md)

**已決定**：Python 的覆蓋率改由 CLI 解析 `coverage json`，行與分支各自檢查是否達到 80%，與其他語言一致（§6.1）。

**已完成的實機測試（2026-10-24）**

| # | 項目 | 結果 |
|---|---|---|
| T1 | `@decimalturn/toml-patch` 在 Bun 編譯後的 exe 中的 round-trip 測試：註解、空行、`[[tool.uv.index]]` | ✅ Bun 1.4.4 exe 中通過：註解、行尾註解、空行與 `[[tool.uv.index]]` 都保留（#17） |
| T2 | Bun 在 Windows 上尚未修正的子程序 bug（#32011、#40846、#43660），對執行 `.cmd`、stdin 管線、hook 的影響 | ✅ Bun 1.4.4 exe 中 7 項 probe 全部通過，與 Node 相同（#27） |
| T3 | 在團隊實際使用的 Claude Code 版本上，驗證 `onFailure`、exec form、`stop_hook_active` 的行為 | ✅ Claude Code 2.1.309 與規格一致；另加入 `doctor --exit-zero` 給 skill 使用（#23） |

**待實機測試**

| # | 項目 | 失敗時的退路 |
|---|---|---|
| T4 | `code --install-extension` 在公司內部 marketplace 下的行為 | doctor 的提示改為只附上 marketplace 連結 |
| T5 | 沒有 Firewall 授權時，Nexus 對 npm audit bulk 端點的回應 | 維持「無法使用時給提示」 |
| T6 | 評估 osv-scanner 離線模式（讀取 Nexus raw 上的 `all.zip`），是否能用一個工具取代 npm audit 與 pip-audit | 維持 §5.3 現有的做法 |

---

## 附錄 A：來源索引

| 票 | 類型 |
|---|---|
| [CLI 實作語言與 Windows 分發選項研究](.scratch/coding-standards-guard/issues/01-cli-runtime-options.md) | research |
| [pre-commit 框架比較研究（多語言 + Windows）](.scratch/coding-standards-guard/issues/02-precommit-framework-options.md) | research |
| [四種語言的檢查工具鏈現況研究](.scratch/coding-standards-guard/issues/03-language-toolchains.md) | research |
| [Claude Code 擴充機制研究](.scratch/coding-standards-guard/issues/04-claude-code-mechanisms.md) | research |
| [CLI 實作語言與分發方式決策](.scratch/coding-standards-guard/issues/05-cli-runtime-decision.md) | grilling |
| [pre-commit 框架決策](.scratch/coding-standards-guard/issues/06-precommit-framework-decision.md) | grilling（已併入 05） |
| [專案宣告格式](.scratch/coding-standards-guard/issues/07-project-declaration-format.md) | prototype |
| [預設標準：Python](.scratch/coding-standards-guard/issues/08-default-standard-python.md) | grilling |
| [預設標準：Go](.scratch/coding-standards-guard/issues/09-default-standard-go.md) | grilling |
| [預設標準：TypeScript](.scratch/coding-standards-guard/issues/10-default-standard-typescript.md) | grilling |
| [預設標準：Java](.scratch/coding-standards-guard/issues/11-default-standard-java.md) | grilling |
| [預設標準的版本發佈與專案升級方式](.scratch/coding-standards-guard/issues/12-standards-versioning.md) | grilling |
| [Claude Code 防線整合設計](.scratch/coding-standards-guard/issues/13-claude-code-integration.md) | grilling |
| [工具版本權威與一致性檢查](.scratch/coding-standards-guard/issues/14-tool-version-authority.md) | grilling |
| [VS Code workspace 設定設計](.scratch/coding-standards-guard/issues/15-vscode-workspace-config.md) | grilling |
| [內部鏡像設定檢查](.scratch/coding-standards-guard/issues/16-internal-mirror-config.md) | grilling |
| [fix 行為與檢查報告格式](.scratch/coding-standards-guard/issues/17-fix-and-report-format.md) | grilling |
