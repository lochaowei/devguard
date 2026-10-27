# 專案宣告（`.devguard.yaml`）

每個專案在 repo 根目錄放置一份 `.devguard.yaml` 作為**專案宣告（Project Declaration）**。專案實際生效的標準為：

> **專案的標準 = 預設標準（如 `team@1.0.0`）+ 專案宣告中的覆寫（`overrides`）**

---

## 基本結構

```yaml
standard: team@1.0.0            # 必填：繼承的預設標準確切版本
components:                     # 元件清單（目錄 + 語言）
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
      coverage.lines:                       # 放寬：必須附理由，可加到期日
        value: 60
        reason: "舊程式碼補測試中，2027 Q1 回到 80"
        until: 2027-03-31
mirrors:
  auth: env                     # none（預設）| env
ignore:                         # 選填：排除的目錄、檔案或 glob
  - examples/
  - third_party/
  - "**/*.pb.go"
```

---

## 元件（Component）與檔案歸屬

1. **元件定義**：一個元件由 `path`（相對於 repo 根目錄的目錄路徑）與 `language`（`python`、`go`、`typescript`、`java`）組成。同一目錄若有多種語言，可宣告為多個元件。
2. **最長路徑前綴匹配**：repo 內的每個程式檔（`.py`、`.go`、`.ts`/`.tsx`/`.mts`/`.cts`、`.java`）歸屬於**路徑前綴最長、且語言與副檔名相符**的元件。
3. **未涵蓋檔案（Uncovered Files）**：若 repo 中存在上述四種語言的程式檔，但沒有任何相符語言的元件涵蓋該路徑：
   - 依副檔名推定語言，直接套用該語言的**預設標準**（不含任何元件覆寫）。
   - `check` 會發出 `declaration/uncovered-files` **提示（hint）**，建議在 `.devguard.yaml` 的 `components` 中補上對應元件。
   - 範例、第三方嵌入的原始碼、自動產生的檔案等不該套用標準的檔案，改寫進 `ignore`（見下節）。

---

## 排除路徑（`ignore`）

頂層的 `ignore` 是字串清單，列出不屬於任何元件、也不受檢查的路徑：

| 寫法 | 符合 |
|---|---|
| 一般路徑，如 `examples`、`examples/`、`scripts/gen.ts` | 該檔案，或該目錄底下的所有檔案（`examples` 不會符合 `examples-extra/`） |
| glob，如 `**/*.pb.go`、`tools/*/fixture.py` | 符合的路徑，或符合的目錄底下的所有檔案。`*`、`?` 不跨越 `/`，`**` 可跨越多層目錄 |

路徑一律相對於 repo 根目錄，用 `/` 分隔，開頭的 `./` 會被忽略。

被排除的檔案：

- 不會觸發 `declaration/uncovered-files` 提示。
- 不會交給 `check`、`fix --code` 與各 hook 以檔案為單位的檢查（程式碼檢查），即使在命令列上指定或已 staged 也一樣。

`ignore` 不影響的範圍：

- 測試與弱點掃描以元件為單位：每個宣告的元件照常執行，`check --full` 仍是完整的檢查。`ignore` 的某一項涵蓋整個元件目錄時，`check` 發出 `declaration/ignored-component` **提示**，說明這個元件的檔案檢查都會略過。
- 以整個目錄為單位執行的工具（元件的 `eslint .`、`tsc`、`mypy` 等）與覆蓋率工具（Vitest / Jest 的 `coverage.include`、coverage.py、JaCoCo）依各自的設定決定範圍；元件目錄內要排除的檔案，也要在該工具的設定中排除。

`ignore` 不是非空字串的清單時（例如寫成單一字串、對應表，或含有數字、空字串），回報 `declaration/invalid` **錯誤**，整份清單不生效。

---

## 標準項目類型與覆寫規則

`devguard` 將標準項目分為 **9 種內部類型**（定義於 [`src/standard/types.ts`](../../src/standard/types.ts) 與 [`src/declaration/compare.ts`](../../src/declaration/compare.ts)），用來自動判定覆寫屬於「收緊」、「替代」、「風格變更」或「放寬（偏離）」：

| 類型（`kind`） | 說明與更嚴格的方向 | 代表項目 |
|---|---|---|
| `max`（上限） | 數值越小越嚴格；放大算放寬 | `complexity.cyclomatic`、`complexity.cognitive` |
| `min`（下限） | 數值越大越嚴格；縮小算放寬 | `coverage.lines` |
| `minVersion`（最低版本） | 版本號越高越嚴格；降低算放寬 | `python.minVersion`、`go.minVersion`、`node.minVersion`、`java.minVersion`、`claude.minVersion` |
| `bool`（布林） | `true` 比 `false` 嚴格；把預設 `true` 改為 `false` 算放寬 | `typecheck.strict`、`deps.lockfile`、`deps.vulnScan` |
| `severity`（嚴重度門檻） | `any` < `low` < `moderate` < `high` < `critical`；門檻拉高算放寬 | `deps.vulnFailOn` |
| `list`（規則集 / 禁用清單） | 新增項目算收緊；移除預設項目算放寬 | `lint.rules`、`deps.banned`、`deps.bannedApis`、`typecheck.options` |
| `choice`（工具選擇） | 改用 `allowed` 清單內的工具算合法替代；改用清單外的工具算放寬 | `lint.tool`、`typecheck.tool`、`test.tool`、`deps.manager`、`build.tool` |
| `versionRange`（版本範圍） | 範圍落在預設範圍內算收緊或相同；超出預設上下界算放寬 | `tools.ruff`、`tools.eslint`、`tools.golangci-lint` 等 |
| `style`（風格項目） | 無嚴格或寬鬆之分，可直接寫值，不算偏離 | `format.*`、`mirrors.auth` |
| 鏡像網址 | 改成預設鏡像同一台主機上的其他 repository 視同風格；改成其他主機算放寬（必須寫理由） | `mirrors.pypi` / `npm` / `go` / `maven` 等 |

此外，`ignoredVulns`（`deps.ignoredVulns`）中的每一筆忽略弱點都必須寫明 `{ id, reason, until }`，比照偏離與到期日規則檢查。

### 偏離（Deviation）與錯誤判定

- **可以直接寫值的情況**：
  - 比預設標準更嚴格（收緊）
  - 改用 `allowed` 允許清單內的替代工具
  - 修改 `style` 風格項目
- **必須寫 `{ value, reason, until? }` 的情況（放寬 / 偏離）**：
  - 有填寫具體 `reason`（且未過期）：報告標記為 **偏離（deviation）**，一般 `check` 視為通過（exit `0`），加 `--strict` 時視為失敗（exit `1`）。
  - 未附 `reason`，或 `reason` 含 `TODO`：回報 **錯誤（error）**（`declaration/looser-without-reason`、`declaration/todo-reason`）。
  - 已超過 `until`（`YYYY-MM-DD`）：回報 **錯誤（error）**（`declaration/deviation-expired`）。
- **其他宣告錯誤與提示**：
  - 找不到 `.devguard.yaml`：`declaration/missing`（錯誤，提示執行 `devguard draft`）
  - 標準版本格式錯誤、未知、比 CLI 新、已移除或已過棄用截止日：`declaration/standard-*`（錯誤）
  - 覆寫未知項目、型別不符、重複宣告相同（路徑 + 語言）元件：`declaration/unknown-item`、`declaration/invalid-type`、`declaration/duplicate-component`（錯誤）
  - 同一 repo 內相同語言的多個元件設定了不一致的風格項目：`declaration/inconsistent-style`（提示）

---

## 從既有專案自動產生草稿：`devguard draft`

若既有專案尚未建立 `.devguard.yaml`，可執行：

```bash
devguard draft [--cwd <dir>] [--ignore <路徑或 glob>]…
```

### 運作流程

1. **偵測元件**：掃描 repo 中的 `.py`、`.go`、`.ts`、`.java` 檔案，將每個檔案歸屬於最近一層含有該語言建置或工具設定檔的目錄：
   - **Python**：`pyproject.toml`、`setup.py`、`setup.cfg`、`requirements.txt`
   - **Go**：`go.mod`
   - **TypeScript**：`package.json`、`tsconfig.json`
   - **Java**：`pom.xml`、`build.gradle`、`build.gradle.kts`、`settings.gradle`、`settings.gradle.kts`（Java 多模組建置會合併歸屬於最外層的建置檔目錄）
   - 符合 `--ignore` 的檔案不參與偵測，清單原樣寫進草稿的 `ignore`。
2. **推導覆寫（`overrides`）**：對每個偵測到的元件執行設定檢查層，讀取既有工具設定檔中的實際值（`observed`）：
   - 與預設標準相同的值：省略不寫。
   - 比預設嚴格、允許的替代工具、風格項目：直接寫入值。
   - 比預設寬鬆的值：寫為 `{ value, reason: "TODO: 說明放寬理由" }`。
3. **保護既有宣告**：若 `.devguard.yaml` 已存在，`devguard draft` **絕不覆寫**，會印出錯誤並以 exit code `2` 結束。
4. **後續步驟**：人工檢視 `.devguard.yaml` 的元件清單，將所有 `TODO` 理由替換為真實原因（並視需要加上 `until`），再執行 `devguard check` 驗證。
