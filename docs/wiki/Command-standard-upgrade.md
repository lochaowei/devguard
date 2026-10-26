# `devguard standard upgrade`

把 `.devguard.yaml` 宣告的預設標準升級到這個 CLI 內建的較新版本。預設只預覽升級對專案的影響；加上 `--apply` 才修改宣告與設定檔，並透過內部鏡像執行套件管理指令。

CLI 內建了宣告標準的較新 minor / patch 版本時，[`doctor`](Command-doctor.md) 會提示執行這個指令；`check` 不會提示。

---

## 用法與旗標

```text
devguard standard upgrade [目標版本] [--apply] [--cwd <dir>]
```

| 參數 / 旗標 | 作用 |
|---|---|
| `[目標版本]` | 例如 `team@1.1.0`。省略時使用 CLI 內建、比目前新的版本中的第一個 |
| `--apply` | 實際套用。沒有加就只預覽 |

`devguard standard`、`devguard standard foo` 或多給參數，會以 exit `2` 結束：`用法：devguard standard upgrade [目標版本] [--apply]`。

---

## 執行流程

1. **決定目標版本**
   - 沒有 `.devguard.yaml` → `找不到 .devguard.yaml，無法升級標準`，exit `2`。
   - 宣告無法解析 → `.devguard.yaml 無法解析，請先執行 devguard check`，exit `2`。
   - CLI 沒有內建目標版本 → `這個 devguard 沒有內建「…」`，exit `2`。
   - 已經是最新，或目標不比目前新 → 印出說明，exit `0`。
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
| Python（uv） | `uv add --dev <套件><範圍>` | `mirrors.pypi`（以 `UV_DEFAULT_INDEX` 帶入） |
| Python（Poetry，最近的 lockfile 是 `poetry.lock`） | `poetry add --group dev <套件>@<範圍>`；找不到 `poetry` 時提示 `scoop install poetry`，不改用 uv | `pyproject.toml` 的 `[[tool.poetry.source]]`（不另外設定環境變數） |
| TypeScript | `npm install --save-dev <套件>@<範圍>` | `mirrors.npm` |
| Go | `go get -tool <模組>@v<範圍下限>`（`go get` 只接受單一版本） | `mirrors.go`，並設定 `mirrors.gosumdb` |
| Java、PATH 上的工具 | **不執行**，只印出要手動修改的地方，標示 `（請自行執行）` | — |

同一個元件的多個套件合併成一條指令，在元件目錄中執行。

---

## 輸出與 exit code

| Exit code | 情況 |
|---|---|
| `0` | 不需要升級；或 `--apply` 全部完成；或預覽中沒有任何要寫入的檔案或要執行的指令 |
| `1` | **只預覽而且有變更待套用**：最後印出 `只預覽，沒有套用。加上 --apply 才會套用。`。預覽不會詢問，在互動式終端機也一樣 |
| `2` | 上述無法規劃升級的情況；或 `--apply` 時套件管理指令失敗（`套件管理指令失敗：…`） |

`--apply` 會先寫入檔案再執行指令。指令失敗時，已寫入的 `.devguard.yaml` 與設定檔**不會還原**，請用 git 檢查並決定要重跑還是還原。

---

## 範例

目前 CLI 只內建 `team@1.0.0`，所以實際執行只會看到這兩種結果：

```text
$ devguard standard upgrade
已經是這個 devguard 內建的最新標準 team@1.0.0

$ devguard standard upgrade team@9.0.0
這個 devguard 沒有內建「team@9.0.0」
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
