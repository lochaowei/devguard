# 研究：CLI 實作語言與 Windows 分發選項

對應票：[CLI 實作語言與 Windows 分發選項研究](../issues/01-cli-runtime-options.md)
（本文件只整理事實與取捨，最終決策屬於「CLI 實作語言與分發方式決策」票。）

## 摘要

- Windows 上最穩的是**單一 `.exe`**（Go、Rust，或以 Bun / Deno / Node SEA 編譯的 TS）。關鍵原因：Claude Code hook 的 exec form（不經 shell）無法執行 npm 安裝的 `.cmd` shim。
- pre-commit 框架本身需要 Python；它能自動安裝 golang / rust 工具鏈，並以 `rev` 鎖定版本。
- Go 的風險：`gopkg.in/yaml.v3` 已於 2025-04 封存（後繼為 `go.yaml.in/yaml/v4`）；Windows 防毒常誤判 Go binary。
- Python + uv 不需預裝 Python，但每次 hook 執行都要付直譯器啟動成本。

## 三道防線如何呼叫 CLI

| 呼叫端 | 事實 | 來源 |
|---|---|---|
| Claude Code hooks | shell form 在 Windows 上用 Git Bash 執行，沒有 Git Bash 則用 PowerShell，可用 `shell` 欄位指定。exec form（帶 `args`）需要真正的 `.exe`，npm/npx 的 `.cmd` / `.bat` shim 不能用。exit 2 會阻擋動作，但 `PostToolUse` 無法阻擋。預設 timeout 600 秒。環境變數提供 `CLAUDE_PROJECT_DIR`。 | https://code.claude.com/docs/en/hooks |
| pre-commit | 以 pip 或 zipapp 安裝，因此需要 Python。golang / rust 類 hook 會在缺少時自動安裝工具鏈，官方標示已在 Windows 測試。node 類 hook 在 Windows 上僅「may work under cygwin」。 | https://pre-commit.com/ |
| VS Code tasks | 有 `shell` 與 `process` 兩種類型；可用 `windows.options.shell` 個別覆寫；problem matcher 可解析工具輸出。 | https://code.visualstudio.com/docs/debugtest/tasks |

## 各實作選項

| 選項 | Windows 安裝 / 執行 | 備註 | 來源 |
|---|---|---|---|
| Go | 單一 `.exe`，不需 runtime | Go FAQ 指出 Windows 防毒誤判很常見；GoReleaser 可產生 winget manifest 並自動對 winget-pkgs 開 PR；YAML 函式庫 `yaml.v3` 已封存（2025-04），後繼為 `go.yaml.in/yaml/v4` | Go FAQ、GoReleaser docs |
| Rust | 單一 `.exe` | cargo-dist 的安裝器 / 更新器能力**未驗證**（文件站當時無法連線） | — |
| Node / TS（npm） | npm `bin` 在 Windows 上會變成 cmd shim，exec form hook 無法呼叫 | 需預裝 Node | npm docs |
| Node / TS 編譯成 exe | Node SEA 仍標示「Active development」，`--build-sea` 於 v25.5.0 加入；Bun 可交叉編譯 `bun-windows-x64` / `arm64`；Deno 可交叉編譯 Windows 目標、內嵌 npm 套件、支援 `--icon` | 保留 TS 生態，又能得到單一 exe | Node / Bun / Deno docs |
| Python（uv） | uv 預設會自動下載 Python；可用 `uvx tool@ver` 或 `--from` 精確鎖版 | `tomllib`（3.11+）只能讀、不能寫 TOML；每次執行有直譯器啟動成本 | https://docs.astral.sh/uv/guides/tools/ 、https://docs.astral.sh/uv/concepts/python-versions/ |

## 安裝通路

- **winget**：Windows 10 1809+ 與 11 內建；支援 portable 套件與 `pin`。上架社群 repo 需經 PR、防毒掃描與人工審核。
- **Scoop**：不需管理員權限；支援自訂 bucket（適合內部工具）。

## 未驗證事項

- cargo-dist 提供哪些安裝器與更新器
- uv 安裝的指令入口在 Windows 上是否為 exec form 可直接呼叫的 `.exe`
- Go / Node 的 YAML 函式庫在編輯時能否保留註解（影響「修正」行為）

## 給決策票的取捨

1. 單一 `.exe` 讓 Windows 上的 hook 最可靠。
2. 如果第三道防線採用 pre-commit，每台機器本來就有 Python，Python「需要 runtime」的缺點就縮小了。
3. 透過 pre-commit `rev` 鎖版，可以和規劃中的一致性檢查接上。
4. 內部工具走自架 Scoop bucket，比等 winget 審核快。
