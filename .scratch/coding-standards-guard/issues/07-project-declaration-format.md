# 專案宣告格式

Type: prototype
Status: resolved
Blocked by: 03

## Question

專案宣告長什麼樣？做出幾個具體範例檔讓使用者反應：檔名與位置、schema（採用哪些語言、繼承哪一版預設標準、覆寫項目、偏離理由）、monorepo 中如何依目錄指定語言，以及「無宣告時依既有設定檔產生的草稿」會長怎樣。

## Assets

- 原型：[prototypes/07-project-declaration.prototype.html](../prototypes/07-project-declaration.prototype.html)（單一 HTML，雙擊即可開啟；預設標準數值為佔位）

## Answer

依據原型與使用者的回饋，定案如下：

- **檔案**：放在 repo 根目錄的單一 YAML 檔，暫定名稱為 `.standards.yaml`（實際檔名跟著 CLI 名稱決定）。
- **頂層**：`standard: <名稱>@<版本>` 宣告繼承哪一版預設標準；`components:` 是元件清單。
- **元件**：一個元件 = 一個 `path`（目錄）加一個 `language`。同一個目錄有多種語言時，就寫成多個元件。
- **覆寫**：寫在元件底下的 `overrides:`，key 用標準項目的名稱（例如 `coverage.lines`、`complexity.cyclomatic`，完整清單由四張預設標準票決定）。
  - 收緊、或改用允許清單內的替代工具：直接寫值即可。
  - 放寬：必須寫成 `{value, reason, until?}`。沒有理由或理由還是 `TODO` 時算錯誤；有理由時標示為**偏離**，不擋人；`until` 過期後再變回錯誤。
  - 每個項目都有「哪個方向算更嚴格」的類型：上限（max）、下限（min）、布林、嚴重度、禁用清單（移除項目算放寬）、工具選擇（不在允許清單內算放寬）。
  - 覆寫不存在的項目、值的型別不對、重複宣告同一個元件，都算錯誤。
- **檔案歸屬**：找路徑前綴最長、而且語言和副檔名相符的元件。找不到時依副檔名**推定語言**，套用該語言的預設標準（沒有覆寫），並提示「建議在宣告中補上元件」。四種語言以外的檔案不在檢查範圍內。
- **沒有宣告時**：依偵測到的工具設定檔產生草稿。與預設相同的項目省略；比預設寬鬆的項目先帶著 `TODO` 理由，要填寫後才算通過。
- **與工具設定檔的一致性（設定檢查）**：設定檔比宣告寬鬆算錯誤，`fix` 會改回宣告的值；比宣告嚴格算提示，建議把宣告同步過去。

原型：[prototypes/07-project-declaration.prototype.html](../prototypes/07-project-declaration.prototype.html)（裡面 `Std` 模組的 `resolve`、`lookup`、`draftFromDetected`、`checkToolConfigs` 可以直接移植進 CLI）
