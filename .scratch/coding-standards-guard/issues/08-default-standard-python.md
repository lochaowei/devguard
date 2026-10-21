# 預設標準：Python

Type: grilling
Status: resolved
Blocked by: 03, 07

## Question

Python 的預設標準是什麼？決定工具選型與各項門檻：lint/format 規則集、complexity 上限、coverage 門檻、型別檢查嚴格度、dependency 規則（lockfile、禁用清單、弱點掃描工具），以專案宣告格式寫下。

## Answer

Python 預設標準（`team@1.0.0` 草案）。「類型」欄表示判斷「哪個方向算更嚴格」的方式，定義見[專案宣告格式](07-project-declaration-format.md)。

| 標準項目 | 預設值 | 類型 | 落地方式 |
|---|---|---|---|
| `python.minVersion` | `3.11`（專案的 `requires-python` 較高時以專案為準） | 下限 | Ruff `target-version`、mypy `python_version` |
| `lint.tool` | `ruff`（lint 與 format 都用 Ruff，不用 black / isort / flake8） | 工具選擇 | `pyproject.toml [tool.ruff]` |
| `lint.rules` | `E, W, F, I, B, UP, C90, SIM, N, S, TID`；測試檔放寬 `S101` | 禁用清單同類（移除規則組算放寬，新增算收緊） | `[tool.ruff.lint] select`、`per-file-ignores` |
| `format.lineLength` | `120` | **風格** | Ruff `line-length` |
| `complexity.cyclomatic` | `10` | 上限 | Ruff C901 `max-complexity` |
| `complexity.cognitive` | 不適用（Ruff 不支援） | — | — |
| `typecheck.tool` | `mypy`；允許替代工具 `pyright` | 工具選擇 | `[tool.mypy]` / `[tool.pyright]` |
| `typecheck.strict` | `true` | 布林 | mypy `strict = true` / pyright `typeCheckingMode = "strict"` |
| `test.tool` | `pytest` + `pytest-cov` | 工具選擇 | — |
| `coverage.lines` | `80`（`branch = true`，總覆蓋率包含行與分支） | 下限 | `[tool.coverage.report] fail_under`、`[tool.coverage.run] branch` |
| `deps.manager` | `uv`；允許替代工具 `poetry` | 工具選擇 | — |
| `deps.lockfile` | `true`：`uv.lock`（或 `poetry.lock`）必須提交；只有不帶 hash 的 `requirements.txt` 不算 | 布林 | CLI 檢查 |
| `deps.vulnScan` | `false`（進階項目，預設關閉） | 布林 | 開啟後才套用以下兩項 |
| `deps.vulnFailOn` | 任何等級（pip-audit 無法設門檻） | 嚴重度 | `uv export` 後執行 `pip-audit` |
| `deps.ignoredVulns` | 空；每一項都要有 `reason` 與 `until`，比照偏離處理 | 新增項目算放寬 | CLI 轉成 `--ignore-vuln` |
| `deps.banned` | `pycrypto`、`nose` | 禁用清單 | CLI 檢查 `pyproject.toml` 的依賴 |
| `deps.bannedApis` | 空（機制先準備好） | 禁用清單 | Ruff TID251 `banned-api` |

**對宣告模型的補充**：新增「**風格**」類型，用於行寬、引號這類沒有嚴格或寬鬆之分的項目。風格項目可以直接覆寫，不需要理由，也不算偏離，報告中只顯示為「與預設不同」。若同一個 repo 中同語言的元件之間風格不一致，CLI 會提示。

### 修訂（2026-10-22，來自[預設標準：Java](11-default-standard-java.md)）

公司環境不允許下載外部檔案，因此弱點掃描改為**進階項目，預設關閉**（`deps.vulnScan: false`）。專案自行開啟算收緊，不需要寫理由。上表中 `deps.vulnFailOn` 與 `deps.ignoredVulns` 只在開啟後才套用。所有工具與依賴都只能透過公司內部鏡像取得。

### 修訂（2026-10-22，SPEC 查證後的決定 D1）

`coverage.lines` 改由 CLI 解析 `coverage json` 的結果，行覆蓋率與分支覆蓋率各自都要達到 80%，不使用 `fail_under`（它在 branch 模式下檢查的是兩者合併的總數）。
