# `devguard draft`

專案還沒有 `.devguard.yaml` 時，依偵測到的元件與既有的工具設定產生一份宣告草稿。導入既有專案的第一步。

草稿只是起點：產生後要確認元件切分是否正確、填寫所有 `TODO` 理由，再執行 [`check`](Command-check.md)。

---

## 用法

```text
devguard draft [--cwd <dir>] [--ignore <路徑或 glob>]…
```

| 旗標 | 作用 |
|---|---|
| `--cwd <dir>` | 專案根目錄，預設為目前目錄 |
| `--ignore <路徑或 glob>` | 可重複指定。符合的檔案不用來推斷元件，清單原樣寫進草稿的 [`ignore`](Project-Declaration.md#排除路徑ignore)，之後的 `check` 也不檢查這些檔案 |

`.devguard.yaml` 已經存在時**不會覆寫**，以 exit `2` 結束：

```text
$ devguard draft
.devguard.yaml 已存在，不會覆寫；要重新產生草稿請先移除它
```

---

## 執行流程

1. **列出 repo 的檔案**：`git ls-files --cached --others --exclude-standard`，也就是已追蹤加上未被忽略的未追蹤檔，再去掉符合 `--ignore` 的檔案。
2. **推斷元件**：每個四語言的程式檔，歸屬到往上找最近、含有該語言標記檔的目錄。

   | 語言 | 標記檔 |
   |---|---|
   | Python | `pyproject.toml`、`setup.py`、`setup.cfg`、`requirements.txt` |
   | Go | `go.mod` |
   | TypeScript | `package.json`、`tsconfig.json` |
   | Java | `pom.xml`、`build.gradle(.kts)`、`settings.gradle(.kts)` |

   Java 的多模組建置以**最外層**的建置檔為一個元件，其他語言以**最近**的為準。Python 有一個例外（#106）：只有 `requirements.txt`、又位於另一個 Python 元件之內的目錄（例如給 Read the Docs 用的 `docs/requirements.txt`）不另成元件，檔案歸屬上層元件，草稿在上層元件上方加一行註解 `# docs/ 只有 requirements.txt，歸屬 ./ 元件，未另建元件`。

   下列檔案不成為元件，改寫進草稿的 `ignore`（排在 `--ignore` 的項目之後），每項上方有一行註解說明原因：

   - **不在 `go.work` 中的 Go 模組**：`go.mod` 的目錄或上層有 `go.work`，但不在它的 `use` 清單中（常見的是測試資料裡讓 go 工具略過目錄的哨兵 `go.mod`）。golangci-lint 在 workspace 模式下無法檢查這種模組。註解：`# 不在 go.work 的 use 清單中`。和 `go` 一樣，被 git 忽略的 `go.work`、或在 repo 根目錄之上的 `go.work` 也算。repo 根目錄的模組，以及底下有 `use` 清單中模組的目錄，照舊是元件。沒有 `go.work` 的 repo，每個 `go.mod` 都是一個元件。
   - **零星的程式檔**：往上找不到該語言的標記檔，而 repo 已經有其他有標記檔的元件，例如 Go 專案測試資料裡的 `.py`、Java 專案根目錄的一支腳本。同一目錄、同副檔名有多個時寫成 `<目錄>/*.<副檔名>`。註解：`# 沒有 Python 的標記檔，未建立元件；若要檢查，請補上標記檔並新增元件`。

   整個 repo 都沒有任何標記檔時（例如純腳本 repo），零星的程式檔照舊成為 repo 根目錄的元件。

3. **推斷非預設的工具選擇**：依元件目錄往上找到的檔案判斷。

   | 語言 | 項目 | 判斷 |
   |---|---|---|
   | Python | `deps.manager: poetry` | 有 `poetry.lock`（比 `uv.lock` 近） |
   | Python | `typecheck.tool: pyright` | 有 `pyrightconfig.json`，且它不是 `typeCheckingMode = "off"` |
   | Python | `typecheck.tool: basedpyright` | 元件的 `pyproject.toml` 有 `[tool.basedpyright]`，且它不是 `typeCheckingMode = "off"`（優先於上一列；同一目錄的 `pyrightconfig.json` 設為 off 時，pyright 以它為準，這個表也不算） |
   | TypeScript | `lint.tool: biome` | 有 `biome.json(c)`（比 `eslint.config.*` 近） |
   | TypeScript | `test.tool: jest` | 有 `jest.config.*`（比 `vitest.config.*` 近） |
   | TypeScript | `deps.manager: pnpm` / `yarn` | 有 `pnpm-lock.yaml` / `yarn.lock`（比 `package-lock.json` 近） |
   | Java | `build.tool: gradle` | 元件目錄只有 Gradle 建置檔（`build.gradle(.kts)`、`settings.gradle(.kts)`）沒有 `pom.xml`；兩者都有時，只提交了 `gradlew`（元件目錄或上層）而沒有 `mvnw` |

   Java 元件同時有 `pom.xml` 與 Gradle 建置檔，而 wrapper 無法區分（兩種都有或都沒有）時，預設為 maven，並在草稿的該元件上方加註解 `# 同時有 pom.xml 與 build.gradle，預設為 maven，請確認 build.tool`。

4. **讀取既有設定的值**：重用各語言設定檢查層的讀取邏輯，與預設標準比較：
   - 與預設相同：省略。
   - 比預設嚴格，或只是風格不同（例如行寬）：直接寫成覆寫值。
   - 比預設寬鬆：寫成 `{value, reason}`，`reason` 是 `TODO: 由 <檔案> 推得，請填寫放寬理由`。
5. **寫入** `.devguard.yaml`，檔頭附上說明註解；有 `--ignore` 或步驟 2 排除的檔案時，在最後加上 `ignore` 清單。寫入時用「檔案不存在才建立」的模式，同時執行兩次也不會互相覆蓋。

標準一律使用這個 CLI 內建的最新 `team` 版本，不會寫入既有專案的基線標準 `legacy@1.0.0`；要用它時自行改寫 `standard`（見[各語言預設標準](Language-Standards.md)）。

---

## 輸出與 exit code

| Exit code | 情況 |
|---|---|
| `0` | 已產生草稿：`已產生宣告草稿 <路徑>（N 個元件）` |
| `2` | `.devguard.yaml` 已存在，或其他 CLI 失敗 |

---

## 範例

一個 repo 根目錄有 `requirements.txt` 與幾支 Python 腳本、`api/` 是 Poetry 專案、`web/` 是 pnpm + Biome 的 TypeScript 專案：

```text
$ devguard draft
已產生宣告草稿 C:\work\mixed\.devguard.yaml（3 個元件）
請確認元件並填寫所有 TODO 理由，再執行 devguard check
```

```yaml
# 由 devguard draft 依既有的工具設定產生的草稿（SPEC §4.3）。
# 與預設標準相同的項目已省略；比預設寬鬆的項目附有 TODO 理由，填寫理由之前 devguard check 不會通過。
standard: team@1.4.0
components:
  - path: ./
    language: python
  - path: api/
    language: python
    overrides:
      deps.manager: poetry
      complexity.cyclomatic:
        value: 20
        reason: "TODO: 由 api/pyproject.toml 推得，請填寫放寬理由"
      format.lineLength: 200
  - path: web/
    language: typescript
    overrides:
      lint.tool: biome
      deps.manager: pnpm
```

- `api/pyproject.toml` 的 `max-complexity = 20` 比預設的 10 寬鬆，所以附上 TODO 理由。
- `line-length = 200` 屬於風格項目，直接寫成覆寫值。

`TODO` 理由沒有填寫之前，`check` 與 `doctor` 會回報錯誤：

```text
  錯誤  循環複雜度上限：10 → 20：理由仍是 TODO，請填寫  [declaration/todo-reason] .devguard.yaml:11
```

---

## 常見錯誤與排解

| 現象 | 原因與處理 |
|---|---|
| 多出不該有的元件（例如來自 `node_modules/`、`.venv/`） | 檔案清單只排除 git 忽略的檔案。先把依賴目錄加進 `.gitignore`，刪掉草稿重新產生 |
| repo 根目錄出現一個意外的元件 | repo 沒有任何標記檔，零散的腳本歸屬 repo 根目錄。可以保留，或把這些檔案寫進 `ignore`。只從宣告中刪除元件不會排除檔案：它們會變成未涵蓋檔案，仍依預設標準檢查 |
| 草稿的 `ignore` 有我想檢查的檔案 | 這些檔案沒有標記檔，或模組不在 `go.work` 中。補上標記檔（或把模組加進 `go.work`）後，刪掉該項並新增元件 |
| 範例、第三方原始碼或自動產生的檔案變成元件 | 刪掉草稿，以 `--ignore examples/ --ignore third_party/` 重新產生；或直接把這些路徑寫進宣告的 `ignore` |
| 想重新產生 | 先刪除或改名 `.devguard.yaml` 再執行 |
| Poetry 專案的 `check` 提示 `找不到 ruff：專案環境（<專案>/.venv）中沒有安裝` | devguard 從專案內的 `.venv` 執行工具。照提示執行 `poetry config virtualenvs.in-project true && poetry install`，讓 Poetry 把虛擬環境建在專案裡 |
| uv 專案的 `check` 提示 `找不到 ruff：專案環境（…）中沒有安裝`，但工具其實已安裝 | 括號內是 devguard 找過的專案環境路徑。專案環境不在 `.venv` 時，以 `UV_PROJECT_ENVIRONMENT` 指定它（與 `uv run` 讀同一個變數），再執行 `devguard check` |

---

## 相關頁面

- [專案宣告](Project-Declaration.md)：宣告的格式、覆寫與偏離規則
- [`install`](Command-install.md)：宣告確認後的下一步
- [快速開始](Quick-Start.md)
- 規格：[SPEC §4.1、§4.3](../../SPEC.md)
- 實作：[`src/draft.ts`](../../src/draft.ts)
