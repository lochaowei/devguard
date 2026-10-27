# `devguard standard upgrade`

把 `.devguard.yaml` 宣告的預設標準升級到這個 CLI 內建的較新版本。預設只預覽升級對專案的影響；加上 `--apply` 才修改宣告與設定檔，並透過內部鏡像執行套件管理指令。

CLI 內建了宣告標準的較新 minor / patch 版本時，[`doctor`](Command-doctor.md) 會提示執行這個指令；`check` 不會提示。從基線標準 `legacy@1.0.0` 升到 `team@1.1.0` 會收緊標準，`doctor` 不會提示，要自行決定時機。

---

## 用法與旗標

```text
devguard standard upgrade [目標版本] [--apply] [--cwd <dir>]
```

| 參數 / 旗標 | 作用 |
|---|---|
| `[目標版本]` | 例如 `team@1.1.0`。省略時使用 CLI 內建、同一個標準的最新版本；宣告 `legacy@1.0.0` 時是 `team@1.1.0` |
| `--apply` | 實際套用。沒有加就只預覽 |

`devguard standard`、`devguard standard foo` 或多給參數，會以 exit `2` 結束：`用法：devguard standard upgrade [目標版本] [--apply]`。

---

## 執行流程

1. **決定目標版本**
   - 沒有 `.devguard.yaml` → `找不到 .devguard.yaml，無法升級標準`，exit `2`。
   - 宣告無法解析 → `.devguard.yaml 無法解析，請先執行 devguard check`，exit `2`。
   - CLI 沒有內建目標版本 → `這個 devguard 沒有內建「…」`，exit `2`。
   - 已經是最新，或目標是同一個標準、但不比目前新 → 印出說明，exit `0`。
   - 目標是另一個標準，而且不在升級路徑上 → `無法從 … 升級到 …`（有可升級的版本時接著列出），exit `2`。升級路徑只有 `legacy` → `team`：`legacy@1.0.0` 可以升到 `team@1.1.0` 及更新的 `team`，`team` 不會升到 `legacy`。
2. **比較兩個版本對專案的影響**：分別以目前與目標標準執行宣告層與設定檢查層，比較結果。
3. **印出預覽**，分成以下幾段：

   | 段落 | 內容 |
   |---|---|
   | 標準項目的差異 | 兩個版本中預設值不同、新增、移除的項目 |
   | 多餘的覆寫 | 宣告中的覆寫在新標準下已經等於預設值，或項目已被移除；`--apply` 會從宣告中刪除 |
   | 新的錯誤或偏離 | 專案在新標準下才會出現的錯誤與偏離；可以自動修正的會標示 `（--apply 會修正）` |
   | 需要調整的工具版本 | lockfile 鎖定的版本不在新範圍內，或 PATH 上工具（例如 `golangci-lint`）的範圍改變 |
   | 需要執行的套件管理指令 | 見下表 |
   | 要修改的檔案 | `.devguard.yaml` 的 `standard` 欄位、刪除多餘的覆寫，以及設定檔的修補（diff 格式與 `fix` 相同） |

4. **`--apply`**：先寫入檔案，再依序執行套件管理指令。

套件管理指令：

| 語言 | 指令 | 鏡像 |
|---|---|---|
| Python（uv） | `uv add --dev "<套件><範圍>"` | `mirrors.pypi`（以 `UV_DEFAULT_INDEX` 帶入） |
| Python（Poetry，最近的 lockfile 是 `poetry.lock`） | `poetry add --group dev "<套件><範圍>"`（PEP 508 形式，例如 `"ruff>=0.18,<0.19"`）；找不到 `poetry` 時提示 `scoop install poetry`，不改用 uv | `pyproject.toml` 的 `[[tool.poetry.source]]`（不另外設定環境變數；預覽顯示 `（鏡像：<元件>/pyproject.toml 的 [[tool.poetry.source]] nexus）`） |
| TypeScript | `npm install --save-dev <套件>@<範圍>` | `mirrors.npm` |
| Go | `go get -tool <模組>@v<範圍下限>`（`go get` 只接受單一版本） | `mirrors.go`，並設定 `mirrors.gosumdb` |
| Java、PATH 上的工具 | **不執行**，只印出要手動修改的地方，標示 `（請自行執行）` | — |

同一個元件的多個套件合併成一條指令，在元件目錄中執行。預覽中 Python 指令含 `>`、`<`、`,` 或空白的引數加上雙引號，可以直接貼到 shell 執行；npm 與 go 的指令照原樣印出。

---

## 輸出與 exit code

| Exit code | 情況 |
|---|---|
| `0` | 不需要升級；或 `--apply` 全部完成；或預覽中沒有任何要寫入的檔案或要執行的指令 |
| `1` | **只預覽而且有變更待套用**：最後印出 `只預覽，沒有套用。加上 --apply 才會套用。`。預覽不會詢問，在互動式終端機也一樣 |
| `2` | 上述無法規劃升級的情況（包括目標不在升級路徑上）；或 `--apply` 時套件管理指令失敗（`套件管理指令失敗：…`） |

`--apply` 會先寫入檔案再執行指令。指令失敗時，已寫入的 `.devguard.yaml` 與設定檔**不會還原**，請用 git 檢查並決定要重跑還是還原。

---

## 範例

目前 CLI 內建 `team@1.0.0`、`team@1.1.0` 與 `legacy@1.0.0`。宣告 `team@1.0.0` 的 TypeScript 專案升級時（`doctor` 也會以 `standard/upgrade-available` 提示建議這個指令）：

```text
$ devguard standard upgrade
標準升級預覽：team@1.0.0 → team@1.1.0

標準項目的差異：
  TypeScript｜eslint-plugin-sonarjs 版本範圍：">=3,<4"（移除）
  TypeScript｜vitest 版本範圍：">=5,<6" → ">=4.1,<6"

對本專案的影響：
多餘的覆寫（--apply 會從宣告中刪除）：
  無
…
要修改的檔案：
.devguard.yaml：修改 CLI 管理的設定
+standard: team@1.1.0
-standard: team@1.0.0
…
只預覽，沒有套用。加上 --apply 才會套用。
$ echo $?
1
```

宣告中覆寫了 `tools.eslint-plugin-sonarjs` 時，這個覆寫會列在「多餘的覆寫」（`（新標準已移除這個項目）`），`--apply` 會把它刪除。已經是最新版本，或指定的版本不存在時：

```text
$ devguard standard upgrade
已經是這個 devguard 內建的最新標準 team@1.1.0

$ devguard standard upgrade team@9.0.0
這個 devguard 沒有內建「team@9.0.0」
$ echo $?
2
```

宣告基線標準 `legacy@1.0.0` 的專案，升級目標是 `team@1.1.0`。預覽會列出收緊的項目，以及專案因此新出現的錯誤：

```text
$ devguard standard upgrade
標準升級預覽：legacy@1.0.0 → team@1.1.0

標準項目的差異：
  TypeScript｜tsconfig strict：false → true
  TypeScript｜額外的 tsconfig 檢查：[] → ["noUncheckedIndexedAccess", "noImplicitOverride", "noFallthroughCasesInSwitch"]
  TypeScript｜循環複雜度上限：20 → 10
  TypeScript｜認知複雜度上限：25 → 15
  TypeScript｜覆蓋率門檻 (%)：0 → 80
  TypeScript｜禁用套件：["request"] → ["moment", "request", "node-fetch"]

對本專案的影響：
多餘的覆寫（--apply 會從宣告中刪除）：
  無

新的錯誤或偏離：
  錯誤｜./ (TypeScript)｜找不到 Vitest 設定檔（覆蓋率門檻設在 coverage.thresholds）
…

$ devguard standard upgrade team@1.0.0
無法從 legacy@1.0.0 升級到 team@1.0.0；可以升級到 team@1.1.0
$ echo $?
2
```

預覽的格式（各段落的標題，內容依專案而定）：

```text
標準升級預覽：team@1.0.0 → team@1.1.0

標準項目的差異：
  …
對本專案的影響：
多餘的覆寫（--apply 會從宣告中刪除）：
  無
新的錯誤或偏離：
  …
需要調整的工具版本：
  …
需要執行的套件管理指令（--apply 會透過內部鏡像執行）：
  …
要修改的檔案：
…
```

---

## 常見錯誤與排解

| 現象 | 原因與處理 |
|---|---|
| CI 中跑預覽得到 exit `1` | 有變更待套用時預覽固定回傳 `1`（SPEC §11），可以用來偵測「需要升級」 |
| `套件管理指令失敗：…` | 通常是鏡像連不上或帳密缺少。先跑 `devguard doctor` 檢查 `mirrors/credentials-missing`；檔案已經寫入，修好後可以直接執行印出的指令 |
| Java 的外掛版本沒有被更新 | 建置檔屬於 `snippet`，不會自動修改。照預覽中的 `（請自行執行）` 修改 `pom.xml` / `build.gradle` |

---

## 相關頁面

- [`doctor`](Command-doctor.md)：提示有可用的升級
- [各語言預設標準](Language-Standards.md)：目前標準的內容
- [專案宣告](Project-Declaration.md)：覆寫與偏離
- 規格：[SPEC §5.5](../../SPEC.md)
- 實作：[`src/standard/upgrade-run.ts`](../../src/standard/upgrade-run.ts)、[`src/standard/upgrade.ts`](../../src/standard/upgrade.ts)
