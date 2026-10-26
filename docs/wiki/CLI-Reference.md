# CLI 指令與報告格式參考

本頁是總覽：所有指令、共用選項、輸出格式與 exit code。每個指令的細部行為見各自的頁面。

## 指令總覽

```text
用法：devguard <指令> [選項]

指令：
  check [檔案…]  檢查專案宣告（.devguard.yaml）與程式碼；指定檔案時只檢查這些檔案
  doctor         check 加上環境檢查（工具、git hook、VS Code、Claude Code、鏡像帳密、標準更新）；只回報並附上修正指令
  fix            修正設定（工具設定檔、.vscode/、.claude/、git hook）：先預覽，確認後套用；--yes 直接套用
  fix --code [檔案…]  修正程式碼（格式化與可自動修正的 lint），修正後回報剩餘問題
  install        產生各防線的設定並安裝 git pre-commit 與 pre-push hook：先預覽，確認後套用；--yes 直接套用
  hook <名稱>    給 hook 呼叫：git-pre-commit|git-pre-push|claude-session-start|claude-post-edit|claude-stop
  draft          沒有 .devguard.yaml 時，依偵測到的元件與工具設定產生宣告草稿（不覆寫既有檔案）
  standard upgrade [目標版本]
                 預覽標準升級；--apply 才修改宣告與設定檔，並透過內部鏡像執行套件管理指令
```

依導入與使用的順序：

| 指令 | 什麼時候用 | 細節 |
|---|---|---|
| `draft` | 專案還沒有 `.devguard.yaml` | [Command-draft](Command-draft.md) |
| `install` | 宣告確認後，建好三道防線；每位開發者 clone 後也要執行一次 | [Command-install](Command-install.md) |
| `check` | 日常開發、CI | [Command-check](Command-check.md) |
| `fix` / `fix --code` | 修正 `check` 回報的設定與程式碼問題 | [Command-fix](Command-fix.md) |
| `doctor` | 新環境、hook 沒作用、想看完整的環境問題 | [Command-doctor](Command-doctor.md) |
| `hook <名稱>` | 由 git 與 Claude Code 呼叫 | [Command-hook](Command-hook.md) |
| `standard upgrade` | CLI 內建了新版標準 | [Command-standard-upgrade](Command-standard-upgrade.md) |

## 共用選項

| 選項 | 適用指令 | 作用 |
|---|---|---|
| `--cwd <dir>` | 全部 | 專案根目錄，預設為目前目錄。檔案參數仍相對於目前目錄 |
| `--format <格式>` | `check`、`doctor` | 輸出格式，見下方 |
| `--strict` | `check`、`doctor` | 偏離也算失敗 |
| `--verbose` | `check`、`doctor` | 展開提示 |
| `--yes` | `fix`、`install` | 不詢問，直接套用 |
| `--version` | — | 顯示版本 |
| `-h`、`--help` | — | 顯示用法並以 `0` 結束；沒有給指令時顯示用法並以 `2` 結束 |

各指令專屬的選項（`--staged`、`--only`、`--full`、`--quiet`、`--exit-zero`、`--code`、`--apply`）見各指令頁。不適用於該指令的選項會被忽略，不會報錯。

---

## 輸出格式（`--format`）

exit code 只取決於檢查結果，**不會因為 `--format` 而改變**。以下範例都是對同一個問題的輸出。

| 格式 | 給誰 | 輸出 |
|---|---|---|
| `text` | 開發者的終端機（預設） | 依元件分組，組內依「錯誤 → 偏離 → 提示」排序；標示規則、`檔案:行` 與修正方式；提示預設只顯示數量，`--verbose` 才展開 |
| `json` | CI、自動化腳本 | `{ standard, components, findings }`；每個 finding 有 `level`、`layer`、`rule`、`message`、`component`、`file`、`line`、`column`、`fix`、`fixable` |
| `sarif` | GitHub Code Scanning 等平台 | SARIF 2.1.0，**只包含 `layer` 為 `code` 的問題** |
| `vscode` | VS Code problem matcher | 每個問題一行：`檔案:行:欄: 等級: 訊息 [規則]` |
| `claude` | Claude Code 的 hook 與 skill | 精簡列表，最多 20 項（其餘顯示「…還有 N 項」），總長度少於 4,000 字元 |

```text
$ devguard check src/first.ts
標準：team@1.0.0

./ (TypeScript)
  錯誤  Type 'number | undefined' is not assignable to type 'number'.  [tsc/TS2322] src/first.ts:2
        需手動修正：手動修正型別錯誤

1 個錯誤、0 個偏離、0 個提示

$ devguard check src/first.ts --format vscode
src/first.ts:2:3: error: Type 'number | undefined' is not assignable to type 'number'. [tsc/TS2322]

$ devguard check src/first.ts --format claude
devguard：1 個錯誤、0 個偏離、0 個提示
- 錯誤 src/first.ts:2:3 Type 'number | undefined' is not assignable to type 'number'. [tsc/TS2322]（修正：手動修正型別錯誤）

$ devguard check src/first.ts --format json
{
  "standard": "team@1.0.0",
  "components": [
    {
      "path": "./",
      "language": "typescript"
    }
  ],
  "findings": [
    {
      "level": "error",
      "layer": "code",
      "rule": "tsc/TS2322",
      "message": "Type 'number | undefined' is not assignable to type 'number'.",
      "component": "./ (TypeScript)",
      "file": "src/first.ts",
      "line": 2,
      "column": 3,
      "fix": "手動修正型別錯誤",
      "fixable": false
    }
  ]
}
```

## Exit code

| Exit code | 意義 |
|---|---|
| `0` | 通過：沒有錯誤（只有偏離或提示也算通過）；或 `fix` / `install` 已套用、沒有需要修改的地方 |
| `1` | 有錯誤；或加上 `--strict` 時有偏離；或 `fix` / `install` 有變更但沒有套用；或 `standard upgrade` 只預覽而有變更待套用 |
| `2` | CLI 本身出錯：用法錯誤、不認得的指令或格式、`check` 時專案工具沒有安裝、`draft` 時宣告已存在、內部例外 |

各指令的細節見各指令頁的「輸出與 exit code」。

---

## 示範專案

各指令頁的範例都是在下面這個專案上實際執行取得的，路徑改寫為 `C:\work\demo`。它是一個最小的 TypeScript 專案，用來呈現從導入到日常使用的完整過程，也包含實際遇到的問題。

1. 建立專案並初始化 git：

   ```sh
   mkdir demo && cd demo && git init -b main
   ```

   - `package.json`：`"type": "module"`、`"engines": { "node": ">=22" }`
   - `tsconfig.json`：`{ "compilerOptions": { "strict": true, "target": "es2022", "module": "nodenext" }, "include": ["src"] }`
   - `src/add.ts`：一個 `add(a, b)` 函式
   - `.gitignore`：`node_modules/`、`coverage/`。**一定要有**，否則 `node_modules/` 中的檔案會被當成專案檔案，見 [check 的常見錯誤](Command-check.md#常見錯誤與排解)

2. 安裝標準要求的工具：`typescript`、`eslint`、`typescript-eslint`、`prettier`、`vitest`、`@vitest/coverage-v8`。`team@1.1.0` 不要求 `eslint-plugin-sonarjs`；宣告 `team@1.0.0` 時才需要另外安裝 `eslint-plugin-sonarjs@3`（撰寫本文時它的 peer dependency 不接受 ESLint 10，要加上 `--legacy-peer-deps`，並自行補裝因此沒有自動安裝的 `globals` 與 `vite`）。
3. `devguard draft` → 產生宣告（[範例](Command-draft.md)）。
4. `devguard check` → 12 個錯誤（[範例](Command-check.md#初次導入設定與程式碼的問題一起列出)）。
5. `devguard fix --yes` → 寫入 `tsconfig.json`、`.prettierrc`、`.gitattributes`、`.npmrc`、`.vscode/`（[範例](Command-fix.md#範例)）。
6. 手動建立 `eslint.config.js`（`strictTypeChecked`、`complexity`；`team@1.0.0` 另加 `sonarjs/cognitive-complexity`，並在 `projectService.allowDefaultProject` 列出 `eslint.config.js`、`vitest.config.ts`）與 `vitest.config.ts`（`coverage.include: ["src/**/*.ts"]` 與四個 80% 門檻）。
7. `devguard check` → `通過：沒有錯誤、偏離或提示`。
8. `devguard install --yes` → 產生 `.claude/` 與 git hook（[範例](Command-install.md#範例)）。
9. 之後依各頁範例故意製造問題：未格式化的檔案、型別錯誤、沒有測試的函式、放寬覆蓋率的偏離、被修改的 hook。

`.npmrc` 指向標準中的範例鏡像 `nexus.example.internal`，示範時安裝套件要加上 `--registry https://registry.npmjs.org/`。
