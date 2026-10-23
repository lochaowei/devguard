# devguard Wiki

歡迎來到 **devguard** 使用與開發說明文件。

`devguard` 是多語言（Java、Python、Go、TypeScript）開發規範三道防線 CLI 工具：以一份**預設標準**（內建於 CLI，例如 `team@1.0.0`）加上專案根目錄的**專案宣告**（`.devguard.yaml`）為單一事實來源，統一驅動並檢查、修正三道防線。

## 三道防線總覽

| 防線 | 觸發時機 | 執行內容 |
|---|---|---|
| **第一道：VS Code** | 撰寫與存檔時 | 擴充套件即時顯示 lint、格式與型別問題；提供 `standards:*` tasks |
| **第二道：Claude Code** | Claude 讀寫檔案時 | `.claude/rules/` 事前載入元件標準、`PostToolUse` / `Stop` hook 事中檢查並回饋、`/standards-doctor` 診斷與修正 |
| **第三道：git hook** | `git commit` / `git push` | `pre-commit` 擋下不合格的 staged 變更；`pre-push` 執行完整測試與覆蓋率檢查 |

## 文件導覽

- **[專案宣告（`.devguard.yaml`）](Project-Declaration.md)**
  元件與檔案歸屬規則、9 種標準項目類型、覆寫與偏離（`reason` / `until`）規則、以及使用 `devguard draft` 從既有設定自動產生草稿。
- **[CLI 指令與報告格式參考](CLI-Reference.md)**
  `devguard check`、`devguard fix`、`devguard draft` 的完整參數、10 道可插拔檢查層的執行順序、4 種檔案修補分類，以及 `text`、`json`、`sarif`、`vscode`、`claude` 五種輸出格式與 exit code 語意。
- **[各語言預設標準（`team@1.0.0`）與檢查對照表](Language-Standards.md)**
  Python、Go、TypeScript、Java 四種語言的標準項目預設值、設定檔落地位置、鎖定工具版本的讀取來源、程式碼檢查工具與測試覆蓋率判定方式。
- **[開發指南與實作路線圖](Development-and-Roadmap.md)**
  專案架構與模組職責、本機開發與測試指令、Bun 單一 `.exe` 打包與 T2 子程序探測，以及 GitHub Issues（#1–#28）實作進度對照表。

## 規格與領域詞彙

- 完整規格書：[SPEC.md](../../SPEC.md)
- 領域詞彙定義：[GLOSSARY.md](../../GLOSSARY.md)
