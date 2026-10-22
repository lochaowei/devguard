# devguard

讓 Java、Python、Go、TypeScript 專案的開發規範（coding standard、complexity、test coverage、dependency）用**一份設定**同時落實到三道防線，並幫開發者快速確認自己的環境是否設定正確。

| 防線 | 時機 | devguard 做什麼 |
|---|---|---|
| 第一道：VS Code | 撰寫時 | 產生並檢查 workspace 設定，讓擴充套件即時顯示問題 |
| 第二道：Claude Code | Claude 編輯檔案時 | 產生 `.claude/` 的 rules、hooks 與 `/standards-doctor`，事前告知標準、事中檢查回饋 |
| 第三道：git hook | commit / push 時 | 安裝 pre-commit 與 pre-push hook，擋下不合格的變更 |

單一事實來源是 **預設標準**（內建在 CLI，例如 `team@1.0.0`）加上專案自己的 **專案宣告** `.devguard.yaml`。完整設計見 [SPEC.md](SPEC.md)，用語定義見 [GLOSSARY.md](GLOSSARY.md)。

## 目前狀態

**v0.1.0：只完成專案宣告的解析與檢查**（`devguard check`）。其餘功能依 [SPEC.md](SPEC.md) 逐步實作，見下方[路線圖](#路線圖)。

## 快速開始

需要 Node.js **22.18 以上**（直接執行 TypeScript 原始碼需要 Node 內建的 type stripping）。

```bash
npm install
```

```bash
npm run devguard -- check
```

正式發佈時，devguard 會用 Bun 打包成單一 `devguard.exe`，透過公司內部的 Scoop bucket 安裝（SPEC §3.1）。

## 專案宣告 `.devguard.yaml`

放在 repo 根目錄。最精簡的寫法：

```yaml
standard: team@1.0.0
components:
  - path: ./
    language: typescript
```

monorepo 與覆寫的寫法：

```yaml
standard: team@1.0.0            # 必須寫確切版本
components:                     # 元件 = 目錄 + 語言
  - path: backend/
    language: go
  - path: web/
    language: typescript
    overrides:
      complexity.cyclomatic: 8              # 收緊：直接寫值
      lint.tool: biome                      # 允許清單內的替代工具：直接寫值
      format.printWidth: 100                # 風格項目：直接寫值
      coverage.lines:                       # 放寬：必須寫理由，可加到期日
        value: 60
        reason: "舊程式碼補測試中，2027 Q1 回到 80"
        until: 2027-03-31
mirrors:
  auth: env                     # 內部 Nexus 需要帳密時
```

規則摘要（細節見 SPEC §4）：

- **收緊**標準、改用**允許清單內**的替代工具、修改**風格**項目，都可以直接寫值。
- **放寬**標準必須寫 `reason`，報告中會標示為**偏離**，不會擋人；超過 `until` 的日期後變回**錯誤**。
- 理由仍是 `TODO`、覆寫不存在的項目、值的型別錯誤、重複宣告同一個元件，都是**錯誤**。
- 每個檔案歸屬於路徑最長且語言相符的元件；沒有元件涵蓋時，依副檔名推定語言並套用預設標準。

可以覆寫的項目與預設值，見 [src/standard/team-1.0.0.ts](src/standard/team-1.0.0.ts) 或 SPEC §5、§6。

## 指令

```
devguard check [--format text|json] [--strict] [--verbose] [--cwd <dir>]
devguard --version
```

| 選項 | 說明 |
|---|---|
| `--format text` | 預設。依元件、等級（錯誤、偏離、提示）分組，最後一行是總結 |
| `--format json` | `{ standard, components[], findings[] }`，給 CI 或其他工具使用 |
| `--strict` | 偏離也算失敗 |
| `--verbose` | 展開所有提示（預設只顯示數量） |
| `--cwd <dir>` | 專案根目錄（預設為目前目錄） |

**exit code**：`0` 通過（只有偏離或提示也算通過）、`1` 有錯誤（或 `--strict` 時有偏離）、`2` CLI 本身出錯（例如參數錯誤）。

輸出範例：

```
標準：team@1.0.0

web/ (TypeScript)
  錯誤  覆蓋率門檻 (%)：80 → 60：比預設寬鬆，必須寫理由（改用 {value, reason, until}）  [declaration/looser-without-reason] .devguard.yaml:6

./ (Python)
  偏離  循環複雜度上限：10 → 15｜理由：舊專案｜到期：2027-03-31  [declaration/deviation] .devguard.yaml:13

1 個錯誤、1 個偏離、0 個提示
```

## 開發

| 指令 | 用途 |
|---|---|
| `npm test` | 執行測試（Vitest） |
| `npm run test:coverage` | 測試並檢查覆蓋率（四項門檻皆為 80%） |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint（typescript-eslint `strictTypeChecked`，循環複雜度上限 10） |
| `npm run format` / `format:check` | Prettier（行寬 120、LF） |
| `npm run build:exe [-- x64\|arm64]` | 用 Bun（≥ 1.2.23）打包成 `dist/devguard-windows-<arch>.exe`，含圖示與版本資訊。交叉編譯的目標沒有圖示與版本資訊（Bun 的限制） |
| `npm run smoke:exe [-- <exe>]` | 從 PATH 移除 Node 後，對 exe 執行 `--version` 與 `check`（範例專案） |
| `npm run t2:probe` / `build:t2-probe` | SPEC §13 T2：子程序行為探測，先在 Node 下跑基準，再打包成 `dist/t2-probe-windows-<arch>.exe` 執行比對 |

devguard 本身也遵守 SPEC §6.3 的 TypeScript 預設標準，並以 [.devguard.yaml](.devguard.yaml) 宣告自己。

### 目錄結構

```
src/
  cli.ts                 指令列入口
  check.ts               devguard check 的宣告檢查層
  process/               啟動外部程序（.cmd 透過 cmd.exe）
  standard/              內建的預設標準與版本查找
  declaration/           宣告檔的解析、比對、套用、檔案歸屬
  report/                finding 型別、文字與 JSON 報告、exit code
test/                    Vitest 測試
scripts/                 exe 打包、smoke test、T2 探測
assets/                  exe 圖示
SPEC.md                  實作規格
GLOSSARY.md              用語定義
.scratch/                規劃過程：地圖、決策票、研究紀錄、原型
```

## 路線圖

依 SPEC 的章節逐步實作：

- [x] 專案宣告的解析與檢查（§4、§5.5、§11）
- [ ] 偵測各工具的設定檔、設定檢查與依既有設定產生宣告草稿（§4.3、§8）
- [ ] `devguard install` 與 `fix` / `fix --code`（§9）
- [ ] git hook：pre-commit、pre-push（§7.4）
- [ ] Claude Code：`.claude/` 的 rules、hooks 與 `/standards-doctor`（§7.3）
- [ ] VS Code：`.vscode/` 的 extensions、settings、tasks（§7.2）
- [ ] `devguard doctor`、內部鏡像與帳密檢查（§10）
- [ ] `devguard standard upgrade`（§5.5）
- [ ] Bun 打包、簽章與 Scoop bucket（§3.1）

導入前需要團隊或 IT 確認的事項見 SPEC §12，實作初期要實機測試的項目見 SPEC §13。
