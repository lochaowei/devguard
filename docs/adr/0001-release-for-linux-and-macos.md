# 發佈 Linux 與 macOS 執行檔

devguard 原本只發佈 Windows exe（windows-x64、windows-arm64），因為開發者主要使用 Windows（SPEC §1、§3.1）。現在改為每次 release 同時發佈 Windows、Linux 與 macOS 的 x64 與 arm64 執行檔，CI 也在三種作業系統上執行（#80）。

執行期的程式碼本來就依平台分支（`.venv/bin` 與 `Scripts\*.exe`、`mvnw` 與 `mvnw.cmd`、`code` 與 `code.cmd`、`~/.netrc` 與 `%USERPROFILE%\_netrc`），git hook 也是 POSIX sh，所以支援的成本主要在建置與發佈：Bun 可以為任何平台編譯，在 Linux 上整套測試不需修改就通過。不支援的話，在 Linux 或 macOS 上開發、或在 Linux CI 上跑 `devguard check` 的團隊只能從原始碼執行。

## Considered Options

- **只讓 devguard 能從原始碼在 Linux 上執行，不發佈執行檔**：省下 release 的工作，但使用者要自己裝 Node 22.18 以上，違背「單一執行檔、不需要 Node」的發佈方式。
- **只發佈 Linux，不發佈 macOS**：macOS 的建置與 Linux 幾乎相同，差別只在 runner，沒有省下多少工作。

## Consequences

- 每個平台在自己的 runner 上建置、測試，並對 runner 的架構跑 smoke test；另一個架構交叉編譯，不跑 smoke test（macOS x64、Windows arm64）。Windows 仍必須在 Windows 上建置，才能設定圖示與版本資訊。
- 資產名稱是 `devguard-<windows|linux|macos>-<x64|arm64>`，Windows 加上 `.exe`。名稱用 `macos` 而不是 Bun 的 `darwin`，和使用者熟悉的名稱一致。
- 執行檔一律不簽章。macOS 的執行檔沒有公證（notarization），從瀏覽器下載後會被 Gatekeeper 擋下，使用者要先移除 quarantine 屬性。
- 寫進共用檔案的安裝提示（注入 husky、lefthook 的 hook 行）不能依平台而不同，否則不同作業系統的開發者會輪流改寫同一個檔案；只有直接顯示給使用者的訊息才指向這台機器的資產。
- 只發佈 glibc 的 Linux 執行檔，不提供 musl（Alpine）版本；也不提供 Homebrew、apt 等套件管理器的安裝方式。
