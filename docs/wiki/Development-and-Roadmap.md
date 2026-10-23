# 開發指南與實作路線圖

## 本機開發環境需求

- **Node.js**：`>= 22.18`（直接執行 `src/cli.ts` 依賴 Node 22.18+ 預設啟用的內建 TypeScript type stripping）
- **Bun**（選用，僅打包 `.exe` 時需要）：`>= 1.2.23`

## 常用開發指令

| 指令 | 說明 |
|---|---|
| `npm test` | 執行全部單元與整合測試（Vitest） |
| `npm run test:coverage` | 執行測試並檢查 V8 覆蓋率（`lines`、`branches`、`functions`、`statements` 門檻皆為 80%） |
| `npm run typecheck` | 執行 `tsc --noEmit`（啟用 `strict`、`noUncheckedIndexedAccess`、`noImplicitOverride`、`noFallthroughCasesInSwitch`） |
| `npm run lint` | 執行 ESLint（`typescript-eslint/strictTypeChecked`，循環複雜度上限 10） |
| `npm run format` / `npm run format:check` | 使用 Prettier 格式化或檢查（`printWidth: 120`、`endOfLine: "lf"`） |
| `npm run devguard -- check` | 用 devguard 檢查 devguard 自身的設定、依賴、工具版本與程式碼 |
| `npm run build:exe [-- x64\|arm64]` | 使用 Bun `--compile` 打包成單一 `dist/devguard-windows-<arch>.exe` |
| `npm run smoke:exe [-- <exe>]` | 將 Node 從 `PATH` 移除後，對打包出的 `.exe` 執行 `--version` 與範例專案 `check` |
| `npm run t2:probe` / `npm run build:t2-probe` | SPEC §13 T2：Windows 子程序行為探測（測試 `.cmd` shim、stdin 管線、大量 stdout、中文路徑等） |

---

## 程式碼架構導覽

```text
src/
├── cli.ts                  指令列入口（只接上 process）
├── main.ts                 runCli：參數解析與各子指令分派，可在程序內測試
├── doctor.ts               devguard doctor：check 加上環境層
├── check.ts                CHECK_LAYERS 註冊、FIX_LAYERS（fixable 的層）與 runCheck() 入口
├── draft.ts                devguard draft：掃描 repo 檔案、歸納元件並由設定檢查結果產生 .devguard.yaml 草稿
├── scope.ts                解析 check 的檔案範圍、--only (lint|format|typecheck) 與 --full
├── standard/
│   ├── types.ts            Standard、ItemDef（9 種項目類型）與 Language 型別
│   ├── team-1.0.0.ts       內建預設標準 team@1.0.0 定義
│   └── registry.ts         內建標準版本查找、未知/過新/已移除/已棄用版本判定
├── declaration/
│   ├── parse.ts            解析並驗證 .devguard.yaml 語法與結構
│   ├── compare.ts          9 種標準項目類型的覆寫方向比對（stricter / same / alternative / style / looser）
│   ├── resolve.ts          將專案宣告與預設標準合併為各元件的 EffectiveItem
│   ├── lookup.ts           依檔案路徑與語言找出最長前綴匹配的元件
│   └── path.ts             路徑正規化輔助函式
├── layers/                 可插拔檢查層（實作 CheckLayer 介面）
│   ├── declaration.ts      第 1 層：專案宣告檢查
│   ├── uncovered.ts        第 2 層：未涵蓋程式檔提示
│   ├── settings-python.ts  第 3 層：Python 設定檢查
│   ├── settings-go.ts      第 4 層：Go 設定檢查
│   ├── settings-java.ts    第 5 層：Java 設定檢查
│   ├── deps.ts             第 6 層：依賴規則（lockfile 提交狀態與禁用套件）
│   ├── settings-typescript.ts 第 7 層：TypeScript 設定檢查
│   ├── tool-versions.ts    第 8 層：工具版本範圍一致性檢查
│   ├── gitattributes.ts    第 9 層：.gitattributes EOL 規則檢查
│   ├── mirrors.ts          第 10 層：專案層級的鏡像設定
│   ├── claude-code.ts      第 11 層：.claude/ 的 rules、hooks 與 /standards-doctor
│   ├── vscode.ts           第 12 層：.vscode/ 的 extensions、settings、tasks
│   ├── code.ts             第 13 層：四語言程式碼檢查（lint / format / typecheck）
│   ├── tests.ts            第 14 層：四語言測試與覆蓋率檢查（--full）
│   ├── vuln.ts             第 15 層：弱點掃描（--full）
│   └── environment.ts      doctor 專用：環境檢查
├── settings/               各語言設定檔解析、比對（judge.ts）與產生器
├── deps/                   解析 pyproject.toml / package.json / go.mod / pom.xml / build.gradle 直接依賴
├── versions/               semver 版本範圍解析（range.ts）與 lockfile / 建置檔版本擷取（pinned.ts）
├── code/                   Python、Go、TypeScript、Java 程式碼檢查器（CodeChecker）
├── testing/                Python、Go、TypeScript、Java 測試與覆蓋率檢查器（TestChecker）
├── fix/                    devguard fix：檔案分類（category.ts）、AST/格式保留修補（edit.ts）、LCS diff 預覽（plan.ts）、fix --code
├── hooks/                  git 與 Claude Code hook、devguard install、既有 hook 框架（pre-commit / husky / lefthook）
├── vscode/                 .vscode/ 的 settings、extensions、tasks
├── claude/                 .claude/ 的 hooks、rules 與 /standards-doctor
├── mirrors/                專案層級的鏡像設定（uv、npm、Maven、Gradle）
├── environment/            只有 doctor 跑的環境檢查
├── vuln/                   各語言的弱點掃描
├── shared/                 共用的檔案讀取與型別守衛
├── tools/                  專案工具執行器（runner.ts）：封裝 uv run、node_modules/.bin、go tool、mvnw/gradlew
├── process/                子程序執行（exec.ts）與 Windows .cmd/.bat 透過 cmd.exe /d /s /c 呼叫（cmd-shim.ts）
├── repo/                   透過 git ls-files 列舉 repo 檔案並計算元件歸屬
├── report/                 Finding 結構與 text / json / sarif / vscode / claude 五種渲染器
└── xml/                    XML 解析（含行號，不讀外部 DTD）
```

---

## 打包單一 `.exe` 與發佈流程（GitHub Releases）

1. **本機打包與驗證**：
   ```bash
   npm run build:exe          # 以 Bun 打包 dist/devguard-windows-x64.exe 與 arm64
   npm run smoke:exe          # 將 Node 從 PATH 移除後，驗證 exe 可獨立執行 --version 與 check
   ```
2. **正式發佈新版本**：
   - 更新 `package.json` 中的 `version`，提交並合併至 `main`。
   - 建立並推送相同版本的 Git tag（例如 `git tag v0.2.0 && git push origin v0.2.0`）。
   - GitHub Actions 的 [release workflow](../../.github/workflows/release.yml) 會在 Windows runner 上執行完整測試、建置 `devguard-windows-x64.exe` 與 `devguard-windows-arm64.exe`、執行 smoke test，並自動建立 GitHub Release 附上兩個 `.exe` 與 `SHA256SUMS.txt`（若 tag 與 `package.json` 版本不一致則會中止失敗）。

---

## 實作路線圖與 Issue 進度對照表

以下對應 GitHub Issues `#1`–`#28` 的開發進度（PR #29 已全數完成並合併至 `main`）：

| Issue | 主題 | SPEC 章節 | 狀態 |
|---|---|---|---|
| #1 | 專案宣告（`.devguard.yaml`）解析與檢查 | §4、§5.5、§11 | ✅ 已完成（已合併至 `main`） |
| #2 | 可插拔的檢查層與專案工具執行器 | §2、§5.2 | ✅ 已完成（已合併至 `main`） |
| #3 | 設定檢查：TypeScript | §6.3、§8 | ✅ 已完成（已合併至 `main`） |
| #4 | 設定檢查：Python | §6.1、§8 | ✅ 已完成（已合併至 `main`） |
| #5 | 設定檢查：Go | §6.2、§8 | ✅ 已完成（已合併至 `main`） |
| #6 | 設定檢查：Java | §6.4、§8 | ✅ 已完成（已合併至 `main`） |
| #7 | 沒有宣告時依既有設定產生草稿（`devguard draft`） | §4.3 | ✅ 已完成（已合併至 `main`） |
| #8 | 依賴規則：lockfile 與禁用清單 | §5.4、§6 | ✅ 已完成（已合併至 `main`） |
| #9 | 工具版本一致性檢查 | §5.2、§8 | ✅ 已完成（已合併至 `main`） |
| #10 | 程式碼檢查：TypeScript | §6.3、§7.1 | ✅ 已完成（已合併至 `main`） |
| #11 | 程式碼檢查：Python | §6.1、§7.1 | ✅ 已完成（已合併至 `main`） |
| #12 | 程式碼檢查：Go | §6.2、§7.1 | ✅ 已完成（已合併至 `main`） |
| #13 | 程式碼檢查：Java | §6.4、§7.1 | ✅ 已完成（已合併至 `main`） |
| #14 | 測試與覆蓋率（`check --full`） | §6、§7.1 | ✅ 已完成（已合併至 `main`） |
| #15 | 報告格式：`sarif`、`vscode`、`claude` | §11 | ✅ 已完成（已合併至 `main`） |
| #16 | `fix --code`：自動修正程式碼 | §9.1 | ✅ 已完成（已合併至 `main`） |
| #17 | `fix`：依檔案類別修正設定檔 | §9 | ✅ 已完成（已合併至 `main`） |
| #18 | `devguard install` 與 pre-commit hook | §7.4 | ✅ 已完成（已合併至 `main`） |
| #19 | pre-push hook：完整測試與覆蓋率 | §7.4 | ✅ 已完成（已合併至 `main`） |
| #20 | 注入既有 hook 框架（pre-commit / husky / lefthook） | §7.4 | ✅ 已完成（已合併至 `main`） |
| #21 | `devguard doctor` 與 git hook 環境檢查 | §7.4、§11 | ✅ 已完成（已合併至 `main`） |
| #22 | 第一道防線：VS Code workspace 設定（`.vscode/`） | §7.2 | ✅ 已完成（已合併至 `main`） |
| #23 | 第二道防線：Claude Code（`.claude/` rules、hooks、skill） | §7.3 | ✅ 已完成（已合併至 `main`） |
| #24 | 內部鏡像設定與帳密檢查 | §10 | ✅ 已完成（已合併至 `main`） |
| #25 | 進階：弱點掃描 | §5.3 | ✅ 已完成（已合併至 `main`） |
| #26 | `devguard standard upgrade` 與棄用版本 | §5.5 | ✅ 已完成（已合併至 `main`） |
| #27 | Bun 打包單一 `.exe`、smoke test 與 T2 探測腳本 | §3.1、§13 | ✅ Bun 1.4.4 實機建置；smoke test、T1、T2 通過（已合併至 `main`） |
| #28 | 以 GitHub Release 發佈 `.exe`（取代原簽章與內部 Scoop bucket） | §3.1、§12 | ✅ 已完成（`.github/workflows/release.yml`，已合併至 `main`） |
