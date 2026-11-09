# 規格書：多語言開發規範三道防線工具

> 狀態：規格定案，可交付實作（2026-10-22）
> 來源：wayfinder 地圖 [map.md](.scratch/coding-standards-guard/map.md) 的 17 張決策票。每一節都附上來源票的連結；本文件與票的內容不一致時，以**本文件**為準（本文件已納入所有修訂）。
> 用語定義見 [GLOSSARY.md](GLOSSARY.md)。
> 名稱：CLI 名為 `devguard`，宣告檔為 `.devguard.yaml`。
> 變更：內部鏡像設定與弱點掃描已於 #64 移除（`team@1.3.0`），見 §5.3、§10。
> 查證：§13 原列的 9 個項目已於 2026-10-22 查證，結果見 `.scratch/coding-standards-guard/research/verify-*.md`，修正已併入本文；剩下必須實機測試或由他人決定的項目，列在 §12 與 §13。

---

## 1. 目標與範圍

團隊以 Java、Python、Go、TypeScript 開發，每種語言都有規範（coding standard、complexity、test coverage、dependency），但不一定每個人都會遵守。本工具讓每個專案用**一份單一事實來源**（預設標準 + 專案宣告），驅動並**檢查、修正**三道防線：

| 防線 | 時機 | 作用 |
|---|---|---|
| 第一道：VS Code | 撰寫時 | 擴充套件即時顯示問題 |
| 第二道：Claude Code | Claude 編輯檔案時 | 事前告知標準、事中檢查並回饋、提供診斷指令 |
| 第三道：git hook | commit 與 push 時 | pre-commit 擋下不合格的變更；pre-push 只在開發者以 `DEVGUARD_PRE_PUSH=full` 開啟時跑完整測試 |

**核心原則**
- 先檢查，再修正。修正一定先預覽，或由開發者明確下指令才執行。
- 三道防線共用同一套底層工具與設定檔，差別只在觸發時機。
- 檢查分三層：**設定檢查**（設定檔是否符合標準）、**環境檢查**（本機是否真的生效）、**一致性檢查**（三道防線用的工具與版本是否相同）。
- 開發者主要使用 **Windows**，但 devguard 也支援 Linux 與 macOS（§3.1）。
- **套件來源交給使用者**：企業環境常限制下載外部檔案，但各企業的限制不同，使用者最清楚。devguard 不檢查也不寫入套件、工具與 VS Code 擴充套件從哪裡下載（內部鏡像、registry、index），這些設定在開發者使用者層級的設定中（§10）。CLI 本身不連外網。

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
- **打包**：用 Bun `--compile` 打包成單一執行檔，這是唯一的發佈形式。發佈 Windows、Linux、macOS 各自的 x64 與 arm64，共六個（[ADR 0001](docs/adr/0001-release-for-linux-and-macos.md)、#80），名稱是 `devguard-<windows|linux|macos>-<x64|arm64>`，Windows 加上 `.exe`。Linux 只發佈 glibc 版本。
  - Bun 必須 **≥1.2.23**（已在 1.4.4 驗證，見 §13 T1、T2）。
  - 每個作業系統在自己的 runner 上建置。Windows 必須如此，因為交叉編譯時無法設定 `--windows-icon` 與版本資訊。交叉編譯時 Bun 會從外網下載目標平台的 runtime，所以在無法連外的環境必須在目標平台上建置。
  - 建置後對 runner 架構的執行檔跑 smoke test：在 PATH 中沒有 Node 的情況下跑 `devguard --version` 與 `devguard check`。另一個架構交叉編譯，不跑 smoke test。
  - 執行檔**不簽章**（原本規劃的 signtool 簽章已取消，見 #28），macOS 執行檔也不公證（notarization）。
- **分發**：以 **GitHub Release** 發佈建置好的執行檔。推送 `v<版本>` tag 時，`.github/workflows/release.yml` 在 Windows、Linux（x64 與 arm64）、macOS runner 上執行測試、建置執行檔、跑 smoke test，再把六個執行檔與 `SHA256SUMS.txt` 附加到 release。tag 必須和 `package.json` 的版本相同。
  - 開發者下載對應平台的執行檔，改名為 `devguard`（Windows 為 `devguard.exe`；Linux 與 macOS 要 `chmod +x`）並放進 PATH；更新時用新版取代。macOS 從瀏覽器下載的檔案要先移除 quarantine 屬性（`xattr -d com.apple.quarantine devguard`），否則 Gatekeeper 會擋下。CLI 找不到或版本過舊時，訊息會指向 release 頁面與這台機器對應的執行檔；寫進 git hook 的提示則不分平台，因為注入 husky、lefthook 的那一行由所有開發者共用。
  - 放在 PATH 上的是真正的執行檔，Claude Code 的 exec form hook 可以直接呼叫。
  - 原本規劃的內部 Scoop bucket 與 Nexus raw repository 已取消（#28）。
- **golangci-lint** 仍是 §5.2 的例外：使用預設標準指定版本的 binary，由開發者放到 PATH，CLI 從 PATH 呼叫並核對版本。找不到時（`check` exit 2、`doctor` 的 `environment/tool-missing`、hook），提示寫出元件生效的 `tools.golangci-lint` 範圍（含 override）與下載位置（https://github.com/golangci/golangci-lint/releases）。
- **預設標準內建在 CLI 中**（見 §5.5），所以 CLI 不需要連網就能解析專案宣告。

來源：[CLI 實作語言與 Windows 分發選項研究](.scratch/coding-standards-guard/research/01-cli-runtime-options.md)、[CLI 實作語言與分發方式決策](.scratch/coding-standards-guard/issues/05-cli-runtime-decision.md)、[內部鏡像設定檢查](.scratch/coding-standards-guard/issues/16-internal-mirror-config.md)

### 3.2 指令一覽

| 指令 | 用途 |
|---|---|
| `devguard install` | 在專案中產生各防線的設定（`.vscode/`、`.claude/`、git hook、工具設定檔），並安裝 pre-commit 與 pre-push hook |
| `devguard check [檔案…] [--staged] [--full] [--only <類別>] [--format text\|json\|sarif\|vscode\|claude] [--strict] [--verbose]` | 執行設定、一致性與程式碼檢查，不含環境檢查。指定檔案時只對這些檔案跑程式碼檢查。供 CI 與 git hook 使用。`--staged` 只檢查 staged 的檔案，內容與 pre-commit hook 相同 |
| `devguard doctor [--quiet] [--exit-zero] [--format …]` | `check` 加上環境檢查（擴充套件、hook 是否安裝、Claude Code、執行 Java 工具的 JDK、標準是否有更新）。`--exit-zero`：有問題時也以 0 結束，給 `/standards-doctor` skill 嵌入結果用（§7.3） |
| `devguard draft` | 專案尚無 `.devguard.yaml` 時，依偵測到的元件與既有工具設定產生宣告草稿（§4.3），不覆寫既有檔案 |
| `devguard fix [--yes]` | 修正**設定**（§9） |
| `devguard fix --code [files] [--yes]` | 修正**程式碼**：格式化與可自動修正的 lint |
| `devguard standard upgrade [目標版本] [--apply]` | 預覽或套用標準升級（§5.5） |
| `devguard hook git-pre-commit` / `git-pre-push` | 給 git hook 呼叫 |
| `devguard hook claude-post-edit` / `claude-stop` / `claude-session-start` | 給 Claude Code hook 呼叫，從 stdin 讀取 hook 的 JSON 輸入 |

- 每個指令都接受 `--cwd <dir>`，指定專案根目錄（預設為目前目錄）。
- 各 `hook` 子指令自行處理該防線的輸入格式與 exit code 語意。
- CLI 執行 Go 工具時，一律帶入 `GOTOOLCHAIN=local`。`go tool <名稱>` 與 `go mod` 等檢查用的指令另外帶入 `GOPROXY=off`，確保檢查時不會下載任何模組（模組不在快取中時，該次執行失敗，而不是改為下載）。golangci-lint 與套件管理指令的模組來源是開發者自己的 Go 設定（`go env GOPROXY`、`GOSUMDB`）。
- CLI 執行 `golangci-lint run`（`check` 與 `fix --code` 的 `run --fix`）時一律加上 `--max-same-issues=0 --max-issues-per-linter=0`（不論設定檔怎麼寫，所有問題都列出、都修正，#90）與 `--allow-serial-runners`（另一個 golangci-lint 持有全域鎖時排隊等候，而不是失敗，#94）。`golangci-lint fmt` 不取這個鎖。
- **`.cmd` / `.bat` 檔一律透過 `cmd.exe /d /s /c` 執行**，例如 `code.cmd`、`mvnw.cmd`、`gradlew.bat`、`npm.cmd`。這類檔案無法直接當作程序啟動。

---

## 4. 專案宣告（`.devguard.yaml`）

放在 repo 根目錄的單一 YAML 檔。

```yaml
standard: team@1.1.0            # 繼承哪一版預設標準（必須寫確切版本）
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
  - 符合的檔案不歸屬任何元件、不提示「建議補上元件」，也不交給 `check`、`fix --code` 與各 hook 以檔案為單位的檢查（程式碼檢查、未涵蓋檔案），即使在命令列上指定或已 staged。
  - 測試以元件為單位，不受 `ignore` 影響：每個宣告的元件照常執行，`check --full` 仍是完整的檢查。`ignore` 的某一項涵蓋整個元件目錄時：**提示**（`declaration/ignored-component`），說明這個元件的檔案檢查都會略過。
  - `ignore` 管不到的範圍：以整個目錄為單位執行的工具（元件的 `eslint .`、`tsc`、`mypy` 等）與覆蓋率工具（Vitest / Jest 的 `coverage.include`、coverage.py、JaCoCo）依各自的設定決定範圍；要排除的檔案也要寫進該工具的設定。
  - 不是非空字串的清單時：**錯誤**（`declaration/invalid`），整份清單不生效。
- Java 的多模組（Maven）或多專案（Gradle）建置以根目錄為一個元件，測試與程式碼檢查讀取每個模組或子專案的報告，見 §6.4（#101）。
- 四種語言以外的檔案不在檢查範圍內。例外：指定檔案時（含 `--staged` 與各 hook，見 §7.1），TypeScript 元件內的非原始碼檔案交給該元件的 linter 與 formatter，由工具決定是否處理。

### 4.2 覆寫規則

每個標準項目都有一個**類型**，用來判斷覆寫是收緊還是放寬：

| 類型 | 更嚴格的方向 | 例子 |
|---|---|---|
| 上限 | 值越小越嚴格 | `complexity.cyclomatic` |
| 下限 | 值越大越嚴格 | `coverage.lines`、`*.minVersion` |
| 布林 | `true` 較嚴格 | `typecheck.strict`、`deps.lockfile` |
| 禁用清單 / 規則集 | 移除項目算放寬，新增項目算收緊 | `deps.banned`、`lint.rules` |
| 工具選擇 | 改用允許清單內的工具算替代，不算偏離；改用清單外的工具算放寬 | `lint.tool` |
| 版本範圍 | 超出範圍算放寬 | 各工具的版本範圍 |
| **風格** | 沒有嚴格或寬鬆之分，可以直接覆寫，不算偏離 | `format.*` |

- **放寬**時必須寫成 `{value, reason, until?}`。
  - 沒有理由，或理由仍是 `TODO`：**錯誤**。
  - 有理由：標示為**偏離**，不擋人，但一直列在報告中。
  - 超過 `until`：再變回**錯誤**。
- 覆寫不存在的項目、值的型別錯誤、重複宣告同一個元件：**錯誤**。
- 同一個 repo 裡，同語言的元件風格不一致時：**提示**。
- 覆寫鏡像與弱點掃描項目（頂層 `mirrors:`、`deps.vulnScan`、`deps.vulnFailOn`、`deps.ignoredVulns`、`tools.govulncheck`）：不論宣告哪個標準版本，都只是**提示**（`declaration/retired-item`），不判定收緊或放寬，也不算錯誤，因為 devguard 不再依它們做任何檢查（#64）；`standard upgrade` 到 `team@1.3.0` 會刪除它們。寫錯位置的（例如元件 `overrides` 中的 `mirrors.npm`）仍是不存在的項目，算**錯誤**。

### 4.3 沒有宣告時

CLI 依偵測到的工具設定檔產生**草稿**：
- 與預設相同的項目省略。
- 比預設寬鬆的項目帶上 `TODO` 理由，要填寫之後才算通過。
- `draft --ignore <路徑或 glob>`（可重複）：符合的檔案不用來推斷元件，清單原樣寫進草稿的 `ignore`。
- 元件依標記檔推斷：每個程式檔歸屬往上最近、含有該語言標記檔（`pyproject.toml`、`go.mod`、`package.json`、`pom.xml` 等）的目錄。下列檔案不成為元件，而是寫進草稿的 `ignore`（排在 `--ignore` 的項目之後），每項上方加一行註解說明原因（#89）：
  - `go.mod` 所在目錄或上層有 `go.work`，但這個目錄不在最近的 `go.work` 的 `use` 清單中（單行與 `use ( ... )` 區塊都支援）：寫入該目錄，註解「不在 go.work 的 use 清單中」。golangci-lint 在 workspace 模式下無法檢查這種模組。與 `go` 相同，`go.work` 不論是否被 git 忽略、即使在 repo 根目錄之上都算。例外：repo 根目錄的模組（`ignore` 無法只排除它），以及底下有 `use` 清單中模組的目錄，照舊是元件。沒有 `go.work` 的 repo，每個 `go.mod` 照舊是一個元件。
  - 往上找不到該語言標記檔的零星程式檔，且 repo 至少有一個有標記檔的元件時：寫入該檔案（同一目錄、同副檔名有多個時寫成 `<目錄>/*.<副檔名>`），註解「沒有 <語言> 的標記檔，未建立元件；若要檢查，請補上標記檔並新增元件」。整個 repo 都沒有標記檔時（例如純腳本 repo），這些檔案照舊成為 repo 根目錄的元件。
  - TypeScript 元件的目錄沒有 `tsconfig.json`，歸屬它的 TypeScript 與 JavaScript 檔案又全是工具設定檔（檔名為 `*.config.<副檔名>` 或 `.<名稱>rc.<副檔名>`，副檔名 `ts`／`mts`／`cts`／`js`／`mjs`／`cjs`，例如 npm workspaces 根目錄的 `lint-staged.config.ts`），且 repo 還有其他元件時：不成為元件，其中的 TypeScript 設定檔逐一寫入，註解「只有工具設定檔，沒有 TypeScript 原始碼與 tsconfig.json，未建立元件」（#125）。外層還有 TypeScript 元件時不寫入，這些檔案照 §4.1 歸屬外層元件。
- Python 例外（#106）：只有 `requirements.txt`（沒有 `pyproject.toml`、`setup.py`、`setup.cfg`）、又位於另一個 Python 元件之內的目錄（例如給 Read the Docs 用的 `docs/requirements.txt`），不另成元件，檔案歸屬上層元件；草稿在上層元件上方加一行註解「`<目錄>` 只有 requirements.txt，歸屬 `<上層>` 元件，未另建元件」。不在其他 Python 元件內的 requirements.txt-only 目錄照舊成為元件。

可直接移植的參考實作（`Std` 模組中的 `resolve`、`lookup`、`draftFromDetected`、`checkToolConfigs`）：[prototypes/07-project-declaration.prototype.html](.scratch/coding-standards-guard/prototypes/07-project-declaration.prototype.html)

來源：[專案宣告格式](.scratch/coding-standards-guard/issues/07-project-declaration-format.md)、[預設標準：Python](.scratch/coding-standards-guard/issues/08-default-standard-python.md)（新增風格類型）

---

## 5. 預設標準：共通部分

### 5.1 跨語言共通項目

| 項目 | 預設值 | 類型 |
|---|---|---|
| `complexity.cyclomatic` | 10 | 上限 |
| `complexity.cognitive` | 15（Python 不適用） | 上限 |
| `coverage.lines` | 80（0 以下表示不設覆蓋率門檻：`--full` 仍執行測試，但不判定覆蓋率，也不要求覆蓋率設定或報告） | 下限 |
| `deps.lockfile` | `true`（各語言的落地方式不同） | 布林 |
| `claude.minVersion` | `2.1.295`（`onFailure: block` 需要此版本） | 下限 |
| 各工具的版本範圍 | 發佈 `team@1.0.0` 時訂定，例如 `ruff >=0.17,<0.18`、`golangci-lint >=2.12`（`gomodguard_v2` 從 v2.12.0 才有） | 版本範圍 |

`team@1.2.0` 以前另有 `deps.vulnScan`（`false`）、`deps.ignoredVulns`（空）與 `mirrors.*`（Nexus 的 dummy 網址、`mirrors.auth: none`），`team@1.3.0` 移除（§5.3、§10）。

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
  - Python：`uv run <tool>`，工具須已安裝在專案環境中。專案環境是 `UV_PROJECT_ENVIRONMENT` 指定的目錄（絕對路徑照用，相對路徑相對於專案目錄，與 uv 相同），未設定時為 `.venv`；找不到工具時，訊息列出實際找過的專案環境路徑。Poetry 專案（最近的 lockfile 是 `poetry.lock`）不讀 `UV_PROJECT_ENVIRONMENT`，直接執行專案內 `.venv` 中的工具，所以 Poetry 必須設定 `virtualenvs.in-project true`
  - TypeScript：`node_modules/.bin/<tool>`（Windows 依序找 `<tool>.cmd`、`<tool>.exe`：npm／pnpm／Yarn 產生 `.cmd`，Bun 產生 `.exe`）
  - Go：`go tool <名稱>`
  - Java：`./mvnw` / `./gradlew`
- 工具尚未安裝時，CLI **不會自行下載**，而是報錯並附上一行安裝指令（例如 `uv sync`、`poetry config virtualenvs.in-project true && poetry install`、`npm ci`），套件來源是開發者使用者層級的設定（§10）。TypeScript 的安裝指令由元件目錄往上最近的 lockfile 決定，在該 lockfile 所在的目錄（workspace 根目錄）執行：`package-lock.json`／`npm-shrinkwrap.json` 為 `npm ci`，`pnpm-lock.yaml` 為 `pnpm install --frozen-lockfile`，`yarn.lock` 為 `yarn install --immutable`（Berry）或 `yarn install --frozen-lockfile`（classic），`bun.lock`／`bun.lockb` 為 `bun install --frozen-lockfile`；同一個目錄有多個 lockfile 時 `deps.manager` 的那一個優先；都沒有時改為 `deps.manager` 的一般安裝（例如 `npm install`），在最近的有 `package.json` 的目錄執行（#117）。標準要求的 Python 開發工具（型別檢查器、Ruff、pytest）不在專案環境、元件與上層目錄的 `pyproject.toml` 也都沒有列在依賴中時，`uv sync` 裝不到它，提示改為加入開發依賴的指令，格式與 `standard upgrade` 相同（§5.5）：uv 專案 `uv add --dev "<工具><範圍>"`，Poetry 專案 `poetry config virtualenvs.in-project true && poetry add --group dev "<工具><範圍>"`（前半與 `poetry install` 的提示相同，工具才會裝進 devguard 會找的專案內 `.venv`），範圍取標準的 `tools.<工具>`（#68）。已列在依賴中只是還沒安裝時，維持 `uv sync`／`poetry install`。找不到 uv 本身時，提示改為多行：列出官方安裝腳本、`pipx install uv`、`pip install uv`、`scoop install uv`（Windows），並說明已用 pip 安裝時要把 Python 的 Scripts 目錄（Windows）或 `~/.local/bin`（其他平台）加進 PATH，再以 `uv --version` 確認；devguard 不會到 PATH 以外的位置找 uv。

來源：[工具版本權威與一致性檢查](.scratch/coding-standards-guard/issues/14-tool-version-authority.md)

### 5.3 弱點掃描（已移除）

devguard 不再執行弱點掃描（#64）。原本的設計是四種語言預設關閉的進階項目（`deps.vulnScan`、`deps.vulnFailOn`、`deps.ignoredVulns`），開啟後在 `check --full` 執行 pip-audit、govulncheck、npm audit 與 OWASP Dependency-Check，資料來源指向內部鏡像（`mirrors.osv`、`mirrors.govulndb`、`mirrors.nvd`）。每個工具在內網都需要額外的基礎設施，各企業的條件也不同，所以整個移除，交給團隊自己的 CI 或資安工具。`team@1.3.0` 移除這些項目與 Go 的 `tools.govulncheck`；較舊的標準版本仍有這些項目，但 devguard 不依它們執行任何掃描。

來源：[預設標準：Java](.scratch/coding-standards-guard/issues/11-default-standard-java.md)、[內部鏡像設定檢查](.scratch/coding-standards-guard/issues/16-internal-mirror-config.md)（原始設計）

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
  - **minor**：不會讓任何專案失敗。例如新增選用項目、新增替代工具（`team@1.2.0` 新增 `basedpyright`）、放寬、擴大相容的工具版本範圍、移除 devguard 不再檢查的項目（`team@1.3.0` 移除鏡像與弱點掃描）。
  - **patch**：只修改說明。
- **專案宣告寫確切版本**。
  - 有 minor 或 patch 更新時，doctor 建議升級。
  - 宣告的版本比 CLI 內建的新：**錯誤**，提示從 GitHub Release 下載新版 devguard（§3.1）。
  - 宣告的版本已經不在 CLI 中：**錯誤**，提示升級標準。
- **`devguard standard upgrade`**：預設只預覽，內容包括：
  - 標準項目的差異（預設值，以及選項項目的可選值）
  - 對本專案的影響（哪些覆寫變得多餘、哪些會成為新的偏離或錯誤）
  - 需要調整的工具版本
  - 需要執行的套件管理指令

  新標準移除的項目，宣告中的覆寫會列為多餘並在 `--apply` 時刪除；刪除後空了的 `overrides:` 與頂層 `mirrors:` 也一併刪除。

  目標版本：同一個標準的較新版本；`legacy` 另外可以升級到它指定的 `team` 版本（`legacy@1.0.0` → `team@1.1.0`）及該 `team` 的較新版本。沒有指定目標時，取同一個標準的最新版本，沒有的話取 `legacy` 指定的 `team` 版本。其他目標（例如從 `team` 升到 `legacy`，或從 `legacy@1.0.0` 升到 `team@1.0.0`）以 `2` 結束。
- **基線標準 `legacy`**（§6.5）：給既有專案先納管用，最終要升級到 `team`。`legacy` → `team` 會收緊，不是 minor 更新，所以 doctor 不會建議；`devguard draft` 一律寫入 `team` 的最新版本，`team` 也不會升級到 `legacy`。
  加上 `--apply` 才實際修改宣告與設定檔，並執行套件管理指令（套件來源是開發者使用者層級的設定，CLI 不另外指定）。預覽不會詢問；有變更待套用時以 `1` 結束（§11）。Python 元件依最近的 lockfile 選擇指令（與 §5.2 執行工具的判斷相同）：uv 專案執行 `uv add --dev`；Poetry 專案執行 `poetry add --group dev <套件><範圍>`（PEP 508 形式，例如 `ruff>=0.18,<0.19`），不改用 uv。預覽中 Python 指令含 `>`、`<`、`,` 或空白的引數加上雙引號，可以直接貼到 shell 執行。
- **強制升級**：團隊可以把某個標準版本標為棄用並設定截止日。截止日之前只顯示提示，之後回報錯誤。

來源：[預設標準的版本發佈與專案升級方式](.scratch/coding-standards-guard/issues/12-standards-versioning.md)

---

## 6. 各語言的預設標準（`team@1.0.0` 草案，及 `team@1.1.0`～`team@1.4.0`、`legacy@1.0.0`）

本節的表格是 `team@1.0.0`。`team@1.1.0`（minor，§5.5）沿用 `team@1.0.0` 的所有項目，只有以下差異：

- TypeScript 不再要求 `eslint-plugin-sonarjs`（移除 `tools.eslint-plugin-sonarjs`，見 §6.3、§12 第 8 項）。使用 `eslint+prettier` 時只檢查 ESLint 內建的 `complexity`，不檢查 `sonarjs/cognitive-complexity`；使用 Biome 時 `complexity.cognitive` 仍以 `noExcessiveCognitiveComplexity` 檢查。因此在 `team@1.1.0` 與 `legacy@1.0.0` 下，TypeScript 的 `complexity.cognitive` 只在使用 Biome 時強制；使用 ESLint 時只是參考值，不會產生錯誤。
- 放寬版本範圍（#36，2026-10-27 審視）。工具版本範圍的下限不低於上游仍在修補的最舊版本線，已經是這個下限的就不改。
  - 語言最低版本不變：`java.minVersion` 維持 17（新專案的標準，主流框架如 Spring Boot 3 的最低需求；需要 Java 8 的既有專案改用 `legacy@1.0.0`，§6.5）。`python.minVersion` 3.11（3.10 已於 2026-10-01 EOL）、`node.minVersion` 22（20 已於 2026-04-30 EOL）、`go.minVersion` 1.26（1.25 在 1.27.0 發佈時結束支援）都已是仍受支援的最舊版本。
  - Python：`tools.ruff` `>=0.17,<1`、`tools.pyright` `>=1.1.400,<2`。
  - TypeScript：`tools.vitest` `>=4.1,<6`（Vitest 4.1 仍會收到安全性修正）。
  - Java：`tools.spotless-maven-plugin` `>=2.44,<4`、`tools.spotless-gradle-plugin` `>=7,<9`、`tools.checkstyle` `>=10.21,<15`。
  - 其餘工具範圍不變：ESLint 9（2026-08-06 EOL）、TypeScript 5、Jest 29、Biome 1、pytest 7、pytest-cov 6 之前、mypy 1.18 之前的版本線上游都不再發佈修正；Go 工具的現行版本已在範圍內。

`team@1.2.0`（minor，§5.5）沿用 `team@1.1.0` 的所有項目，只有以下差異（#68）：

- Python 的 `typecheck.tool` 多一個替代工具 `basedpyright`（§6.1），並新增 `tools.basedpyright` `>=1.40,<2`。下限依 #36 的原則取上游仍在修補的最舊版本線：basedpyright 的版本都從 `main` 依序發佈，不回補舊版本線（2026-11-03 查證 PyPI 與 GitHub Releases：1.39 的最後一版 1.39.10 在 1.40.0 之前發佈，目前最新是 1.40.2），所以只有 1.40 仍在維護；上限是下一個 major。

`team@1.3.0`（minor，§5.5）沿用 `team@1.2.0` 的所有項目，只移除 devguard 不再檢查的項目（#64）：

- 所有 `mirrors.*`（§10）。
- 各語言的 `deps.vulnScan`、`deps.vulnFailOn`、`deps.ignoredVulns`，以及 Go 的 `tools.govulncheck`（§5.3）。

`team@1.4.0`（minor，§5.5）沿用 `team@1.3.0` 的所有項目，只有以下差異（#113、#138）：

- Python 的 `tools.mypy` 改為 `>=1.18,<3`，同時允許 mypy 1.x 與 2.x。2026-11-08 查證 PyPI：1.x 的最後一版是 1.20.2（2026-04-21），2.0.0 於 2026-05-06 發佈，目前最新是 2.4.1（2026-10-28），2.0 之後 1.x 沒有修補版。下限維持，與 `team@1.1.0` 對已停止發佈的版本線的處理一致。
- TypeScript 的 `deps.manager` 增加替代工具 `bun`（預設仍是 `npm`，#138）。它的 lockfile 只認文字格式的 `bun.lock`（Bun 1.2 起）；Bun 1.2 之前的二進位 `bun.lockb` 讀不到套件版本，不算 lockfile。`bun test` 不算測試工具，`test.tool` 仍只允許 Vitest／Jest。

`devguard draft` 寫入、`doctor` 建議升級到的都是 CLI 內建的最新 `team` 版本（目前是 `team@1.4.0`）。既有專案可以改宣告基線標準 `legacy@1.0.0`（§6.5）。

### 6.1 Python

| 項目 | 預設值 | 落地方式 |
|---|---|---|
| `python.minVersion` | 3.11（專案的 `requires-python` 較高時以專案為準） | Ruff `target-version`、mypy `python_version` |
| `lint.tool` | `ruff`，lint 與 format 都用它 | `pyproject.toml [tool.ruff]` |
| `lint.rules` | `E, W, F, I, B, UP, C90, SIM, N, S, TID`；測試檔放寬 `S101` | 一律寫入 `lint.select`（會取代 Ruff 的預設規則集；Ruff 0.16 起預設規則大幅增加），不使用 `extend-select`；`per-file-ignores` |
| `format.lineLength` | 120（風格） | Ruff `line-length` |
| `complexity.cyclomatic` | 10 | Ruff C901 `max-complexity` |
| `typecheck.tool` | `mypy`；允許替代工具 `pyright`（`team@1.2.0` 起另有 `basedpyright`） | `[tool.mypy]` / `[tool.pyright]`（或 `pyrightconfig.json`）/ `[tool.basedpyright]`（或 `pyrightconfig.json`）。basedpyright 以 `basedpyright --outputjson` 執行，輸出格式與 pyright 相同。`devguard draft` 遇到 `pyrightconfig.json` 寫入 `pyright`，遇到 `[tool.basedpyright]` 寫入 `basedpyright`；`typeCheckingMode = "off"` 的設定（只是關掉編輯器的檢查）不作為推斷依據（#114）。與 pyright 相同，同一目錄的 `pyrightconfig.json` 優先於 `[tool.pyright]`／`[tool.basedpyright]`，元件目錄兩者都沒有時才往上層找。專案已有宣告的工具不讀的型別檢查器設定（`[tool.mypy]`／`mypy.ini`、`[tool.pyright]`、`[tool.basedpyright]`、`pyrightconfig.json`）時，`devguard install` 的預覽發出警告，說明可以宣告 `typecheck.tool` 改用既有工具；`install` 不修改宣告 |
| `typecheck.strict` | `true` | mypy `strict` / pyright、basedpyright `typeCheckingMode = "strict"`。宣告的 pyright／basedpyright 實際生效的設定是 `typeCheckingMode = "off"` 時，型別檢查等於被關閉，回報錯誤 `settings/typecheck-off`（不是 `typecheck.strict` 的偏離），`fix` 改為 `"strict"`（宣告 `typecheck.strict: false` 時改為 pyright 的預設 `"standard"`）；未宣告的檢查器設為 off 不回報（#114） |
| `test.tool` | pytest + pytest-cov | — |
| `coverage.lines` | 行覆蓋率與分支覆蓋率**各自**都要達到 80%（`branch = true`），與 TS、Java 一致 | CLI 執行 `coverage json`，從 `totals` 分別計算行與分支的覆蓋率並自行判定。不使用 `fail_under`，因為它在 branch 模式下檢查的是行加分支的合併總數。 |
| `deps.manager` | `uv`；允許替代工具 `poetry` | 決定 `deps.lockfile` 要求哪個 lockfile。執行工具（§5.2）與 `standard upgrade`（§5.5）不讀這個項目，只看最近的 Python lockfile：`poetry.lock` 時用 Poetry，否則用 uv |
| `deps.lockfile` | `uv.lock`（或 `poetry.lock`）必須提交；只有不帶 hash 的 `requirements.txt` 不算 lockfile。元件目錄的 `requirements.txt` 不帶 hash 而有 lockfile 時，`requirements.txt` 列出的套件（略過註解、空行、`-r`／`-c`／`--index-url` 等選項行、`-e`、URL 與本機路徑；名稱依 PEP 503 正規化：小寫、`_` 與 `.` 換成 `-`）都必須在 lockfile 的 `[[package]]` 中，否則回報錯誤 `deps/requirements-unlocked`，列出缺少的套件（最多 5 個，其餘只計數），修正提示為在元件目錄執行 `uv add -r requirements.txt`（`poetry.lock` 時為 `poetry add <套件…>`）。只比對名稱，不比對版本範圍；只看元件目錄的 `requirements.txt`，不看 `docs/requirements.txt`、`requirements-dev.txt` 等其他檔案（#137） | CLI 檢查 |

來源：[預設標準：Python](.scratch/coding-standards-guard/issues/08-default-standard-python.md)

### 6.2 Go

| 項目 | 預設值 | 落地方式 |
|---|---|---|
| `go.minVersion` | 1.26（`go.mod` 較高時以專案為準） | `go.mod` |
| `lint.tool` | golangci-lint v2，**≥2.12** | golangci-lint 採用的設定檔（`version: "2"`）：從元件目錄往上到 repo 根目錄，最近一層有設定檔的目錄，同層依 `.golangci.json` > `.golangci.toml` > `.golangci.yaml` > `.golangci.yml` 取第一份。檢查與修正都針對這一份並沿用它的格式；同層有多份時提示其他的會被忽略；整條路徑都沒有時才建立 `.golangci.yml`：元件在 repo 內某個 `go.work` 的 `use` 清單中時建立在 `go.work` 所在目錄，否則依元件或它上層最上面的 Go 元件決定：那個元件在 `go.work` 的 `use` 清單中時建在 `go.work` 所在目錄，否則建在它的目錄。這些元件共用一份，`fix` 只建立一次，內容包含每個元件的有效標準要加的設定（#88）。不是 v2 格式時只回報 `settings/golangci-version`（先 `golangci-lint migrate` 再重新 check），不檢查其他設定、不修正（#86）。多個 Go 元件共用同一份設定檔時，同一筆 finding（規則、檔案、行、訊息相同）只列一次、修正只套用一次：在回報它的元件中，列在目錄就是設定檔所在目錄的那個下，沒有時（例如設定在 `go.work` 所在、不是元件的目錄）列在目錄最上層的那個下（同層依宣告順序）。因此只有一個元件回報的 finding（例如該元件覆寫多加的 linter）照舊列在它下面（#92） |
| `lint.rules` | v2 預設組加上 `gosec, revive, errorlint, bodyclose, misspell, cyclop, gocognit, gomodguard_v2, depguard` | `linters.enable`；depguard 一定要寫明確規則 |
| `format.tools` | gofumpt + goimports（風格） | golangci-lint formatters；gopls `formatting.gofumpt` |
| `complexity.cyclomatic` / `cognitive` | 10 / 15 | `cyclop.max-complexity`（預設 10）/ `gocognit.min-complexity`，**必須明確設為 15**（預設 30） |
| `coverage.lines` | 80，排除 `// Code generated … DO NOT EDIT.` 與 `mocks/` | CLI 解析 `go tool cover -func` 的 total |
| `test.race` | 本機不強制（Windows 需要 cgo / gcc），交給 CI | — |
| `deps.lockfile` | `go.mod` 與 `go.sum` 必須提交，且 `go mod tidy -diff` 必須乾淨（有 diff：`deps/go-mod-untidy`；模組快取沒有依賴、離線查不到：`deps/go-modules-missing`，修正 `go mod download`；其他失敗：`deps/tool-failed`） | CLI 檢查 |

來源：[預設標準：Go](.scratch/coding-standards-guard/issues/09-default-standard-go.md)

### 6.3 TypeScript

| 項目 | 預設值 | 落地方式 |
|---|---|---|
| `node.minVersion` | 22 | `engines.node: ">=22"`：取元件目錄往上最近的 `package.json`（workspace 子元件沿用根目錄的，不另建）。下限取範圍的最低主版本（`>=20 <24`、`^20.1`、`20.x` 都是 20），低於 22 為 `settings/looser`（`draft` 寫成帶 TODO 理由的放寬），高於或等於 22 沒有 finding（專案較嚴以專案為準）；沒有 `engines.node` 為 `settings/engines-node-missing`（`fix` 加入 `engines.node`）；`\|\|` 組合、`*`、標籤等無法讀出下限的範圍為 `settings/config-value-unreadable` 提示。找不到 `package.json` 時不檢查（#118） |
| `lint.tool` | `eslint+prettier`；允許替代工具 `biome` | flat config + `.prettierrc` / `biome.json` |
| `lint.rules` | typescript-eslint `strictTypeChecked` | flat config |
| `format.printWidth` / `endOfLine` | 120 / `lf`（風格） | Prettier |
| `typecheck.strict` | `strict`，加上 `noUncheckedIndexedAccess`、`noImplicitOverride`、`noFallthroughCasesInSwitch` | `tsconfig.json`，用 `tsc --noEmit` 檢查 |
| `complexity.cyclomatic` / `cognitive` | 10 / 15 | ESLint `complexity` / `eslint-plugin-sonarjs` 的 `cognitive-complexity`（**授權為 LGPL-3.0-only，見 §12**；`team@1.1.0` 起不再要求，ESLint 只檢查 `complexity`）；使用 Biome 時改開 `noExcessiveCognitiveComplexity`。`team@1.1.0` 與 `legacy@1.0.0` 下，`cognitive` 只在使用 Biome 時強制，使用 ESLint 時只是參考值 |
| `test.tool` | `vitest`；允許替代工具 `jest` | — |
| `coverage.lines` | lines、branches、functions、statements 都是 80；覆蓋率必須涵蓋元件所有的原始碼，不只被測試 import 的檔案 | `coverage.thresholds` / `coverageThreshold.global`；並且必須設定 `coverage.include` / `collectCoverageFrom`，否則為錯誤 |
| `deps.manager` | `npm`；允許替代工具 `pnpm`、`yarn`（`team@1.4.0` 起加上 `bun`） | 決定 `deps.lockfile` 要求哪個 lockfile：`package-lock.json`（或 `npm-shrinkwrap.json`）、`pnpm-lock.yaml`、`yarn.lock`、`bun.lock` |
| `deps.lockfile` | lockfile 必須提交，由元件目錄往上找；CI 使用 `npm ci`。`deps.manager` 不是 `bun`、卻只有 Bun 的 `bun.lock`／`bun.lockb` 時，標準允許 `bun`（`team@1.4.0` 起）就提示把 `deps.manager` 設成 `bun`，否則說明 Bun 不是允許的套件管理工具（#122）。`deps.manager: bun` 卻只有 `bun.lockb` 時，提示執行 `bun install --save-text-lockfile` 轉換成 `bun.lock`（#138） | CLI 檢查 |

元件沒有 `tsconfig.json` 時，`fix` 建立的檔案設定 `typecheck.strict` 與 `typecheck.options`；元件底下有其他 TypeScript 元件時再加上 `exclude`：最外層子元件的目錄（相對於這個元件）與 `node_modules`（設定 `exclude` 會取代 TypeScript 預設排除的 `node_modules`），讓 `tsc` 不檢查子元件與依賴的檔案（#125）。

solution-style 的 `tsconfig.json`（`"files": []`、沒有 `include`、有 `references`）本身不檢查任何檔案：`typecheck.strict` 與 `typecheck.options` 改對每個被參照的 tsconfig 判斷（finding 與 `fix` 都指向被參照的檔案，solution 檔不修改；位在其他元件目錄內的參照交給該元件，巢狀的 solution 檔繼續往下追），型別檢查對每個參照執行 `tsc --noEmit -p <ref>` 並合併相同的錯誤。

來源：[預設標準：TypeScript](.scratch/coding-standards-guard/issues/10-default-standard-typescript.md)

### 6.4 Java

| 項目 | 預設值 | 落地方式 |
|---|---|---|
| `java.minVersion` | 17（新專案建議 21 以上） | `maven.compiler.release` / Gradle toolchain |
| `build.tool` | Maven 或 Gradle，必須提交 wrapper | CLI 一律透過 wrapper 呼叫，只執行該建置工具的 wrapper（`mvnw` 或 `gradlew`，元件目錄或上層），不會改用另一種。建置工具的判斷（設定、程式碼、測試、依賴各層共用）：宣告的 `build.tool` 優先；沒有宣告時，只有 `pom.xml` 是 maven，只有 Gradle 建置檔（`build.gradle(.kts)`、`settings.gradle(.kts)`）是 gradle；兩者都有時依提交的 wrapper，只有 `gradlew` 是 gradle，其餘（只有 `mvnw`、兩者都有或都沒有）是 maven |
| `format.tool` | Spotless 搭配 palantir-java-format（4 空白、120 欄，風格） | `spotless:check` / `spotless:apply` |
| `lint.tool` / `lint.rules` | Checkstyle（以 `google_checks.xml` 為基礎，移除與 palantir 衝突的格式類規則）+ PMD quickstart | `checkstyle.xml`、PMD ruleset（由 CLI 產生）。內建設定**不含**複雜度與 import 規則，產生時必須自行加入：Checkstyle 的 `IllegalImport`、`CyclomaticComplexity`（max 10），以及 PMD 的 `CognitiveComplexity`（reportLevel 15）。PMD quickstart 中的複雜度規則預設是註解掉的。 |
| `complexity.cyclomatic` / `cognitive` | 10 / 15 | Checkstyle / PMD |
| `test.tool` | JUnit 5 | — |
| `coverage.lines` | JaCoCo BUNDLE 層級，LINE 與 BRANCH 都要 0.80；排除 Lombok 產生的程式碼 | `jacoco:check`；在 `lombok.config` 設定 `lombok.addLombokGeneratedAnnotation = true` |
| `deps.lockfile` | Maven：Enforcer 的 `banDynamicVersions`（一條規則同時禁止版本範圍、LATEST / RELEASE 與 SNAPSHOT）加上 `dependencyConvergence`；Gradle：dependency locking 加上 `gradle.lockfile` | — |

Maven 多模組建置（`pom.xml` 有 `<modules>`）的 lint 指令在 `checkstyle:check pmd:check` 之前加上 `test-compile` phase：只執行 plugin goal 時，reactor 解析不到尚未建置的兄弟模組（本機 `~/.m2` 沒有它們的 SNAPSHOT 時整個指令失敗），PMD 的型別解析也因此有 classpath。所以多模組的 lint 會先編譯，比較慢；編譯失敗時回報 `code/tool-failed`，訊息是建置輸出中的錯誤行。報告從各模組的 `target/` 讀取。單一模組的 Maven、Spotless 與 Gradle 不加 phase。

建置檔的 plugin（#98）：設定層讀元件的建置檔（Maven `pom.xml` 的 `<build><plugins>` 與 `<pluginManagement>`；Gradle `build.gradle(.kts)` 的 `plugins {}`、`apply plugin`、`alias(libs.plugins.…)`；repo 中的 Maven parent POM 也算）。plugin 可能來自 devguard 讀不到的地方時（repo 外的 parent POM、`<profiles>`、Gradle convention plugin、`apply from`、上層 Gradle 建置、`apply false`）不回報，程式碼層照常執行。沒有 Spotless、Checkstyle 或 PMD 的 plugin 時各回報一筆 `settings/java-plugin-missing`；Checkstyle 沒有指向元件使用的 Checkstyle 設定檔（Maven `<configLocation>` 或 `checkstyle.config.location`；Gradle `configFile`／`configDirectory`，預設 `config/checkstyle/checkstyle.xml`），或 PMD 沒有指向元件使用的 ruleset（Maven `<rulesets>`；Gradle `ruleSetFiles`）時回報 `settings/java-plugin-config`，無法解析的路徑不回報。兩者依 §9.2 只印出片段（含 palantir-java-format，設定位置指向 devguard 的檔案），不修改建置檔。程式碼層不執行建置檔沒有 plugin 的工具；Gradle 的 Checkstyle 與 PMD task 分開執行，一個失敗不影響另一個的結果。JaCoCo 見 #99。

Gradle 的工具版本（#103）：工具版本一致性檢查（§5.2）讀 Checkstyle、PMD、SpotBugs 與 JaCoCo 的版本：`toolVersion`，以及 configuration 的 dependency（`checkstyle 'com.puppycrawl.tools:checkstyle:X'`、`pmd 'net.sourceforge.pmd:pmd-java:X'`（或 `pmd-core`）、`spotbugs 'com.github.spotbugs:spotbugs:X'`，Groovy 與 Kotlin DSL 都可）；同一個建置檔兩者都有時以 dependency 為準。多專案建置讀元件目錄與所有子專案（與 #101 的報告目錄相同）的建置檔；同一個工具在不同建置檔有超出範圍的版本時，各回報一筆 `tool-version/out-of-range`，指向該建置檔。version catalog（`libs.versions.toml`）宣告的版本與讀不到版本時的提示不在此範圍。

JaCoCo 與測試（#99）：`check --full` 以同一份建置檔 plugin 讀取判斷專案有沒有 JaCoCo（Maven `jacoco-maven-plugin`；Gradle `jacoco` plugin）。`coverage.lines` ≤ 0（如 `legacy@1.0.0`）時，指令不帶 `jacoco:report`／`jacocoTestReport`，只跑測試，也不要求覆蓋率報告。有門檻但沒有 JaCoCo 時同樣只跑測試，照常回報 `test/failed`，另加一筆 `coverage/no-report`（附設定說明）。建置檔判斷不出來時（plugin 可能來自讀不到的地方）仍帶報告 goal；wrapper 以 `No plugin found for prefix 'jacoco'`（Maven）或 `Task 'jacocoTestReport' not found`（Gradle）結束時，改只跑測試再重跑一次，並比照沒有 JaCoCo 處理。

Gradle 多專案建置（#101）：`settings.gradle(.kts)` 的 `include` 的子專案也各自寫報告，與 Maven 多模組相同，以元件目錄為一個元件。報告目錄是元件目錄加上 `include` 的子專案目錄（預設 `:a:b` 在 `a/b/`，支援 `project(':x').projectDir = file('lib')` 與 `File(settingsDir, "lib")`）；`include` 或 `projectDir` 的寫法讀不出來時，改掃描元件底下所有有 `build.gradle(.kts)` 的目錄（不含 `build/`、`.gradle/`、`buildSrc/`、`node_modules/`，以及有自己的 `settings.gradle(.kts)` 的獨立建置）。測試層從每個報告目錄讀 `build/reports/jacoco/test/jacocoTestReport.xml`，BUNDLE counter 加總後判定，一份都沒有才回報 `coverage/no-report`；程式碼層讀每個報告目錄的 `build/reports/checkstyle/{main,test}.xml` 與 `build/reports/pmd/{main,test}.xml`。建置前先刪除這些報告，只讀這次執行寫出的報告，不會讀到舊的。Checkstyle、PMD、Spotless、JaCoCo 只要元件目錄或任何一個子專案的建置檔套用就會執行。子專案建置檔中的 plugin 設定檢查不在此範圍（#98）。

來源：[預設標準：Java](.scratch/coding-standards-guard/issues/11-default-standard-java.md)

### 6.5 既有專案的基線標準（`legacy@1.0.0`）

`legacy@1.0.0` 讓既有（brownfield）專案先以務實的基線納管，不必為 80% 覆蓋率、strict 型別檢查與禁用清單寫一大堆 `reason`／`until`，之後再以 `devguard standard upgrade` 升級到 `team@1.1.0`（§5.5）。它沿用 `team@1.1.0` 的所有項目，只放寬以下項目：

| 項目 | `legacy@1.0.0` | 說明 |
|---|---|---|
| `coverage.lines` | 0 | `--full` 仍執行測試，測試失敗仍是錯誤；但不判定覆蓋率，也不要求覆蓋率設定（Vitest / Jest 門檻與 `include`、Python `branch = true`）或覆蓋率報告 |
| `typecheck.strict` | false（TypeScript、Python） | |
| `typecheck.options` | `[]`（TypeScript） | |
| `complexity.cyclomatic` / `cognitive` | 20 / 25 | Python 只有 `cyclomatic` |
| `deps.banned` | Python `pycrypto`；TypeScript `request`；Java `log4j:log4j`；Go 無 | 只保留有已知且不會修正的弱點的套件。JUnit 4（`junit:junit`）、`nose`、`moment`、`node-fetch`、`github.com/pkg/errors`、`github.com/golang/protobuf` 不再禁用 |
| `java.minVersion` | 8 | `team@1.1.0` 是 17；`legacy@1.0.0` 明確寫為 8，讓 Java 8 的既有專案可以納管 |

`java.minVersion` 是程式碼的**目標版本**（Maven `maven.compiler.release`、Gradle toolchain），不是執行工具用的 JDK。`legacy@1.0.0` 的 Java 工具版本範圍沿用 `team@1.1.0`，範圍內沒有能在 JDK 8 上執行的版本：執行 Java 工具至少需要 JDK 11（Checkstyle 10 起、spotless-maven-plugin 2.31 起、palantir-java-format 2.x）；使用 Spotless 3.x（Maven）或 8.x（Gradle）時需要 JDK 17。Java 8 的既有專案以 JDK 11 以上建置、以 release 8 為目標即可。有 Java 元件時，doctor 讀取 `java -version` 的主版本，低於 11 時給 `environment/java-runtime` 提示（不算錯誤；找不到 `java` 時不提示，工具執行失敗由 `check` 回報）。

升級到 `team@1.1.0` 時，預覽會列出這些項目收緊後專案新出現的錯誤。

---

## 7. 三道防線

### 7.1 各防線執行的檢查

| 檢查 | VS Code | Claude PostToolUse | Claude Stop | git pre-commit | git pre-push |
|---|---|---|---|---|---|
| lint、格式 | 擴充套件即時顯示 | 被編輯的檔案 | 這一輪改過的檔案 | staged 檔案 | — |
| 型別檢查 | 擴充套件即時顯示 | — | 這一輪改過的檔案 | staged 檔案所屬的元件 | — |
| 依賴規則（lockfile、禁用清單） | — | — | — | 只在依賴相關檔案被 staged 時 | — |
| 測試與覆蓋率 | 可手動執行的 task | — | — | — | `DEVGUARD_PRE_PUSH=full` 時完整執行 |

`devguard check --full` 與 CI 執行全部檢查，不受 `DEVGUARD_PRE_PUSH` 影響。pre-push 預設不跑任何檢查、直接放行，讓日常的 WIP push 不會被完整測試與覆蓋率計算擋住；完整測試與覆蓋率由 CI 的 `check --full` 把關（§7.4）。

指定檔案時（檔案參數、`--staged`、pre-commit、Claude 的兩個 hook、`fix --code`），TypeScript 元件內的非原始碼檔案（`.js`、`.mjs`、`.json`、`.md`、`.prettierrc`、`LICENSE` 等）也交給最深的 TypeScript 元件的 linter 與 formatter，由工具決定處理哪些：ESLint 用 `--no-warn-ignored`，Prettier 用 `--ignore-unknown`，Biome 用 `--files-ignore-unknown=true` 與 `--no-errors-on-unmatched`。工具設定的 ignore（`.prettierignore`、ESLint 的 `ignores`、Biome 的 `files`）照常生效；工具不處理的檔案不產生 finding，staged（stdin）時也一樣。因此回報的 lint 與格式問題，與整個元件的檢查對同一組檔案回報的相同。其他語言的原始碼仍歸各自的元件。型別檢查不變：只有元件內有原始碼檔案時才跑。

型別檢查的範圍是整個元件，由型別檢查器的設定決定。mypy 在元件目錄執行：mypy 實際讀到的設定（依 mypy 的順序找 `mypy.ini`、`.mypy.ini`、有 `[tool.mypy]` 的 `pyproject.toml`、有 `[mypy]` 的 `setup.cfg`，元件目錄沒有時往上層目錄找到 repo 根目錄為止，只用第一份）設了 `files` 時，devguard 不傳路徑，依設定檢查；否則傳 `.` 檢查整個元件。上層目錄的設定一樣套用在元件目錄執行的 mypy，所以其中的 `files` 路徑是相對於元件目錄解析。命令列有路徑時 mypy 會忽略設定中的 `files`。pyright 與 basedpyright 本來就不傳路徑。

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
- 缺少推薦的擴充套件時給**提示**（不是錯誤），附上安裝指令 `code --install-extension <id>`（擴充套件從哪裡下載由 VS Code 的設定決定）；訊息另外註明「若已安裝但被停用，請在 VS Code 中啟用」。找不到 `code` 指令或指令失敗時也只給提示。使用其他編輯器（IntelliJ IDEA、Cursor、Neovim 等）的開發者因此不會讓 `doctor` 失敗。
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
  - 當 `stop_hook_active` 為 true 且檢查仍失敗時，放行，並用 `systemMessage` 告知開發者，避免 Claude 陷入修正迴圈。`Stop` 檢查所有尚未 commit 的檔案，包含開發者在這一輪之前留下的修改；這類檔案最多讓 Claude 多修正一輪就會放行。
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
  - `devguard install` 安裝 `pre-commit` 與 `pre-push` 兩個 hook，內容都是一行 POSIX sh，例如 `exec devguard hook git-pre-commit`，由 git 呼叫的 sh 執行（Windows 上是 Git for Windows 附帶的 sh）。
  - 檔案內含 CLI 標記與 checksum。
  - 不使用 pre-commit、lefthook 或 husky 等框架。
- **既有 hook 框架**：專案已經在用這類框架時，CLI 不覆寫它的 hook，而是在它的設定中注入一條呼叫 `devguard` 的項目：
  - pre-commit：一條 `language: unsupported` 的 local hook。`unsupported` 是 pre-commit 4.4.0 加入的值（`system` 的新名稱），所以需要 pre-commit 4.4.0 以上；CLI 同時確保頂層的 `minimum_pre_commit_version` 至少為 `"4.4.0"`：沒有就加上，較低就調高，較高就保留。版本不夠時，pre-commit 會自己回報需要的最低版本，而不是只說不認得 `unsupported`。設定沒有頂層 `default_stages` 時，CLI 也加上 `default_stages: [pre-commit]`：pre-commit 對沒寫 `stages` 的 hook 預設在所有已安裝的 hook 型別執行，安裝 pre-push hook 型別後，專案原本只在 commit 執行的 hook 會在每次 push 也執行。已有 `default_stages`（任何值）時不動。
  - husky：`.husky/pre-commit` 中加一行
  - lefthook：加一個 job（YAML、TOML、JSON / JSONC 設定檔都支援）
  - pre-commit 與 lefthook 的項目要等框架的安裝指令（`pre-commit install --hook-type pre-commit --hook-type pre-push`、`lefthook install`）把 hook 寫進 hooks 目錄才會執行。`install` 結束時（預覽與套用都一樣）用與「已安裝」環境檢查相同的判斷確認；還沒寫入時印出這條指令作為下一步。`install` 不自己執行它，這則提示也不影響 exit code。
- **找不到 CLI**：擋下 commit。錯誤訊息附上安裝指令，並提示可用 `--no-verify` 暫時略過。
- **部分 staged 的檔案**：不做 stash，也不還原任何檔案。
  - formatter 與單檔 linter 改用 `git show :<path>` 取出 **staged 版本**，再以 stdin 交給工具檢查，例如 `ruff check|format --stdin-filename`、`eslint --stdin --stdin-filename`、`prettier --stdin-filepath`、`biome format --stdin-file-path`，以及 Go 的格式檢查 `golangci-lint fmt --stdin`（套用設定中的 gofumpt、goimports）。這可以避免最常見的誤判：工作目錄已經格式化，但 commit 進去的版本沒有。
  - 型別檢查（mypy、pyright、tsc）、golangci-lint 與 Java 工具（Spotless、Checkstyle、PMD）沒有 stdin 模式，而且本來就會讀磁碟上的其他檔案，所以仍然檢查工作目錄的版本。
  - `biome lint` 也檢查工作目錄的版本，與未 staged 的檔案一樣以檔案路徑執行：Biome 2.x 從 stdin 讀取時不回報任何 lint 診斷（不論內容，一律 exit 1 並只印出 `The contents aren't fixed`），`--write` 則會吞掉錯誤。不把 staged 內容寫成暫存檔再檢查，因為 Biome 依路徑套用 `includes` 與 `overrides`。
  - 印出的警告要說明哪些檢查用的是工作目錄版本。
- **hook 只做檢查、不做修正**：失敗時印出 `devguard fix --code <files>`。`<files>` 只列出同時符合兩個條件的檔案：這次 commit 有 stage（刪除的檔案不算），而且至少有一個 `fix --code` 能修正的程式碼層 finding（`Finding.fixable`）。只有型別檢查（tsc、mypy、pyright、basedpyright）或其他需手動修正的 finding 的檔案不列入；沒有符合的檔案時不印這一行，commit 仍然被擋下。
- **專案工具不繼承 git 的 repo 定位變數**：git 執行 hook 前會匯出 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE` 等變數（`githooks(5)`），在 worktree 中 `GIT_DIR` 是絕對路徑。CLI 代為執行的專案工具（測試、linter、formatter、型別檢查、套件管理指令）的環境中移除 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、`GIT_OBJECT_DIRECTORY`、`GIT_ALTERNATE_OBJECT_DIRECTORIES`、`GIT_COMMON_DIR`、`GIT_PREFIX`，其餘變數照常傳遞；否則專案測試在暫存目錄中執行的 `git init`、`git commit` 會寫進外層的 repo。CLI 自己執行的 git 指令保留這些變數，例如 pre-commit 用 `git show :<path>` 讀 staged 版本時仍使用 git 提供的 index。
- **pre-push 的完整測試由開發者開啟**：`install` 照常安裝 pre-push hook，但 hook 只在環境變數 `DEVGUARD_PRE_PUSH` 為 `full` 時，才執行 `check --full` 中的測試與覆蓋率；未設定或其他值時直接放行，什麼都不印。開關放在開發者的環境而不是專案宣告，所以不改變 §4 的格式，切換時也不需要重新執行 `install`。
- **「已安裝」的環境檢查**
  1. 讀取 `core.hooksPath` 及其設定來源。
  2. 若使用既有框架，確認其設定中有呼叫 CLI 的項目；使用 pre-commit 或 lefthook 框架時，另外確認 `pre-commit install --hook-type pre-commit --hook-type pre-push`／`lefthook install` 已執行（hooks 目錄中有該框架為 pre-commit、pre-push 產生的 hook）；使用 pre-commit 框架時，也確認設定的 `minimum_pre_commit_version` 至少為 `"4.4.0"`（缺少或較低都是錯誤，`devguard install` 會修正），且有 CLI 的 pre-push 項目時設定了頂層 `default_stages`（缺少是錯誤，不依 `DEVGUARD_PRE_PUSH` 降為提示，`devguard install` 會修正）。沒有使用框架時，確認 hook 檔存在、有 CLI 標記，且 checksum 正確；hook 檔不是 devguard 產生的時，確認它呼叫 devguard，而且呼叫出現在第一個結束腳本的頂層無條件指令（`exit`、執行其他程式的 `exec`、以 `.`／`source` 載入其他腳本）之前。`install` 不修改這種 hook，只印出要加在開頭的一行，並以 `1` 結束。
  3. `core.hooksPath` 指向 `/dev/null` 或不存在的目錄時，回報錯誤。

  步驟 2 中 pre-push 的問題（hook 不存在或被修改、框架設定缺項目、框架尚未寫入 pre-push hook），在沒有設定 `DEVGUARD_PRE_PUSH=full` 時只列為**提示**，因為這時 pre-push 本來就不跑任何檢查；設定之後才算錯誤。
- **促使開發者安裝**：VS Code 的 folderOpen task 與 Claude Code 的 SessionStart 都會執行 doctor。doctor 只回報問題並附上 `devguard install` 指令，不會自動安裝。

來源：[pre-commit 框架比較研究](.scratch/coding-standards-guard/research/02-precommit-framework-options.md)、[CLI 實作語言與分發方式決策](.scratch/coding-standards-guard/issues/05-cli-runtime-decision.md)

---

## 8. 一致性檢查

| 比對項目 | 不一致時 |
|---|---|
| 專案鎖定的工具版本是否落在預設標準的範圍內。Python 的型別檢查器只檢查元件宣告的 `typecheck.tool` 那一個（#113，所有標準版本）：宣告 basedpyright 的專案即使 lockfile 中有 mypy，也不檢查 mypy 的範圍 | 錯誤 |
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
- `fix` 建立元件的 `pyproject.toml`、而元件目錄有 `requirements.txt` 時，套用後多印一行，提示在元件目錄執行 `uv add -r requirements.txt`，把執行期依賴匯入 `pyproject.toml` 與 `uv.lock`；`fix` 不會自己執行（#137）。
- **使用者層級的設定一律不修改**，只印出修改說明，例如 `~/.m2/settings.xml`、使用者的 `.npmrc`、`go env`、環境變數。

### 9.2 依檔案類別決定修改方式

| 類別 | 範例 | 做法 |
|---|---|---|
| CLI 全權產生 | `checkstyle.xml`、PMD ruleset、`.claude/rules/*`、`/standards-doctor` skill、git hook | 整份重新產生，檔頭標示「由 CLI 產生」。例外：檔案已存在、非空白、且沒有「由 CLI 產生」檔頭時，表示不是 devguard 產生的，一律不覆寫（`--yes` 也一樣），只印出要加入的內容：Checkstyle 設定與 PMD ruleset 印出缺少或要換掉的 module / rule，其餘印出完整的產生內容；`check` 也只提示手動修正。git hook 由 `install` / `fix` 以 hook 自己的標記判斷（§7.4） |
| 結構化的共用檔 | `pyproject.toml` 的 `[tool.*]`、golangci 設定檔（`.golangci.json` / `.toml` / `.yaml` / `.yml`）、`tsconfig.json`、`.prettierrc`、`.npmrc`（只有帳密引用，不寫 `registry=`）、`.vscode/*`、`.claude/settings.json` | 只修改 CLI 管理的 key，並保留註解與順序（YAML 用 `yaml`，JSONC 用 `jsonc-parser`，TOML 用 `@decimalturn/toml-patch`；`@shopify/toml-patch` 需要在執行時載入 wasm，可能無法打包進 Bun exe）。YAML（golangci 設定檔，以及 `install` 寫入的 `.pre-commit-config.yaml`、lefthook 設定）中修改沒有碰到的行逐字保留：flow collection 的寫法（`[a]` 或 `[ a ]`）、行尾註解前的對齊空白、引號都不變；新增或修改的 flow collection 不加內側空白（#87）。TOML 的修改結果無法解析時不寫入該檔，改為印出要套用的修改 |
| 建置檔與程式碼形式的設定檔 | `pom.xml`、`build.gradle`、`settings.gradle`、`vitest.config.ts`、`eslint.config.js` | 不自動修改，只印出要套用的片段或 diff |

### 9.3 互動方式

- 互動式終端機：先預覽，確認後才套用。
- 加上 `--yes`：直接套用。
- 非互動環境且沒有加 `--yes`：只預覽，並以非 0 結束。
- 由 Claude 代為修正：經開發者同意後，執行 `fix --yes`。

來源：[fix 行為與檢查報告格式](.scratch/coding-standards-guard/issues/17-fix-and-report-format.md)

---

## 10. 套件來源與帳密

devguard 不檢查也不寫入套件從哪裡下載（#64；npm 的部分先於 #65 處理）。各企業的限制不同，使用者最清楚：

- 套件、工具與 VS Code 擴充套件的來源（內部鏡像、registry、index、marketplace）設定在開發者使用者層級，例如 `npm config set registry`、uv 的 `UV_DEFAULT_INDEX`、Poetry 的 source 或環境變數、`~/.m2/settings.xml`、`go env -w GOPROXY=… GOSUMDB=…`。寫死在專案中會覆蓋使用者的企業設定。
- CLI 執行的套件管理指令（§5.5 的 `standard upgrade --apply`）與工具（§3.2 的 golangci-lint）不帶入任何來源設定，照這些使用者層級的設定下載。
- 舊版 devguard 寫進專案的鏡像設定（`.npmrc` 的 `registry=`、`[[tool.uv.index]]` / `[[tool.poetry.source]]` 的 `nexus`、`.mvn/settings.xml` 與 `.mvn/maven.config`）不會自動刪除，由使用者自行處理。

**帳密**
- 帳密**絕不進 repo**，CLI 也不保存。`check` 的 `credentials` 層把提交進專案的明碼帳密回報為**錯誤**（`credentials/plaintext`），只說明位置，不印出值：
  - `.npmrc` 的 `_auth`、`_authToken`、`_password`（含 registry 前綴的形式），值不是 `${NAME}` 環境變數引用時（npm 會去掉引號，所以 `"${NAME}"` 也是引用）
  - `pyproject.toml` 中任何位置的網址內含密碼（`user:password@`，密碼只引用變數如 `${PASS}` 的除外）或以 token 當作帳號（`ghp_…@`、`glpat-…@` 等），例如 uv 的 index 與 `[tool.uv.pip]`、`[tool.uv.sources]` 的 git／url、Poetry 的 source、直接以網址指定的依賴（`pkg @ https://…`）。只有帳號（`git@`、`deploy@`）不算帳密
  - `.mvn/settings.xml` 的 `<password>`、`<passphrase>` 不是屬性引用（`${env.PW}`、`${nexus.password}`）、Maven 加密過的密碼（`{…}`）或空值時。`<privateKey>` 是金鑰檔的路徑，不檢查
  - 每個元件的這些檔案，在元件目錄與上層各目錄中查找，與工具本身相同（npm workspace 根目錄的 `.npmrc`、uv workspace 根目錄的 `pyproject.toml`、多模組建置的 `.mvn/`）；多個元件共用的檔案只回報一次
- 沿用上層設定的 Python 子元件（#106）：元件目錄沒有 `pyproject.toml` 時，設定檢查改以上層最近的 `pyproject.toml`（與工具相同）判斷，不再要求建立元件自己的 `pyproject.toml`。設定檢查的 finding 落在元件目錄以外的檔案（上層的 `pyproject.toml`、`ruff.toml`、`pyrightconfig.json` 等）時，不附自動修正，訊息說明這份設定由哪個檔案擁有、由使用者決定調整子元件宣告的 overrides 或修改那份檔案（元件目錄自己的 `pyproject.toml` 缺少某個工具的表、工具改讀上層的設定時也一樣）；`fix` 不修改它，也不在子元件目錄建立新的設定檔。擁有那份設定的上層元件，其 `fix` 照常修改。
- `fix` 不改寫帳密：帳密已經外洩，必須更換；改由哪個環境變數或使用者層級設定提供，由開發者決定。
- `fix`、`install` 與 `standard upgrade` 的預覽、印出的片段與報告中，一律遮蔽帳密的值（`.npmrc` 的 `_auth` / `_authToken` / `_password`、Maven 的 `<username>` / `<password>`、網址中的 `user:password@`）；只引用環境變數（`${…}`）的值照常顯示。

原本的設計（內部 Nexus 鏡像網址 `mirrors.*`、專案層級的鏡像設定、`mirrors.auth: env` 與 doctor 的帳密變數檢查）見[內部鏡像設定檢查](.scratch/coding-standards-guard/issues/16-internal-mirror-config.md)；`team@1.2.0` 以前的標準仍有 `mirrors.*` 項目，但 devguard 不再依它們做任何檢查，宣告中寫著它們只會得到提示（§4.2）。

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

項目編號維持不變，其他文件與程式碼以編號引用；已不需要的項目標示「已移除」。

1. 開發者使用者層級的套件來源設定（§10）能取得專案的依賴。（原本是以真實的 Nexus 網址取代 dummy 網址，#64 移除。）
2. §7.2 推薦的 VS Code 擴充套件，開發者都能取得（從哪裡安裝由 VS Code 的設定決定）。
3. 開發者能從 GitHub Release 下載 devguard 的執行檔（§3.1），並取得預設標準指定版本的 golangci-lint binary。
4. 已移除（#64）：原本是在 Nexus 上建立 `mirrors.gosumdb` raw proxy。
5. `team@1.1.0` 的工具版本範圍（含 golangci-lint）已在 #36 審視並訂定（2026-10-27）。只有 `team@1.0.0` 保留原本的佔位範圍：它已發佈，不再修改（§5.5）。
6. Windows 開發者的機器上有 Git for Windows（git hook 的 sh 依賴它）。Linux 與 macOS 使用系統的 sh。
7. 已移除（#64）：原本是確認公司內部 marketplace 的類型。
8. **法務確認**：`eslint-plugin-sonarjs` 的授權是 LGPL-3.0-only。`team@1.1.0` 已不再要求它（§6）：使用 ESLint 的 TypeScript 專案只檢查循環複雜度，認知複雜度不檢查，devguard 自己也宣告 `team@1.1.0`。仍宣告 `team@1.0.0` 的專案照舊要求這個 plugin。
9. 已移除（#64）：原本是開啟弱點掃描所需的 NVD 鏡像、`mirrors.govulndb` 與 Sonatype Repository Firewall 授權。

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
| — | 目前沒有。原本的 T4–T6（內部 marketplace、npm audit bulk 端點、osv-scanner 離線模式）隨鏡像與弱點掃描一起移除（#64） | — |

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
