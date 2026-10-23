# devguard

讓 Java、Python、Go、TypeScript 專案的標準（coding standard、complexity、test coverage、dependency）用**一份設定**同時落實到三道防線，並幫開發者快速確認自己的環境是否設定正確。

| 防線 | 時機 | devguard 做什麼 |
|---|---|---|
| 第一道：VS Code | 撰寫時 | 產生並檢查 workspace 設定，讓擴充套件即時顯示問題 |
| 第二道：Claude Code | Claude 編輯檔案時 | 產生 `.claude/` 的 rules、hooks 與 `/standards-doctor`，事前告知標準、事中檢查回饋 |
| 第三道：git hook | commit / push 時 | 安裝 pre-commit 與 pre-push hook，擋下不合格的變更 |

單一事實來源是 **預設標準**（內建在 CLI，例如 `team@1.0.0`）加上專案自己的 **專案宣告** `.devguard.yaml`。完整設計見 [SPEC.md](SPEC.md)，用語定義見 [GLOSSARY.md](GLOSSARY.md)。

## 目前狀態

**v0.1.0：SPEC 的指令都已實作**（`check`、`doctor`、`fix`、`install`、`hook`、`draft`、`standard upgrade`）。尚未完成的是發佈：Bun 打包的 exe 還沒在實機上建置驗證（#27），簽章與內部 Scoop bucket 也還沒建立（#28）。見下方[路線圖](#路線圖)與[已知限制](#已知限制)。

## 快速開始

需要 Node.js **22.18 以上**（直接執行 TypeScript 原始碼需要 Node 內建的 type stripping）。

```bash
npm install
npm run devguard -- check
```

在一個專案中導入：

```bash
devguard draft      # 還沒有 .devguard.yaml 時：依既有設定產生宣告草稿
devguard install    # 產生 .vscode/、.claude/、工具設定檔、鏡像設定，並安裝 git hook（先預覽）
devguard doctor     # check 加上環境檢查：擴充套件、hook、Claude Code、鏡像帳密
```

正式發佈時，devguard 會用 Bun 打包成單一 `devguard.exe`，透過公司內部的 Scoop bucket 安裝（SPEC §3.1）。

## 專案宣告 `.devguard.yaml`

放在 repo 根目錄。最精簡的寫法：

```yaml
standard: team@1.0.0
components:
  - path: ./
    language: typescript
```

monorepo 與覆寫的寫法：

```yaml
standard: team@1.0.0            # 必須寫確切版本
components:                     # 元件 = 目錄 + 語言
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
  auth: env                     # 內部 Nexus 需要帳密時
```

規則摘要（細節見 SPEC §4）：

- **收緊**標準、改用**允許清單內**的替代工具、修改**風格**項目，都可以直接寫值。
- **放寬**標準必須寫 `reason`，報告中會標示為**偏離**，不會擋人；超過 `until` 的日期後變回**錯誤**。
- 理由仍是 `TODO`、覆寫不存在的項目、值的型別錯誤、重複宣告同一個元件，都是**錯誤**。
- 每個檔案歸屬於路徑最長且語言相符的元件；沒有元件涵蓋時，依副檔名推定語言並套用預設標準。

可以覆寫的項目與預設值，見 [src/standard/team-1.0.0.ts](src/standard/team-1.0.0.ts) 或 SPEC §5、§6。

### 鏡像（`mirrors.*`）

`mirrors.pypi`、`npm`、`go`、`maven` 等預設指向內部 Nexus（SPEC §10.1）。改成同一台內部主機上的其他 repository 直接寫值即可；**改成內部主機以外的網址算放寬**，必須寫成 `{value, reason}`，報告中一直列為偏離，沒有理由就是錯誤。這樣 §10.2「設定指向外部來源是錯誤」不會被宣告悄悄繞過。devguard 自己在公司網路外開發，所以它的 [.devguard.yaml](.devguard.yaml) 就是這樣寫的：

```yaml
mirrors:
  npm:
    value: https://registry.npmjs.org/
    reason: "devguard 本身在公司網路外開發，沒有內部 Nexus 可用"
```

### 還沒有宣告：`devguard draft`

專案還沒有 `.devguard.yaml` 時（`check` 會回報「找不到 .devguard.yaml」並建議這個指令），執行 `devguard draft`，依偵測到的元件與既有的工具設定產生**草稿**並寫入 `.devguard.yaml`（SPEC §4.3）：

- **元件**：每個 `.py`、`.go`、`.ts`、`.java` 檔歸屬於最近一層有該語言建置或工具檔（`pyproject.toml` / `setup.py` / `setup.cfg` / `requirements.txt`、`go.mod`、`package.json` / `tsconfig.json`、`pom.xml` / `build.gradle(.kts)` / `settings.gradle(.kts)`）的目錄，沒有的話歸屬 repo 根目錄；monorepo 會產生多個元件。Java 的多模組建置以最外層的建置檔為一個元件。
- **覆寫**：沿用設定檢查讀取的工具設定。與預設相同的值省略；比預設嚴格的值、風格項目直接寫入；比預設寬鬆的值寫成 `{value, reason: "TODO: …"}`，**填寫理由之前 `check` 會回報錯誤**。
- **不覆寫**：`.devguard.yaml` 已存在時不做任何修改，以 exit code `2` 結束。

### 工具版本範圍

`check` 會讀出各元件用依賴管理鎖定的工具版本（`uv.lock` / `poetry.lock`、`package-lock.json`、`go.mod` 的 `tool`、`pom.xml` / `build.gradle(.kts)` 中的 plugin 版本），超出標準的版本範圍（`tools.<工具>` 項目）就回報錯誤。golangci-lint 例外：從 PATH 呼叫 `golangci-lint --version` 核對。專案用 pre-commit 框架時，其他工具 hook 的 `rev` 與鎖定版本不同會給提示（SPEC §8）。

> **待團隊訂定**：`team@1.0.0` 中各工具的版本範圍、golangci-lint 與 Dependency-Check plugin 的指定版本目前都是**佔位值**（SPEC §12 第 5 項），發佈前必須換成團隊訂定的值。

## 指令

```
devguard check [檔案…] [--staged] [--full] [--only lint|format|typecheck] [--format <格式>] [--strict] [--verbose]
devguard doctor [--quiet] [--exit-zero] [--format <格式>] [--strict] [--verbose]
devguard fix [--yes]
devguard fix --code [檔案…] [--yes]
devguard install [--yes]
devguard hook git-pre-commit|git-pre-push|claude-session-start|claude-post-edit|claude-stop
devguard draft
devguard standard upgrade [目標版本] [--apply]
devguard --version | --help
```

每個指令都接受 `--cwd <dir>`（專案根目錄，預設為目前目錄）。

| 指令 | 說明 |
|---|---|
| `check` | 設定、一致性與程式碼檢查（lint、格式、型別），不含環境檢查。給 CI 與 git hook 使用。指定檔案時只檢查這些檔案 |
| `check --staged` | 只檢查 staged 的檔案，與 pre-commit hook 相同：formatter 與單檔 linter 讀 staged 版本（stdin），依賴相關檔案 staged 時才跑依賴規則 |
| `check --full` | 再加上測試、覆蓋率與（開啟時的）弱點掃描，與 pre-push hook 相同 |
| `doctor` | `check` 加上環境檢查：工具是否安裝、git hook 是否安裝（含既有 hook 框架與 `pre-commit install`）、VS Code 擴充套件、Claude Code 版本、Go 鏡像、帳密變數是否存在、npm audit 端點、標準是否有更新。只回報並附上修正指令，不自動安裝 |
| `fix` | 修正**設定**：工具設定檔、`.vscode/`、`.claude/`、被修改過的 devguard git hook、`.gitattributes`、`lombok.config`。CLI 產生的檔案整份重新產生；共用的結構化檔只改 CLI 管理的 key；建置檔與程式碼形式的設定只印出片段（SPEC §9.2） |
| `fix --code` | 修正**程式碼**：格式化與可自動修正的 lint（Ruff、ESLint、Prettier、Biome、golangci-lint、Spotless），修正後回報剩餘問題 |
| `install` | `fix` 會產生的設定，加上 `.claude/` 的初次產生與 pre-commit / pre-push hook。專案已在用 pre-commit、husky 或 lefthook（YAML、TOML、JSON）時，改為在其設定中注入呼叫 devguard 的項目 |
| `hook <名稱>` | 給 git 與 Claude Code 的 hook 呼叫；各自處理輸入格式與 exit code |
| `draft` | 見上方 |
| `standard upgrade` | 預覽標準升級的差異、對本專案的影響與要執行的套件管理指令；`--apply` 才實際修改 |

| 選項 | 說明 |
|---|---|
| `--format text` | 預設。依元件、等級（錯誤、偏離、提示）分組，最後一行是總結 |
| `--format json` | `{ standard, components[], findings[] }`，給 CI 或其他工具使用 |
| `--format sarif` | SARIF 2.1.0，只含程式碼類問題，給程式碼審查平台 |
| `--format vscode` | 每個問題一行 `檔案:行:欄: 等級: 訊息 [規則]`，給 VS Code problem matcher |
| `--format claude` | 最多 20 項、少於 4,000 字元，給 Claude Code |
| `--strict` | 偏離也算失敗 |
| `--verbose` | 展開所有提示（預設只顯示數量） |
| `--quiet` | doctor：只輸出錯誤與偏離，沒有問題時不輸出 |
| `--exit-zero` | doctor：有問題時也以 0 結束（`/standards-doctor` skill 嵌入結果用） |
| `--yes` | fix / install：不詢問，直接套用。非互動環境沒有加 `--yes` 時只預覽，並以 1 結束 |
| `--apply` | standard upgrade：實際套用 |

**exit code**（SPEC §11）：`0` 通過（只有偏離或提示也算通過）、`1` 有錯誤（或 `--strict` 時有偏離）、`2` CLI 本身出錯（參數錯誤、內部例外）。專案的工具尚未安裝時，`check` 以 `2` 結束並印出安裝指令（例如 `uv sync`、`npm ci`）；`doctor` 與各 hook 則把它回報成一項錯誤（附安裝指令），其餘檢查照常執行。

**帳密**：預覽、片段與報告中一律不顯示帳密的值（`.npmrc` 的 `_auth` / `_authToken` / `_password`、Maven 的 `<username>` / `<password>`、網址中的 `user:password@`）；只引用環境變數（`${…}`）的值照常顯示（SPEC §10.3）。

輸出範例：

```
標準：team@1.0.0

web/ (TypeScript)
  錯誤  覆蓋率門檻 (%)：80 → 60：比預設寬鬆，必須寫理由（改用 {value, reason, until}）  [declaration/looser-without-reason] .devguard.yaml:6

./ (Python)
  偏離  循環複雜度上限：10 → 15｜理由：舊專案｜到期：2027-03-31  [declaration/deviation] .devguard.yaml:13

1 個錯誤、1 個偏離、0 個提示
```

## 開發

| 指令 | 用途 |
|---|---|
| `npm test` | 執行測試（Vitest） |
| `npm run test:coverage` | 測試並檢查覆蓋率（四項門檻皆為 80%） |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint（typescript-eslint `strictTypeChecked`，循環複雜度上限 10） |
| `npm run format` / `format:check` | Prettier（行寬 120、LF） |
| `npm run devguard -- <指令>` | 從原始碼執行 CLI，例如 `npm run devguard -- check` |
| `npm run build:exe [-- x64\|arm64]` | 用 Bun（≥ 1.2.23）打包成 `dist/devguard-windows-<arch>.exe`，含圖示與版本資訊。交叉編譯的目標沒有圖示與版本資訊（Bun 的限制） |
| `npm run smoke:exe [-- <exe>]` | 從 PATH 移除 Node 後，對 exe 執行 `--version` 與 `check`（範例專案） |
| `npm run t2:probe` / `build:t2-probe` | SPEC §13 T2：子程序行為探測，先在 Node 下跑基準，再打包成 `dist/t2-probe-windows-<arch>.exe` 執行比對 |

devguard 本身也遵守 SPEC §6.3 的 TypeScript 預設標準，並以 [.devguard.yaml](.devguard.yaml) 宣告自己。**例外：認知複雜度（上限 15）目前沒有檢查**。標準用 `eslint-plugin-sonarjs` 的 `cognitive-complexity`，但它的授權是 LGPL-3.0-only，還在等法務確認（SPEC §12 第 8 項），所以 devguard 自己還沒有加入；`devguard check` 對自己會一直顯示這一項提示。

測試大多在同一個程序內執行 CLI（`runCli`，[src/main.ts](src/main.ts)），以假的 `ToolRunner` 代替 ESLint、Ruff 等工具；只有少數測試真的啟動 `node src/cli.ts` 與真實工具。

### 目錄結構

```
src/
  cli.ts                 指令列入口（只接上 process）
  main.ts                runCli：參數解析與各指令，可在程序內測試
  check.ts               check 的各層與執行順序
  doctor.ts              check 加上環境層
  draft.ts               devguard draft
  scope.ts               [檔案…]、--only、--full 的範圍
  declaration/           宣告檔的解析、比對、套用、檔案歸屬
  standard/              內建的預設標準、版本查找與 standard upgrade
  layers/                check 的各層（宣告、設定、依賴、版本、鏡像、VS Code、Claude Code、程式碼、測試、弱點）
  settings/              各語言工具設定檔的設定檢查（Python、Go、Java、TypeScript）與寬鬆／嚴格判定
  code/                  各語言的 lint、格式、型別檢查
  testing/               各語言的測試與覆蓋率
  vuln/                  各語言的弱點掃描
  deps/                  依賴規則：lockfile 與禁用清單
  versions/              版本範圍、鎖定的工具版本、pre-commit rev
  mirrors/               專案層級的鏡像設定（uv、npm、Maven、Gradle）
  environment/           只有 doctor 跑的環境檢查
  hooks/                 git 與 Claude Code hook、install、既有 hook 框架
  fix/                   fix 的修改計畫、預覽與套用、fix --code
  vscode/                .vscode/ 的 settings、extensions、tasks
  claude/                .claude/ 的 hooks、rules 與 /standards-doctor
  tools/                 執行專案鎖定的工具（uv run、node_modules/.bin、go tool、mvnw / gradlew）
  process/               啟動外部程序（.cmd 透過 cmd.exe）
  repo/                  repo 的檔案清單、元件歸屬與路徑工具
  report/                finding 型別、各種報告格式、exit code、帳密遮蔽
  xml/                   XML 解析（含行號，不讀外部 DTD）
test/                    Vitest 測試
scripts/                 exe 打包、smoke test、T2 探測
assets/                  exe 圖示
SPEC.md                  實作規格
GLOSSARY.md              用語定義
.scratch/                規劃過程：地圖、決策票、研究紀錄、原型
```

## 路線圖

依 SPEC 的章節逐步實作：

- [x] 專案宣告的解析與檢查（§4、§5.5、§11）
- [x] 偵測各工具的設定檔、設定檢查與依既有設定產生宣告草稿（§4.3、§6、§8）
- [x] 程式碼檢查、測試與覆蓋率、依賴規則、弱點掃描（§5.3、§5.4、§6、§7.1）
- [x] `devguard install` 與 `fix` / `fix --code`（§9）
- [x] git hook：pre-commit、pre-push、既有 hook 框架（§7.4）
- [x] Claude Code：`.claude/` 的 rules、hooks 與 `/standards-doctor`（§7.3）
- [x] VS Code：`.vscode/` 的 extensions、settings、tasks（§7.2）
- [x] `devguard doctor`、內部鏡像與帳密檢查（§10）
- [x] `devguard standard upgrade`（§5.5）
- [ ] Bun 打包單一 exe 與 smoke test（§3.1，#27：Bun 尚未在實機上建置驗證）
- [ ] 簽章與內部 Scoop bucket 發佈（§3.1，#28）

### 已知限制

- 弱點掃描：pnpm / yarn、Poetry 與 Gradle 元件尚未支援，掃描時只給提示。
- 多數 checker 與 fixer 只以工具的範例輸出測試過（ESLint、Prettier、tsc 與 Vitest 有真實執行）。

導入前需要團隊或 IT 確認的事項見 SPEC §12，實作初期要實機測試的項目見 SPEC §13。
