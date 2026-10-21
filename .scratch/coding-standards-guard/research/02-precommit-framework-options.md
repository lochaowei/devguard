# 研究：第三道防線的 hook 框架選項（多語言 + Windows）

對應票：[02 pre-commit 框架比較研究](../issues/02-precommit-framework-options.md)
研究日期：2026-10-22。本文只整理事實與取捨，**不做決策**（決策屬於後續「pre-commit 框架決策」grilling 票）。

比較對象：

- **pre-commit**：Python 寫的 hook 框架，`.pre-commit-config.yaml`
- **lefthook**：Go 寫的單一執行檔，`lefthook.yml`
- **husky + lint-staged**：Node 生態，`core.hooksPath` + `package.json`/`.lintstagedrc`
- **CLI 自裝 hook**：我們的 CLI 自己寫 `.git/hooks/pre-commit`（或設 `core.hooksPath`），hook 內容只呼叫 CLI

---

## 1. 共同底層：Git 怎麼找到並執行 hook

- hook 目錄預設為 `$GIT_DIR/hooks`，可用 `core.hooksPath` 改位置；沒有執行權限的 hook 會被忽略。[githooks]
- Git 執行 hook 前，cwd 會切到工作樹根目錄（非 bare repo）。[githooks]
- `pre-commit` hook 沒有參數，`git commit --no-verify` 可略過；非 0 結束碼會中止 commit。[githooks]
  → **任何框架都可以被 `--no-verify` 繞過**，所以第三道防線本質上是「提醒＋攔截」，強制力要靠 CI。
- 三種框架產生的 hook 檔都是 **POSIX shell 腳本**（pre-commit 為 `#!/usr/bin/env bash`，lefthook 為 `#!/bin/sh`，husky 用 sh stub）。在 Windows 上要靠 Git for Windows 內附的 sh/bash 來執行，所以 Windows 開發者**一定要裝 Git for Windows**（一般都有）。[pre-commit hook-tmpl][lefthook hook.tmpl][husky index.js]
- husky 文件明確提醒：hook 腳本要寫成 POSIX 相容，因為不是每個人都有 `bash`（例如 Windows 使用者）。[husky how-to]
- 新版 Git（pre-commit 文件提到 git 2.54）支援用 `git config` 設定 hook（`hook.<name>.event` / `hook.<name>.command`），不必放檔案進 hooks 目錄。這是新機制，團隊 Git 版本要夠新才能用。[pre-commit.com]
- **`core.hooksPath` 會互相衝突**：husky 會把 `core.hooksPath` 設成 `.husky/_` [husky index.js]；pre-commit 遇到 `core.hooksPath` 已設定時會**拒絕安裝**（訊息 `Cowardly refusing to install hooks with core.hooksPath set.`，exit 1）[pre-commit install_uninstall.py]。另外有 IDE 透過環境變數強制 `core.hooksPath=/dev/null`，讓 hook 默默被略過的實例（Cursor 3.15.6 回報）[cursor forum]。→ 環境檢查必須看 `core.hooksPath`（含來源），不能只看 `.git/hooks/pre-commit` 檔案存不存在。

---

## 2. 各框架事實

### 2.1 pre-commit（Python）

- **Runtime**：需要 Python，pre-commit 本身用 pip/pipx 等安裝。安裝出來的 hook 把**安裝當下的 Python 直譯器路徑**寫死在 hook 裡（`INSTALL_PYTHON=sys.executable`）；找不到時退回 PATH 上的 `pre-commit`，再找不到就印出 "`pre-commit` not found. Did you forget to activate your virtualenv?" 並 exit 1（擋下 commit）。[hook-tmpl][install_uninstall.py]
  → 若 Python/venv 被移動或刪除，hook 會壞掉並阻擋 commit。
- **只檢查 staged**：官方文件寫明「只對 staged 內容執行，執行時會暫時 stash 未 staged 的變更」，理由是避免誤判。[pre-commit.com] 這是四個選項中**內建最完整**的處理方式。
- **多語言**：hook 可宣告 `language`，pre-commit 會自己建隔離環境：
  - `python`（virtualenv；Windows 上 `python3.x` 這類名稱會轉成 py launcher 呼叫）
  - `node`（nodeenv，不需系統層級依賴）
  - `golang`（`go install ./...`；系統沒有 go 時會**自動 bootstrap**）
  - `docker`（需要 Docker engine）、`coursier`（JVM 應用）、`unsupported`（舊名 `system`）、`unsupported_script`（舊名 `script`）等。[pre-commit.com]
  - **沒有原生 Java / Maven / Gradle language**。Java 只能用 `unsupported`/`system`（呼叫本機 `mvn`/`gradlew`）或 `coursier`。[pre-commit.com]
- **Monorepo**：每個 hook 有 `files` / `exclude`（Python regex，`re.search` 比對），也可設在頂層；例如 `files: ^repo1/`。4.5.0 新增 `pre-commit hazmat cd` 協助在子目錄執行工具。[pre-commit.com]
- **版本鎖定**：每個 hook repo 用 `rev` 鎖 tag 或 commit（不接受分支名或 `HEAD`）；`pre-commit autoupdate --freeze` 可改存 commit hash；`additional_dependencies` 可指定套件版本；`language_version` 指定 runtime 版本。[pre-commit.com]
  → 版本鎖在 `.pre-commit-config.yaml`，工具裝在 pre-commit 自己的快取（Windows 上通常在 `%USERPROFILE%\.cache\pre-commit`），**與 IDE / Claude Code 用的不是同一份安裝**；除非 hook 改成 `language: unsupported` 直接呼叫專案自己的工具（如 `node_modules/.bin/eslint`、`mvn`）。
- **安裝 / 偵測**：`pre-commit install`（可 `-t` 指定 hook 類型、`--install-hooks` 預先建環境、`-f` 覆寫）。遇到既有的非 pre-commit hook 會改名為 `.legacy` 並進入 migration 模式（兩者都跑）。pre-commit 用檔案內的 hash（`CURRENT_HASH` + `PRIOR_HASHES`）判斷 hook 是否為自己裝的。[install_uninstall.py]
  → 環境檢查可以：讀 `.git/hooks/pre-commit`（或 `core.hooksPath` 下的檔案），比對內含 pre-commit 標記，並檢查其中的 `INSTALL_PYTHON` 路徑是否還存在。
- **Windows 已知問題**（GitHub issues，第一頁）：路徑含空白（#3362、#3363、#3383、#3519）、PowerShell 腳本含空白路徑失敗（#3384）、`--all-files` 觸發 "The command line is too long"（#3405）、Windows 上 Python shebang 壞掉（#3468、#3469）、local python hook 沒用 pre-commit 環境（#3415）、Windows 上平行執行 hook 的問題（#3365）。[pre-commit issues]

### 2.2 lefthook（Go 單一執行檔）

- **Runtime**：「standalone, no-deps binary」。可從 npm、Go（`go install …/v2@v2.x.y` 或 `go get -tool`）、pipx、gem、Homebrew、**Winget、Scoop**、mise、手動下載等安裝。[lefthook install][lefthook README]
- **hook 腳本如何找 lefthook**（`#!/bin/sh`）：依序找 `LEFTHOOK_BIN` → 產生時記錄的路徑 → PATH 上的 `lefthook` → `lefthook.bat` → repo 根目錄（及各 `root` 子目錄）下的 `node_modules` 平台執行檔 → 再試 `go tool lefthook`、`bundle exec`、`yarn`、`pnpm`、`uv run`、`mise exec` 等。都找不到時印 "Can't find lefthook in PATH"；預設**不會擋 commit**，除非設 `assert_lefthook_installed: true` 才 exit 1。[hook.tmpl]
  → 這個 fallback 鏈讓「工具裝在專案依賴裡」很自然（Node 專案用 `node_modules`、Go 專案用 `go tool`、Python 用 `uv run`），但也代表「沒裝時預設會默默放行」。
- **只檢查 staged**：提供 `{staged_files}`、`{push_files}`、`{all_files}`、`{files}` 等 placeholder；`stage_fixed: true` 會在指令執行後對檔案 `git add`（只對 pre-commit 有效）。[lefthook run][lefthook stage_fixed]
  - **官方文件沒有說明會隱藏部分 staged 檔案中未 staged 的變更**（不像 pre-commit / lint-staged）。推論（未經原始碼證實）：若檔案部分 staged，又搭配 `stage_fixed` 的 `git add`，未 staged 的修改可能被一起加入 commit。**需要實測確認。**
- **命令列長度**：檔案清單太長時，lefthook 會拆成多次依序執行。[lefthook run]
- **Monorepo**：`root` 指定 command 的 cwd，且只傳入該目錄下的檔案（全被濾掉就略過）；`glob` 仍從 repo 根比對。[lefthook root] 另有 `glob`、`exclude`、`parallel`、`skip`/`only`、`extends`、`remotes`（從遠端 repo 共享設定）、`lefthook-local.yml`（個人覆寫、可單獨存在）。[lefthook configuration]
- **版本鎖定**：`min_version`（只限最低版本，文件未說明檢查細節）[lefthook min_version]；實際鎖定靠安裝管道（npm devDependency、`go.mod` 的 tool、pipx 版本等）。lefthook 只負責「呼叫什麼指令」，lint 工具的版本由各語言自己的依賴管理決定 → **天然與 IDE / Claude Code 用同一份工具**（只要 run 指令指向專案依賴）。
- **安裝 / 偵測**：`lefthook install` 寫入 hook；`lefthook check-install` 在 hook 已安裝且同步時 exit 0，否則 exit 1。第三方指出它是比對 `.git/info/lefthook.checksum` 與設定檔內容，**不驗證 hook 檔本身**（被別的工具覆寫仍判定已安裝）。[lefthook check-install][nmr PR #798]
- **執行 shell**：`run` 以 `sh` 執行；文件建議 Windows 使用者引用時可用雙引號。[lefthook run]
- **Windows 已知問題**（GitHub issues）：`parallel: true` 在 Windows 卡住（#1256）、Windows 上 sh 語法錯誤（#1167）、npm -g 安裝在 Windows 無法運作（#1165）、Windows 上 command 不能用相對路徑（#1021）、1.11.5 在 `C:\Program Files\Git\bin\sh.exe` 不存在時出錯（#989）、GitHub Desktop 等 GUI 找不到執行檔 `npx: not found`（#887）、路徑含中括號解析錯誤（#747）、job 跳出新視窗（#1357）；也有「Windows 上用 sh.exe 作 runner」（#1163）、「用 Git bash 包裝指令」（#953）的功能請求。[lefthook issues]

### 2.3 husky + lint-staged（Node）

- **Runtime**：需要 Node / npm（`prepare` script 安裝）。husky 會跑 `git config core.hooksPath .husky/_`，在 `.husky/_` 產生 `.gitignore`（`*`）、共用腳本 `h` 與 14 個 hook stub；hook 本體是 `.husky/pre-commit` 這類你自己寫的 shell 檔。`HUSKY=0` 可停用。[husky index.js][husky how-to]
- **GUI / 版本管理器**：GUI 不會初始化 nvm/fnm，`node` 可能不在 PATH；husky 會在每個 hook 前 source `~/.config/husky/init.sh`（Windows：`C:\Users\<you>\.config\husky\init.sh`）。[husky how-to]
- **子目錄 / monorepo**：husky 基於安全理由不會安裝到上層目錄；`package.json` 不在 git 根時要在 `prepare` 裡 `cd ..` 再 `husky frontend/.husky`。官網列出支援 monorepo。[husky how-to][husky intro]
- **只檢查 staged（lint-staged）**：預設會**隱藏部分 staged 檔案的未 staged 變更**，跑完再套回，並先建立 `git stash` 備份。[lint-staged README]
- **Monorepo（lint-staged）**：可在各 package 放各自的設定，每個 staged 檔案用**最近的設定**，設定不合併。[lint-staged README]
- **命令列長度**：檔案清單會自動切塊執行，文件特別提到 Windows；可用 `--max-arg-length` 調整。[lint-staged README]
- **版本鎖定**：husky、lint-staged 與 ESLint/Prettier 等都在 `package.json` + lockfile → 對 TS 專案來說與 IDE 用同一份。但 **Java / Python / Go 專案也得導入 Node 與 `package.json`**，只為了跑 hook。
- **偵測**：檢查 `git config core.hooksPath` 是否為 `.husky/_`，以及 `.husky/_/h` 是否存在。

### 2.4 CLI 自己安裝 `.git/hooks`

- 我們的 CLI 本來就要能在 CI 執行檢查，因此 hook 可以只寫一行：呼叫 `<cli> check --staged`（或 `hook-impl`）。用 POSIX sh 寫，由 Git for Windows 的 sh 執行。[githooks]
- **可直接借鏡的作法**：
  - pre-commit：hook 檔內放 hash 標記以辨識「是自己裝的」、既有 hook 改名 `.legacy` 並串接執行、遇到 `core.hooksPath` 就拒絕。[install_uninstall.py]
  - lefthook：checksum 檔（`.git/info/…`）判斷設定是否同步、多層 fallback 找執行檔、`assert` 選項決定找不到時要擋還是放行。[hook.tmpl][check-install]
  - lint-staged：隱藏未 staged 變更的流程（存 patch → checkout → 跑工具 → 套回）+ stash 備份。[lint-staged README]
- **需要自己做的事**：staged-only（含部分 staged 檔案的 stash/還原，這是最容易出錯的部分）、檔案清單切塊（Windows 命令列長度）、依目錄分派語言工具、平行執行、與既有 hook 共存、`core.hooksPath` 處理。
- **好處**：一致性檢查、環境檢查、版本權威都在同一支 CLI 裡，不必再解析第三方框架的設定；不額外要求 Python 或 Node runtime。
- **Spotless 先例**：Java 生態的 Spotless 提供 `spotlessInstallGitPrePushHook`（Gradle）/ `spotless:install-git-pre-push-hook`（Maven），由建置工具自行安裝 **pre-push** hook（Gradle 8.0.0 起只裝在 root project；Maven 2.46.1 修過 Windows 問題）。可看出「工具自己裝 hook」是可行做法，但每個工具各自裝會互相覆蓋。[spotless javadoc][spotless changelog]

---

## 3. 比較表

| 面向 | pre-commit | lefthook | husky + lint-staged | CLI 自裝 hook |
|---|---|---|---|---|
| 額外 runtime | Python（hook 寫死安裝時的直譯器路徑） | 無（單一執行檔，多種安裝管道含 winget/scoop/npm/go/pipx） | Node + npm | 只要我們的 CLI |
| hook 腳本 | bash（`#!/usr/bin/env bash`） | sh（`#!/bin/sh`） | sh stub + `core.hooksPath` | 自己決定（建議 POSIX sh） |
| Windows 已知痛點 | 路徑含空白、命令列過長、shebang | parallel 卡住、sh 語法、GUI 找不到 npx、相對路徑 | GUI 下找不到 node（需 init.sh） | 需自行處理以上所有問題 |
| 只檢查 staged | 內建；stash 未 staged 變更 | `{staged_files}` + `stage_fixed`；**文件未提到隱藏部分 staged 變更** | lint-staged 內建隱藏部分 staged + stash 備份 | 需自行實作 |
| 命令列長度 | 有過 Windows 回報（#3405） | 自動拆批 | 自動切塊（`--max-arg-length`） | 需自行實作 |
| Monorepo / 依目錄 | 每個 hook 的 `files` regex；`hazmat cd` | `root` + `glob`；`extends`/`remotes` | lint-staged 最近設定優先；husky 子目錄需手動 `cd` | 直接用專案宣告的目錄對應 |
| 工具版本鎖定 | `rev` + `additional_dependencies`，工具裝在 pre-commit 快取（與 IDE 不同份） | 不管工具版本，指令指向專案依賴 → 可與 IDE 同份 | `package.json` lockfile（TS 同份；其他語言要多一份 Node） | CLI 是權威，可直接與 IDE / Claude Code 共用 |
| Java（Maven/Gradle） | 無原生支援；用 `unsupported`/`system` 呼叫 mvn/gradlew 或 coursier | `run: ./gradlew …` / `mvn …`（加 `root`） | 透過 shell 呼叫 mvn/gradlew；Java repo 需加 Node | CLI 呼叫 mvn/gradlew |
| 「hook 已安裝」偵測 | hook 檔內 hash 標記 + `INSTALL_PYTHON` 路徑存在；`core.hooksPath` 必須未設 | `lefthook check-install`（比對 checksum，不驗 hook 檔） | `core.hooksPath == .husky/_` + `.husky/_/h` | 自定標記 + 自定 checksum |
| 找不到執行檔時 | exit 1（擋 commit） | 預設放行；`assert_lefthook_installed` 才擋 | 依 hook 腳本 | 自己決定 |
| 與既有 hook 共存 | `.legacy` migration 模式 | 有（文件未細查） | 改 `core.hooksPath`，會讓 `.git/hooks` 失效 | 自己決定 |

---

## 4. 取捨（供決策票討論，不是結論）

1. **「一致性檢查」與「版本權威」**：pre-commit 的模型是「框架自己管理工具環境」，因此 hook 跑的 ESLint/ruff 等和 IDE、Claude Code 跑的是**不同安裝**，要一致就得同時對齊 `rev` 與專案依賴，或全部改用 `language: unsupported`（那就失去 pre-commit 的主要價值）。lefthook 與 CLI 自裝則天然沿用專案依賴 / CLI。
2. **Windows runtime 負擔**：Java/Go repo 引入 husky 就得多帶 Node；pre-commit 要求每台機器有可用 Python，且 hook 寫死直譯器路徑。lefthook 與 CLI 自裝只需一個執行檔（加上 Git for Windows 的 sh）。
3. **staged-only 的正確性**：pre-commit、lint-staged 有成熟的「隱藏未 staged 變更」機制；lefthook 文件沒有，需實測；CLI 自裝則要自己寫這段最容易出錯的邏輯。
4. **與 CLI 的關係**：若 CLI 已有 `check --staged`，hook 框架只剩「安裝 hook + 傳檔案清單」的價值；此時 lefthook（薄、可只放一個 job 呼叫 CLI）或 CLI 自裝最簡單，pre-commit 的 repo/環境管理會與 CLI 重疊。
5. **既有專案相容**：很多專案已在用 pre-commit 或 husky；`core.hooksPath` 衝突（husky ↔ pre-commit）是硬限制，環境檢查與修正都必須偵測並處理，而不論選哪個。
6. **找不到工具時的行為**：lefthook 預設放行、pre-commit 預設擋下；這直接影響「環境檢查」該報什麼、以及使用者體驗。
7. **待實測項目**：lefthook 部分 staged 檔案 + `stage_fixed` 的行為；pre-commit 在含空白路徑的 Windows 使用者目錄下的表現；三者在 GitHub Desktop / VS Code Git GUI 下能否找到工具（PATH 問題）。

---

## 5. 來源

- [githooks] Git 官方文件 githooks：https://git-scm.com/docs/githooks
- [pre-commit.com] pre-commit 官方文件：https://pre-commit.com/
- [hook-tmpl] pre-commit hook 範本原始碼：https://github.com/pre-commit/pre-commit/blob/main/pre_commit/resources/hook-tmpl
- [install_uninstall.py] pre-commit 安裝邏輯原始碼：https://github.com/pre-commit/pre-commit/blob/main/pre_commit/commands/install_uninstall.py
- [pre-commit issues] https://github.com/pre-commit/pre-commit/issues?q=windows+is%3Aissue （#3362、#3363、#3365、#3383、#3384、#3405、#3415、#3468、#3469、#3519）
- [lefthook README] https://github.com/evilmartians/lefthook
- [lefthook install] https://lefthook.dev/install/
- [lefthook configuration] https://lefthook.dev/configuration/
- [lefthook run] https://lefthook.dev/configuration/run/
- [lefthook root] https://lefthook.dev/configuration/root/
- [lefthook stage_fixed] https://lefthook.dev/configuration/stage_fixed/
- [lefthook min_version] https://lefthook.dev/configuration/min_version/
- [lefthook check-install] https://lefthook.dev/usage/commands/check-install/
- [hook.tmpl] lefthook hook 範本原始碼：https://github.com/evilmartians/lefthook/blob/master/internal/templates/hook.tmpl
- [lefthook issues] https://github.com/evilmartians/lefthook/issues?q=is%3Aissue+windows （#747、#887、#953、#989、#1021、#1163、#1165、#1167、#1256、#1357）
- [nmr PR #798]（第三方，check-install 行為說明）：https://github.com/williamthorsen/node-monorepo-tools/pull/798
- [husky intro] https://typicode.github.io/husky/
- [husky how-to] https://typicode.github.io/husky/how-to.html
- [husky index.js] husky 安裝邏輯原始碼：https://github.com/typicode/husky/blob/main/index.js
- [lint-staged README] https://github.com/lint-staged/lint-staged
- [cursor forum]（第三方回報，IDE 強制 core.hooksPath）：https://forum.cursor.com/t/git-hooks-silently-skipped-for-all-source-control-operations-since-3-15-6-git-extension-forces-core-hookspath-dev-null/167719
- [spotless javadoc] https://javadoc.io/static/com.diffplug.spotless/spotless-lib/4.8.0/com/diffplug/spotless/GitPrePushHookInstaller.html
- [spotless changelog] https://gitlab.com/diffplug/spotless/-/tags/gradle%2F8.0.0 、https://gitlab.com/diffplug/spotless/-/tags/maven%2F2.46.1
