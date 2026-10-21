# 預設標準：TypeScript

Type: grilling
Status: resolved
Blocked by: 03, 07

## Question

TypeScript 的預設標準是什麼？決定工具選型與各項門檻：lint/format（eslint + prettier 或 biome）、tsconfig 嚴格度、complexity 上限、coverage 門檻、dependency 規則（lockfile、禁用清單、弱點掃描工具），以專案宣告格式寫下。

## Answer

TypeScript 預設標準（`team@1.0.0` 草案）。「類型」欄的定義見[專案宣告格式](07-project-declaration-format.md)與[預設標準：Python](08-default-standard-python.md)。這套標準也適用於 CLI 本身的程式碼。

| 標準項目 | 預設值 | 類型 | 落地方式 |
|---|---|---|---|
| `node.minVersion` | `22` | 下限 | `package.json` 的 `engines.node: ">=22"` |
| `lint.tool` | `eslint+prettier`；允許替代工具 `biome` | 工具選擇 | `eslint.config.*` + `.prettierrc` / `biome.json` |
| `lint.rules` | typescript-eslint `strictTypeChecked`（需要型別資訊） | 規則集（拿掉規則算放寬） | flat config |
| `format.printWidth` | `120` | **風格** | Prettier `printWidth` |
| `format.endOfLine` | `lf`，並要求 `.gitattributes` 含 `* text=auto eol=lf` | **風格**（`.gitattributes` 為跨語言共用的修正項目） | Prettier `endOfLine`；CLI 檢查 `.gitattributes` |
| `typecheck.strict` | `true`，加上 `noUncheckedIndexedAccess`、`noImplicitOverride`、`noFallthroughCasesInSwitch`（不開 `exactOptionalPropertyTypes`） | 布林 / 選項清單（拿掉選項算放寬） | `tsconfig.json`；以 `tsc --noEmit` 檢查 |
| `complexity.cyclomatic` | `10` | 上限 | ESLint `complexity` |
| `complexity.cognitive` | `15` | 上限 | `eslint-plugin-sonarjs` 只開 `cognitive-complexity`；用 Biome 時開 `noExcessiveCognitiveComplexity`（預設關閉） |
| `test.tool` | `vitest`；允許替代工具 `jest` | 工具選擇 | — |
| `coverage.lines` | `80`（lines、branches、functions、statements 四項都是 80） | 下限 | Vitest `coverage.thresholds` / Jest `coverageThreshold.global` |
| `deps.manager` | `npm`；允許替代工具 `pnpm`、`yarn` | 工具選擇 | — |
| `deps.lockfile` | `true`：lockfile 必須提交；CI 使用 `npm ci` | 布林 | CLI 檢查 |
| `deps.vulnScan` | `false`（進階項目，預設關閉） | 布林 | 開啟後才套用以下兩項 |
| `deps.vulnFailOn` | `high`（含 dev 依賴） | 嚴重度 | `npm audit --audit-level=high --json` |
| `deps.ignoredVulns` | 空；每一項都要寫 `reason` 與 `until` | 新增項目算放寬 | CLI 依 advisory ID（GHSA）從 JSON 結果中過濾（npm audit 本身不支援忽略） |
| `deps.banned` | `moment`、`request`、`node-fetch` | 禁用清單 | CLI 檢查 `package.json` |
| `deps.bannedApis` | 空（先把機制準備好） | 禁用清單 | ESLint `no-restricted-imports` |

### 修訂（2026-10-22，來自[預設標準：Java](11-default-standard-java.md)）

公司環境不允許下載外部檔案，因此弱點掃描改為**進階項目，預設關閉**（`deps.vulnScan: false`）。專案自行開啟算收緊，不需要寫理由。上表中 `deps.vulnFailOn` 與 `deps.ignoredVulns` 只在開啟後才套用。所有工具與依賴都只能透過公司內部鏡像取得。
