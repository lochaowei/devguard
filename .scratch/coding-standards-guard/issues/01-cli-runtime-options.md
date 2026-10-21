# CLI 實作語言與 Windows 分發選項研究

Type: research
Status: resolved
Blocked by:

## Question

核心 CLI 該用什麼語言實作、如何分發到以 Windows 為主的開發者機器？比較 Go（單一 binary）、Node/TypeScript（npm）、Python（pipx/uv）、Rust 等選項，針對：

- Windows 上的安裝體驗（winget / scoop / npm / pipx / 直接下載），是否需要開發者預先裝某個 runtime
- 能否被 VS Code task、Claude Code hook、pre-commit hook 三者無痛呼叫（Windows shell 差異：cmd / PowerShell / Git Bash）
- 讀寫 YAML / JSON / TOML 設定檔、呼叫外部工具（ruff、golangci-lint、eslint、mvn/gradle）的生態成熟度
- 自動更新 / 版本鎖定的可行性

產出：各選項的事實比較表與取捨，供「CLI 實作語言與分發方式決策」使用。

## Answer

- Windows 上最穩的是單一 `.exe`（Go / Rust / 以 Bun、Deno、Node SEA 編譯的 TS）：Claude Code hook 的 exec form 無法執行 npm 的 `.cmd` shim。
- pre-commit 需要 Python；若採用它，Python CLI 的「需要 runtime」缺點縮小，且 `rev` 鎖版可接上一致性檢查。
- Go 風險：`yaml.v3` 已封存、Windows 防毒誤判；Python + uv 有直譯器啟動成本。
- 內部分發走自架 Scoop bucket 比 winget 審核快。

[研究結果](../research/01-cli-runtime-options.md)
