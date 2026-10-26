# `devguard doctor`

`check` 的設定與程式碼檢查，再加上**本機環境**的檢查：工具是否已安裝、git hook 是否生效、VS Code 擴充套件、Claude Code、鏡像帳密、標準是否有更新。只回報並附上修正方式，不修改任何東西。

適合在新電腦、clone 完專案、或「hook 好像沒有作用」時執行。VS Code 的 `standards: doctor` task 在開啟資料夾時執行 `doctor --quiet`；Claude Code 的 SessionStart hook 與 `/standards-doctor` skill 也是用它。

本頁的範例都以[示範專案](CLI-Reference.md#示範專案)實際執行取得。

---

## 用法與旗標

```text
devguard doctor [--quiet] [--exit-zero] [--format text|json|sarif|vscode|claude] [--strict] [--verbose] [--cwd <dir>]
```

| 旗標 | 作用 |
|---|---|
| `--quiet` | 只輸出錯誤與偏離；沒有問題時什麼都不輸出 |
| `--exit-zero` | 有問題時也以 `0` 結束（給 `/standards-doctor` skill 嵌入結果用） |
| `--format`、`--strict`、`--verbose`、`--cwd` | 與 [`check`](Command-check.md#用法與旗標) 相同 |

`doctor` 不接受檔案，`devguard doctor src/a.ts` 會以 exit `2` 結束：`doctor 不接受檔案`。`--only`、`--full`、`--staged` 對 `doctor` 沒有作用。

---

## 執行流程

1. 執行 `check` 的檢查層，但**不跑測試、覆蓋率與弱點掃描**（`doctor` 不支援 `--full`）。
2. 專案工具沒有安裝時，不像 `check` 一樣以 exit `2` 中止，而是列成一筆 `environment/tool-missing` 錯誤（附安裝指令），繼續跑完其他檢查。同一個工具只報一次。
3. 依序執行 `environment` 層的檢查：

| 順序 | 檢查 | 規則 ID（`environment/…`、`mirrors/…`） | 什麼時候檢查 |
|---|---|---|---|
| 1 | 標準是否有更新：CLI 內建了宣告標準的較新 minor / patch 版本，提示執行 [`standard upgrade`](Command-standard-upgrade.md) | — | 一律 |
| 2 | git hook：`core.hooksPath` 沒有停用 hook 或與框架衝突；hook 檔存在、是 devguard 的、checksum 沒變；或 hook 框架的設定有呼叫 devguard，且 pre-commit 框架已執行 `pre-commit install` | `not-a-git-repo`、`hooks-path-disabled`、`hooks-path-conflict`、`hooks-path-missing`、`hook-missing`、`hook-modified`、`hook-foreign`、`framework-entry-missing`、`framework-not-installed` | 一律 |
| 3 | Claude Code：`claude --version` 達到 `claude.minVersion`；`.git/devguard/claude-last-seen` 存在（SessionStart hook 至少執行過一次） | `claude-version`、`claude-missing`（提示）、`claude-never-ran` | 專案有 devguard 的 Claude Code 設定時 |
| 4 | VS Code 擴充套件：用 `code --list-extensions` 檢查推薦的已安裝、不推薦的沒有安裝 | `vscode-extension-missing`（錯誤）、`vscode-extension-unwanted`（提示）、`vscode-cli-missing`、`vscode-cli-failed` | 宣告有元件時 |
| 5 | Go 的使用者層級鏡像：`go env GOPROXY` 只指向內部鏡像，`GOSUMDB` 透過鏡像且不是 `off` | `go-proxy`、`gosumdb`、`gosumdb-off` | 有 Go 元件時 |
| 6 | 鏡像帳密（`mirrors.auth: env`）：各工具需要的環境變數（例如 uv 的 `UV_INDEX_NEXUS_*`、Poetry 的 `POETRY_HTTP_BASIC_NEXUS_*`）或 netrc / `gradle.properties` 是否存在。**只檢查有沒有，絕不讀取或印出值** | `mirrors/credentials-missing`、`mirrors/netrc-missing` | 宣告 `mirrors.auth: env` 時 |
| 7 | npm audit 是否可用：對 npm 鏡像的 bulk advisory endpoint 送一次請求，不是 200 時提示 | `npm-audit-unavailable`（提示） | 有 TypeScript 元件開啟 `deps.vulnScan` 時 |

這些檢查只檢查本機狀態並給出指令，不會修改使用者層級的設定（例如 `go env -w`）。

---

## 輸出與 exit code

| Exit code | 情況 |
|---|---|
| `0` | 沒有錯誤；或加上 `--exit-zero` |
| `1` | 有錯誤（包括環境錯誤）；或加上 `--strict` 時有偏離 |
| `2` | 用法錯誤或其他 CLI 本身的失敗 |

---

## 範例

```text
$ devguard doctor
標準：team@1.0.0

./ (TypeScript)
  偏離  覆蓋率門檻 (%)：80 → 10｜理由：舊程式碼的測試在 Q1 補齊｜到期：2027-03-31  [declaration/deviation] .devguard.yaml:6
        需手動修正

（整體）
  錯誤  VS Code 沒有安裝推薦的擴充套件 dbaeumer.vscode-eslint（若已安裝但被停用，請在 VS Code 中啟用）  [environment/vscode-extension-missing]
        需手動修正：請從公司內部 marketplace 安裝 dbaeumer.vscode-eslint：https://vsmarketplace.example.internal/items?itemName=dbaeumer.vscode-eslint
  錯誤  VS Code 沒有安裝推薦的擴充套件 esbenp.prettier-vscode（若已安裝但被停用，請在 VS Code 中啟用）  [environment/vscode-extension-missing]
        需手動修正：請從公司內部 marketplace 安裝 esbenp.prettier-vscode：https://vsmarketplace.example.internal/items?itemName=esbenp.prettier-vscode
  錯誤  VS Code 沒有安裝推薦的擴充套件 vitest.explorer（若已安裝但被停用，請在 VS Code 中啟用）  [environment/vscode-extension-missing]
        需手動修正：請從公司內部 marketplace 安裝 vitest.explorer：https://vsmarketplace.example.internal/items?itemName=vitest.explorer

3 個錯誤、1 個偏離、0 個提示
```

hook 被改過或被刪掉：

```text
$ devguard doctor --quiet
…
  錯誤  git pre-push hook（C:\work\demo\.git\hooks\pre-push）被修改過，checksum 不符  [environment/hook-modified]
        需手動修正：devguard install
…
  錯誤  沒有安裝 git pre-commit hook（C:\work\demo\.git\hooks\pre-commit）  [environment/hook-missing]
        需手動修正：devguard install
```

被改過的 hook 用 `devguard fix --yes` 或 `devguard install --yes` 都能恢復；被刪掉的要用 `install`。

---

## 常見錯誤與排解

| 現象 | 原因與處理 |
|---|---|
| `doctor` 通過，push 時卻被覆蓋率擋下 | `doctor` 不跑測試與覆蓋率。用 `devguard check --full` |
| `environment/vscode-extension-missing`，但擴充套件明明有裝 | 檢查只看預設 profile，而且被停用的擴充套件也算已安裝。擴充套件若裝在其他 profile，請裝到預設 profile；也確認 `code` 指令指向你使用的那個 VS Code |
| `environment/claude-never-ran` | 在專案資料夾啟動 Claude Code，並接受「信任此資料夾」的詢問 |
| `mirrors/credentials-missing` | 照訊息設定環境變數。`doctor` 只檢查變數是否存在，不會印出值 |

---

## 相關頁面

- [`check`](Command-check.md)：`doctor` 的前半段
- [`install`](Command-install.md)：修正 hook 與 Claude Code 的問題
- [`hook`](Command-hook.md)：`claude-session-start` 如何使用 `doctor`
- 規格：[SPEC §3.2、§7.3、§7.4、§10.3、§11](../../SPEC.md)
- 實作：[`src/doctor.ts`](../../src/doctor.ts)、[`src/environment/registry.ts`](../../src/environment/registry.ts)（環境檢查順序）、[`src/environment/`](../../src/environment/)
