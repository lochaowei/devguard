# KEI-7：實際專案測試 Round 2 完整測試報告

> [!NOTE]
> 本報告記錄 Linear 議題 **KEI-7（更多的實際專案測試 round 2）** 之測試範圍、18 個真實開源專案的全流程實測數據（`draft` → `check` → `fix --yes` → `check`）、實測揭露的 7 項核心問題根因分析與修復方案，以及最終驗證結果，供後續維護與回歸測試參考。

---

## 1. 測試目標與方法

延續 Round 1（KEI-6 / PR #31），Round 2 聚焦於更高複雜度的真實世界專案型態與全自動修復閉環驗證：

1. **多樣化專案結構覆蓋**：
   - **Monorepo / 多套件工作區**：pnpm workspaces（`colinhacks/zod`、`changesets/changesets`）、Go 多模組（`uber-go/zap`、`charmbracelet/bubbletea`、`prometheus/client_golang`、`stretchr/testify`、`urfave/cli`）、Python 多子專案（`pallets/click`、`Textualize/rich`）、Gradle Kotlin DSL 多模組（`mockito/mockito`）。
   - **Polyglot 跨語言專案**：同時包含 Go 後端與 TypeScript 前端的 `gotify/server`。
   - **多元工具鏈與設定格式**：`uv`、`poetry`、`pnpm`、`yarn`、Biome（`biome.jsonc`）、ESLint Flat Config、Vitest（`.ts` / `.mts` / `.js`）、`.golangci.yml` / `.golangci.yaml`、Maven、Gradle Kotlin DSL。
2. **四階段閉環驗證流程**：
   ```mermaid
   flowchart LR
     A["1. devguard draft"] --> B["2. devguard check (修正前)"]
     B --> C["3. devguard fix --yes"]
     C --> D["4. devguard check (修正後)"]
   ```
   - 驗證 `draft` 推論出的 `.devguard.yaml` 是否正確反映元件結構、工具選擇與既有設定值。
   - 驗證 `check` 在設定檔、依賴鎖定（`deps`）、工具版本（`tool-versions`）與宣告一致性上的準確度（無假陽性或漏報）。
   - 驗證 `fix --yes` 寫入設定檔後是否保留既有註解與排版、不產生多餘重複檔案，且再次執行 `check` 時**所有可自動修正之錯誤（auto-fixable errors）全數歸零**。

---

## 2. 測試專案矩陣與總覽（18 個開源專案）

| # | 專案 (`owner/repo`) | 語言 / 架構 | 工具鏈特徵 | 偵測元件數 | `draft` 耗時 | `fix --yes` 耗時 | 修正後殘留可自動修復錯誤 |
| :-: | :--- | :--- | :--- | :-: | :-: | :-: | :-: |
| 1 | `fastapi/typer` | Python | `uv.lock` + Ruff + mypy | 1 | 67 ms | 26 ms | **0** |
| 2 | `Textualize/rich` | Python (Multi-component) | `poetry.lock` (`./`, `docs/`) + mypy | 2 | 55 ms | 9 ms | **0** |
| 3 | `encode/starlette` | Python | `uv.lock` + `[tool.ruff.lint]`（無 `[tool.ruff]` 標頭）+ mypy | 1 | 73 ms | 28 ms | **0** |
| 4 | `pallets/click` | Python (11 元件) | `uv.lock` + 根目錄 `[tool.ruff]` + 10 個 `examples/*/` | 11 | 75 ms | 62 ms | **0** |
| 5 | `uber-go/zap` | Go (Multi-module) | 4 個 `go.mod` (`./`, `benchmarks/`, `exp/`, `zapgrpc/...`) + `.golangci.yml` v2 | 4 | 59 ms | 13 ms | **0** |
| 6 | `charmbracelet/bubbletea` | Go (Multi-module) | 3 個 `go.mod` (`./`, `examples/`, `tutorials/`) + `.golangci.yml` v2 | 3 | 60 ms | 12 ms | **0** |
| 7 | `stretchr/testify` | Go (Multi-module) | 2 個 `go.mod` (`./`, `_codegen/`)，無 `.golangci.yml` | 2 | 71 ms | 10 ms | **0** |
| 8 | `urfave/cli` | Go (Multi-module) | 2 個 `go.mod` (`./`, `docs/`) + **`.golangci.yaml`** v2 | 2 | 54 ms | 6 ms | **0** |
| 9 | `gin-gonic/gin` | Go | 單一 `go.mod` + `.golangci.yml` v2 | 1 | 62 ms | 12 ms | **0** |
| 10 | `prometheus/client_golang` | Go (Multi-module) | 4 個 `go.mod` + `.golangci.yml` v2（含已啟用 `depguard`） | 4 | 77 ms | 14 ms | **0** |
| 11 | `colinhacks/zod` | TypeScript Monorepo | `pnpm-lock.yaml` v9 + `biome.jsonc` + Vitest（12 個 workspace packages） | 12 | 124 ms | 100 ms | **0** |
| 12 | `changesets/changesets` | TypeScript Monorepo | `pnpm-lock.yaml` v9 + `eslint.config.js` + Vitest（25 個元件） | 25 | 422 ms | 324 ms | **0** |
| 13 | `egoist/tsup` | TypeScript | `pnpm-lock.yaml` + `.prettierrc` + `vitest.config.mts`（`./`, `test/`） | 2 | 67 ms | 15 ms | **0** |
| 14 | `immerjs/immer` | TypeScript | `yarn.lock` + `.prettierrc` + `vitest.config.ts`（`./`, `__tests__/`） | 2 | 70 ms | 17 ms | **0** |
| 15 | `apache/commons-lang` | Java | Maven (`pom.xml`，Java 8) | 1 | 115 ms | 111 ms | **0** |
| 16 | `FasterXML/jackson-core` | Java | Maven (`pom.xml` 繼承 parent POM) | 1 | 71 ms | 83 ms | **0** |
| 17 | `mockito/mockito` | Java Multi-project | Gradle Kotlin DSL (`build.gradle.kts`, `config/checkstyle/checkstyle.xml`) | 1 | 92 ms | 86 ms | **0** |
| 18 | `gotify/server` | Polyglot (Go + TS) | Go 根目錄 (`.golangci.yml`) + `ui/` TypeScript (`yarn.lock`, `eslint.config.mjs`) | 2 | 73 ms | 15 ms | **0** |

---

## 3. 實測揭露之 7 項問題與修復詳情

### 問題 1：Go `.golangci.yaml` 副檔名忽略與多模組父目錄設定繼承缺失
- **觸發專案**：`urfave/cli`、`uber-go/zap`、`charmbracelet/bubbletea`、`prometheus/client_golang`
- **根因分析**：
  1. [`src/layers/settings-go.ts`](../../src/layers/settings-go.ts) 原本僅檢查固定檔名 `.golangci.yml`。`urfave/cli` 使用 `.golangci.yaml`（v2 格式），導致 `check` 誤報 `settings/golangci-missing`，且 `fix --yes` 產生重複的 `.golangci.yml`。
  2. 多模組 Go 專案（如 `uber-go/zap` 的 `benchmarks/`、`exp/`）僅在 repo 根目錄放置一份 `.golangci.yml`（或 `.golangci.yaml`），`golangci-lint` 執行時會自動向父目錄查找設定檔；原本 `settings-go.ts` 只檢查 `component.dir`，導致每個子模組都被誤報缺少 `.golangci.yml` 並於 `fix --yes` 產生多份重複檔案。
- **修復方案**：
  - 於 [`src/settings/go.ts`](../../src/settings/go.ts) 新增 `GOLANGCI_FILES`（`[".golangci.yml", ".golangci.yaml"]`）與 `GoSettingsFiles.golangciFile`。
  - 於 [`src/layers/settings-go.ts`](../../src/layers/settings-go.ts) 新增 `findGolangci`，沿 `ancestors` 向上查找至 repo 根目錄 `cwd`。

---

### 問題 2：`pnpm-lock.yaml` Workspace `importers` 版本覆蓋與 Python 子元件 Lockfile 查找缺失
- **觸發專案**：`colinhacks/zod`、`pallets/click`、`Textualize/rich`
- **根因分析**：
  1. `colinhacks/zod` 的 `pnpm-lock.yaml`（v9）中，根目錄 `.` 使用 `typescript: 5.5.4`、`packages/docs` 使用 `5.8.2`、`packages/treeshake` 的間接 peer 依賴拉入 `typescript@6.0.3`。原本 `readPnpmLock` 僅掃描 `packages:` 區段且後出現的條目覆蓋前者，導致所有元件都被當成 `typescript@6.0.3` 而漏報 `<6` 的過舊版本。
  2. 此外，當 `importers` 中某套件版本為 `link:../zod`（非數字開頭）時，若正則表達式使用 `\s*` 會跨行吞噬後續套件定義。
  3. `python` 原本只檢查 `dir + name`，未如 TypeScript 一般沿 `ancestors` 向上查找根目錄的 `uv.lock` 或 `poetry.lock`，導致 `pallets/click` 與 `Textualize/rich` 的子元件跳過了工具版本檢查。
- **修復方案**：
  - 於 [`src/versions/pinned.ts`](../../src/versions/pinned.ts) 新增 `pnpmImporter` 與單行嚴格匹配的 `PNPM_IMPORTER_DEP`，在 `readPnpmLock` 中依序疊加 `packages:`、根目錄 importer `.` 與子元件 importer 的直接依賴版本。
  - 將 [`src/versions/pinned.ts`](../../src/versions/pinned.ts) 的 `python` 改為遍歷 `ancestors(dir)` 查找 `uv.lock` 與 `poetry.lock`。

---

### 問題 3：Monorepo 子元件工具選擇推論（`draft`）未向上查找父目錄
- **觸發專案**：`colinhacks/zod`、`Textualize/rich`
- **根因分析**：
  - [`src/draft.ts`](../../src/draft.ts) 的 `CHOICE_RULES` 原本僅對 `deps.manager`（`pnpm` / `yarn`）使用向上查找，對 `biome.json(c)`、`jest.config.*`、`poetry.lock`、`pyrightconfig.json` 則只檢查元件自身目錄。
  - 在 `colinhacks/zod` 中，根目錄放了 `biome.jsonc`，但 11 個子套件（`packages/*`）被誤推為預設的 `eslint+prettier`，導致 `check` 與 `fix --yes` 在每個子套件中要求並建立 `.prettierrc` 與 `eslint.config.js`。
- **修復方案**：
  - 於 [`src/draft.ts`](../../src/draft.ts) 新增 `nearestChoice`，由元件目錄沿 `ancestors` 向上查找最近的設定檔或 lockfile（若同層存在互斥設定檔如 `eslint.config.*` 則優先採計同層），統一套用至 `CHOICE_RULES`。

---

### 問題 4：TypeScript 子元件未向上查找根目錄共用設定檔
- **觸發專案**：`colinhacks/zod`、`changesets/changesets`、`egoist/tsup`、`immerjs/immer`
- **根因分析**：
  - TypeScript 專案的子元件（如 `packages/*`、`test/`、`__tests__/`）普遍繼承根目錄的 `.prettierrc`、`biome.jsonc`、`eslint.config.*`、`vitest.config.*` 或 `tsconfig.json`。
  - 原本各檢查器只在元件自身目錄查找，導致：
    1. `draft` 為根元件推得 `format.printWidth: 80`（來自根目錄 `.prettierrc`），卻對 `test/` 子元件使用預設值 `120`，進而觸發假陽性 `declaration/style-inconsistent`；
    2. `check` 對所有子元件誤報 `settings/missing-file`；
    3. `fix --yes` 在每個子目錄產生多份重複的 `.prettierrc` / `tsconfig.json` / `biome.json`。
- **修復方案**：
  - 於 [`src/settings/config-files.ts`](../../src/settings/config-files.ts) 新增 `searchDirs` 並擴充 `findFirst` 支援從元件目錄向上查找至 repo 根目錄（絕不超出 `cwd`）。
  - 於 [`src/settings/judge.ts`](../../src/settings/judge.ts) 公開 `dir`，並更新 [`checkBiome`](../../src/settings/typescript/biome.ts)、[`checkEslint`](../../src/settings/typescript/eslint.ts)、[`checkPrettier`](../../src/settings/typescript/prettier.ts)、[`checkCoverage`](../../src/settings/typescript/coverage.ts) 與 [`checkTsconfig`](../../src/settings/typescript/tsconfig.ts) 沿父目錄查找；若直到 repo 根目錄仍找不到設定檔，則維持在元件自身目錄回報 `settings/missing-file`。

---

### 問題 5：Python 獨立 `ruff.toml` / `.ruff.toml`、`pyrightconfig.json` 與父目錄 `[tool.ruff]` 支援
- **觸發專案**：`pallets/click` 及使用獨立 `ruff.toml` / `pyrightconfig.json` 之 Python 專案
- **根因分析**：
  - Ruff 官方規則會自動略過不含 `[tool.ruff]` 的子目錄 `pyproject.toml` 並向上查找父目錄的 `ruff.toml` / `.ruff.toml` 或含 `[tool.ruff]` 的 `pyproject.toml`（例如 `pallets/click` 的 10 個 `examples/*/pyproject.toml` 僅含 `[project]` 與 `[tool.flit.module]`，Ruff 設定集中於根目錄 `pyproject.toml`）。
  - 此外，當 `draft.ts` 因 `pyrightconfig.json` 推論 `typecheck.tool: pyright` 時，原本 [`src/layers/python-settings.ts`](../../src/layers/python-settings.ts) 只讀取 `pyproject.toml` 的 `[tool.pyright]`，完全未讀取 `pyrightconfig.json`。
- **修復方案**：
  - 於 [`src/layers/python-settings.ts`](../../src/layers/python-settings.ts) 新增 `findFallbackRuff` 與 `readExtraConfigs`，在元件 `pyproject.toml` 未定義 `[tool.ruff]` / `[tool.pyright]` 時，支援讀取 `ruff.toml`、`.ruff.toml`、父目錄 `pyproject.toml` 的 `[tool.ruff]` 以及 `pyrightconfig.json`。
  - 於 [`src/settings/python.ts`](../../src/settings/python.ts) 擴充 `checkPyproject` 與 `Report.forFile`，使 findings 與自動修復 `repairs` 精準指向實際設定檔與對應鍵路徑（如 `ruff.toml` 的頂層 `["line-length"]` 或 `pyproject.toml` 的 `["tool", "ruff", "line-length"]`）。

---

### 問題 6：`editToml` 隱式母表誤寫頂層點號鍵與 `editYaml` 長字串強制折行
- **觸發專案**：`encode/starlette`（TOML）、`uber-go/zap` 與 `prometheus/client_golang`（YAML）
- **根因分析**：
  1. **TOML 編輯**：`encode/starlette` 的 `pyproject.toml` 寫有 `[tool.ruff.lint]`，但沒有顯式的 `[tool.ruff]` 區塊標頭。`parseToml` 解析後仍會在記憶體中建立 `doc.tool.ruff` 物件，導致原本的 `isObj(getIn(doc, table))` 回傳 `true` 並交由 `patchToml` 修補；而 `toml-patch` 因找不到 `[tool.ruff]` AST 節點，竟將 `tool.ruff.line-length = 120` 插入在 `pyproject.toml` 第 1 行。另外，當目標檔案為空字串（如新建 `ruff.toml`）且寫入頂層鍵（`table.length === 0`）時，原本會回傳空字串。
  2. **YAML 編輯**：`yaml` 套件的 `doc.toString()` 預設 `lineWidth: 80`，在 `uber-go/zap` 與 `prometheus/client_golang` 修改 `.golangci.yml` 時，將檔案中其他無關區塊（如 `exclusions.rules` 的長正則表達式與註解）強制折行，造成大範圍非預期 diff。
- **修復方案**：
  - 於 [`src/fix/edit.ts`](../../src/fix/edit.ts) 新增 `hasTomlTable`，確認文字中實際存在 `[section]` 標頭（或為 `[[array]]` 索引）才交由 `patchToml` 原地修改，否則以 `[section]` 區塊附加於檔尾；並支援空檔案頂層鍵序列化。
  - 於 [`src/fix/edit.ts`](../../src/fix/edit.ts) 的 `editYaml` 傳入 `doc.toString({ lineWidth: 0 })`，禁止重排既有長行。

---

### 問題 7：大型設定檔 Diff 計算之 $O(N^2)$ 記憶體與耗時瓶頸
- **觸發情境**：對數千行設定檔執行 `devguard fix` 預覽或套用時
- **根因分析**：
  - [`src/fix/plan.ts`](../../src/fix/plan.ts) 的 `lcsLengths` 直接對整份檔案行陣列 `a` 與 `b` 配置 `new Int32Array((a.length + 1) * (b.length + 1))`。若檔案有 5,000 行且僅修改其中 2 行，仍會配置約 100 MB 並執行 $2.5 \times 10^7$ 次迴圈。
- **修復方案**：
  - 於 [`src/fix/plan.ts`](../../src/fix/plan.ts) 新增 `trimCommon`，在進入 `lineOps` 時先剝離前後完全相同的共同行（prefix / suffix），僅對中間實際發生變動的差異區段計算 LCS，將局部修改的複雜度降至 $O(\Delta^2)$。

---

## 4. 各專案實測結果摘要

### 4.1 Python 專案
- **`fastapi/typer`**：
  - `draft` 偵測 `./ (python)`，自動推得 `format.lineLength: 88` 與 `python.minVersion: 3.10`（附 TODO 理由）。
  - `fix --yes` 自動於 `pyproject.toml` 補齊 `[tool.coverage.run] branch = true` 與缺少的 Ruff 規則組 `C90, SIM, N, S`，並建立 `.gitattributes`。修正後可自動修復錯誤為 **0**。
- **`Textualize/rich`**：
  - `draft` 偵測 `./` 與 `docs/` 兩個元件，透過向上查找根目錄 `poetry.lock` 正確為兩者推得 `deps.manager: poetry`。
  - `tool-versions` 正確從根目錄 `poetry.lock` 檢出 `./` 與 `docs/` 的 `mypy 1.14.1`、`pytest 7.4.4`、`pytest-cov 3.0.0` 低於標準範圍。
  - `fix --yes` 更新 `pyproject.toml`、建立 `docs/pyproject.toml` 與 `.gitattributes`。修正後可自動修復錯誤為 **0**。
- **`encode/starlette`**：
  - `pyproject.toml` 僅有 `[tool.ruff.lint]` 而無 `[tool.ruff]`。修復 `hasTomlTable` 後，`fix --yes` 正確保留原檔案註解並補齊規則組 `W, B, C90, SIM, N, S, TID`。修正後可自動修復錯誤為 **0**。
- **`pallets/click`**：
  - 含根目錄與 10 個 `examples/*/` 共 11 個 Python 元件。修復 `findFallbackRuff` 後，10 個 `examples/*/` 正確繼承根目錄 `pyproject.toml` 的 `[tool.ruff]`（`format.lineLength: 88`），消除了假陽性的 `declaration/style-inconsistent` 與 10 個重複的 `ruff-missing` 錯誤。修正後可自動修復錯誤為 **0**。

### 4.2 Go 專案
- **`uber-go/zap`**、**`charmbracelet/bubbletea`**、**`prometheus/client_golang`**：
  - 皆為含 3～4 個 `go.mod` 的多模組專案，共用根目錄 `.golangci.yml`（v2）。
  - `check` 正確讓子模組繼承根目錄 `.golangci.yml`；`fix --yes` 僅修改根目錄 `.golangci.yml` 一次（耗時 12～14 ms），且不折行任何既有長字串。修正後可自動修復錯誤皆為 **0**。
- **`urfave/cli`**：
  - 根目錄使用 `.golangci.yaml`（v2），`docs/` 子模組無獨立設定檔。
  - `check` 與 `fix --yes` 正確識別並直接編輯 `.golangci.yaml`（耗時 6 ms），不產生重複的 `.golangci.yml`。修正後總 findings 與可自動修復錯誤皆為 **0**。
- **`stretchr/testify`**、**`gin-gonic/gin`**：
  - `stretchr/testify` 無 `.golangci.yml`，`fix --yes` 自動建立符合 v2 標準的 `.golangci.yml`；`gin-gonic/gin` 原地補齊缺少的 linters 與 `gocognit` / `depguard` 設定。修正後可自動修復錯誤皆為 **0**。

### 4.3 TypeScript 與 Polyglot 專案
- **`colinhacks/zod`**：
  - 含 12 個 workspace 元件的 pnpm + Biome + Vitest monorepo。
  - `draft` 為全部 12 個元件正確推得 `lint.tool: biome` 與 `deps.manager: pnpm`。
  - `tool-versions` 透過 `readPnpmLock` 精準區分根目錄與多數套件的 `typescript 5.5.4` 及 `packages/docs`、`packages/integration`、`packages/resolution` 的 `typescript 5.8.2`。
  - `fix --yes` 僅修改實際存在的 `biome.jsonc` 與各套件 `tsconfig.json`，不產生任何多餘設定檔。修正後可自動修復錯誤為 **0**。
- **`changesets/changesets`**：
  - 含 25 個元件的 pnpm monorepo。各子元件自動向上繼承根目錄的 `tsconfig.json`、`eslint.config.js` 與 `vitest.config.ts`。修正後可自動修復錯誤為 **0**。
- **`egoist/tsup`**、**`immerjs/immer`**：
  - `test/` 與 `__tests__/` 子元件正確繼承根目錄的 `.prettierrc`（`printWidth: 80`）與 `vitest.config.*`，不再觸發 `declaration/style-inconsistent` 或建立重複的 `.prettierrc`。修正後可自動修復錯誤皆為 **0**。
- **`gotify/server`（Polyglot：Go + TypeScript）**：
  - `draft` 同時識別 `./ (go)` 與 `ui/ (typescript)`（自動推得 `deps.manager: yarn`、`format.printWidth: 100`）。
  - `fix --yes` 同時修補根目錄 `.golangci.yml`（自動將 `errcheck` 與 `gocognit` 從 `linters.disable` 移除並加入 `linters.enable`）、`ui/tsconfig.json` 與 `.gitattributes`，並印出 `ui/eslint.config.mjs` 與 `ui/vitest.config.js` 的程式碼修改片段。修正後可自動修復錯誤為 **0**。

### 4.4 Java 專案
- **`apache/commons-lang`**、**`FasterXML/jackson-core`**（Maven）：
  - `draft` 從 `pom.xml` 推得 `apache/commons-lang` 的 `java.minVersion: "8"`（附 TODO 理由），並對 `FasterXML/jackson-core` 繼承自 parent POM 的版本給出 `java/version-unreadable` 提示。
  - `fix --yes` 自動產生帶有 `由 CLI 產生` 標頭的 `checkstyle.xml`、`pmd-ruleset.xml` 及 `.gitattributes`，且絕不觸碰 `pom.xml`。修正後可自動修復錯誤皆為 **0**。
- **`mockito/mockito`**（Gradle Kotlin DSL 多模組）：
  - `draft` 將巢狀 Gradle 模組合併為單一根元件 `./ (java)` 並推得 `build.tool: gradle`。
  - `fix --yes` 重新產生 `config/checkstyle/checkstyle.xml`、`pmd-ruleset.xml` 與 `.gitattributes`。修正後可自動修復錯誤為 **0**。

---

## 5. 修改檔案與新增單元測試對照表

| 模組分類 | 修改檔案 | 新增 / 更新之測試檔案 |
| :--- | :--- | :--- |
| **TOML / YAML 設定檔原地編輯** | [`src/fix/edit.ts`](../../src/fix/edit.ts) | [`test/fix-edit.test.ts`](../../test/fix-edit.test.ts) |
| **大檔案 Diff 共同前後綴裁切** | [`src/fix/plan.ts`](../../src/fix/plan.ts) | [`test/fix-plan.test.ts`](../../test/fix-plan.test.ts) |
| **Lockfile 工具版本解析（pnpm / Python）** | [`src/versions/pinned.ts`](../../src/versions/pinned.ts) | [`test/pinned.test.ts`](../../test/pinned.test.ts) |
| **Go `.golangci.yaml` 與父目錄繼承** | [`src/settings/go.ts`](../../src/settings/go.ts)<br>[`src/layers/settings-go.ts`](../../src/layers/settings-go.ts) | [`test/settings-go-layer.test.ts`](../../test/settings-go-layer.test.ts)<br>[`test/settings-go.test.ts`](../../test/settings-go.test.ts) |
| **Monorepo 工具選擇推論（`draft`）** | [`src/draft.ts`](../../src/draft.ts) | [`test/draft.test.ts`](../../test/draft.test.ts) |
| **TypeScript 父目錄共用設定檔查找** | [`src/settings/config-files.ts`](../../src/settings/config-files.ts)<br>[`src/settings/judge.ts`](../../src/settings/judge.ts)<br>[`src/settings/typescript/biome.ts`](../../src/settings/typescript/biome.ts)<br>[`src/settings/typescript/coverage.ts`](../../src/settings/typescript/coverage.ts)<br>[`src/settings/typescript/eslint.ts`](../../src/settings/typescript/eslint.ts)<br>[`src/settings/typescript/prettier.ts`](../../src/settings/typescript/prettier.ts)<br>[`src/settings/typescript/tsconfig.ts`](../../src/settings/typescript/tsconfig.ts) | [`test/settings-typescript.test.ts`](../../test/settings-typescript.test.ts) |
| **Python `ruff.toml` / `pyrightconfig.json` 與父目錄繼承** | [`src/layers/python-settings.ts`](../../src/layers/python-settings.ts)<br>[`src/settings/python.ts`](../../src/settings/python.ts) | [`test/python-settings.test.ts`](../../test/python-settings.test.ts) |

---

## 6. 自身品質與回歸驗證結果

於 `devguard` 專案自身執行完整檢查 `node src/cli.ts check --full`：
- **測試套件**：43 個測試檔、492 個測試案例全數通過（100% pass）。
- **靜態檢查與標準符合度**：ESLint（`strictTypeChecked`、循環複雜度 $\le 10$、認知複雜度 $\le 15$）、Prettier、`tsc --noEmit`、Vitest 覆蓋率門檻（$\ge 80\%$）全數通過，**0 個錯誤、0 個偏離**。
