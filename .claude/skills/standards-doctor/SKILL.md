---
name: standards-doctor
description: 執行 devguard doctor，說明專案標準的檢查結果，經開發者同意後修正
disable-model-invocation: true
allowed-tools: Bash(devguard *), PowerShell(devguard *)
---

<!-- 由 CLI 產生（devguard），請勿手動修改；執行 devguard fix 重新產生 -->

# 標準診斷

以下是 `devguard doctor --format claude` 的結果：

!`devguard doctor --format claude --exit-zero`

請依照結果向開發者說明每一項問題與修正方式。

- 設定類的問題：詢問開發者是否同意，同意後才執行 `devguard fix --yes`。
- 程式碼的格式與 lint：同意後執行 `devguard fix --code <檔案> --yes`。
- 其餘問題依每一項附的修正方式處理。
- 若上方沒有出現檢查結果（例如組織關閉了 skill 中的指令執行），請直接執行 `devguard doctor --format claude`。
