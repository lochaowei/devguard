# 查證 D：VS Code 擴充套件偵測、Bun `--compile`、Claude Code hook／skill 機制

對應：SPEC.md §3.1、§7.2、§7.3、§13 第 2、7、8 項
查證日期：2026-10-22
來源原則：只採官方文件、官方原始碼（GitHub `main` 分支）、官方 changelog 與官方 issue tracker。標「〔推論〕」的是讀原始碼後的推論，還沒在實機上驗證；標「〔待實測〕」的是只能在公司環境確認的事項。

---

## 第 2 項：`code --list-extensions` 與擴充套件的停用狀態

**判定：⚠ 部分不同**。偵測「有沒有安裝」可行。偵測「有沒有停用」沒有任何 CLI 方式。在 Windows 上直接 spawn `code` 會失敗。公司內部 marketplace 不一定適用於 `code --install-extension`。

### 事實

1. **`--list-extensions` 不會依停用狀態過濾。**
   - 官方文件只寫「List the installed extensions」，`--show-versions` 會加上版本號。輸出沒有啟用或停用的欄位。
   - 原始碼 `extensionManagementCLI.ts` 的 `listExtensions()` 只呼叫 `getInstalled(ExtensionType.User, profileLocation)`，接著依 category 過濾、排序，最後輸出 `id` 或 `id@version`。整段完全沒有用到 enablement service，所以**停用的擴充套件一樣會列出來**。
   - 不加 `--profile` 時列出的是預設 profile。開發者若在其他 profile 工作，結果可能不一樣。
   - CLI 和停用有關的只有 `--disable-extensions` 與 `--disable-extension <id>`，兩者都只作用在「這次啟動」，沒有任何查詢停用狀態的參數。
2. **停用狀態存放在 SQLite 檔 `state.vscdb` 的 `ItemTable`。**
   - key 為 `extensionsIdentifiers/disabled`（常數 `DISABLED_EXTENSIONS_STORAGE_PATH`），值是 `[{id, uuid}]` 的 JSON 陣列。同層還有 `extensionsIdentifiers/enabled`。
   - **全域停用**（`StorageScope.PROFILE`）：預設 profile 的位置是 `%APPDATA%\Code\User\globalStorage\state.vscdb`。其他 profile 是 `%APPDATA%\Code\User\profiles\<id>\globalStorage\state.vscdb`（來源：`userDataProfile.ts` 的 `joinPath(location,'globalStorage')`）。
   - **工作區停用**（`StorageScope.WORKSPACE`，見 workbench 的 `extensionEnablementService.ts`）：位置是 `%APPDATA%\Code\User\workspaceStorage\<hash>\state.vscdb`。`<hash>` 由資料夾 URI 等資訊算出，沒有公開的計算規則。
   - 在本機實際查過：沒有停用任何擴充套件時，這個 key 不存在。
   - 這些都是**內部實作細節，不是公開 API**。VS Code 執行中時檔案也可能被鎖住。
3. **Windows 上的 `code` 是 `bin\code.cmd`。**
   - 內容是 `set ELECTRON_RUN_AS_NODE=1` 加上 `"%~dp0..\Code.exe" "%~dp0..\resources\app\out\cli.js" %*`。
   - Node 官方文件明講：`.bat`／`.cmd` 不能用 `execFile` 或不經 shell 的 `spawn` 執行，必須透過 `cmd.exe` 或 `shell: true`。Bun 的 lint 規則 `bun/no-unportable-commands` 也寫明「you can't start a script without a shell」，而且 `Bun.spawn` 一樣適用。
   - 可行的做法有兩種：
     - 用 `Bun.spawn(["cmd.exe","/d","/s","/c","code","--list-extensions","--show-versions"])`。
     - 用 `Bun.which("code")` 找到 `code.cmd`，往上推出安裝目錄，再設定環境變數 `ELECTRON_RUN_AS_NODE=1`，直接 spawn `Code.exe` 並傳入 `resources\app\out\cli.js`。這是複製 `code.cmd` 的行為，不需要 shell。
   - 另外要注意：`code` 是否在 PATH 上取決於安裝時的勾選。Insiders 版的指令名是 `code-insiders`。
   - Bun 有一個未解的 issue #40846：`Bun.which` 與 `Bun.spawn` 用的是啟動當下的 PATH 快照，執行期修改 `process.env.PATH` 不會生效。
4. **私有 marketplace 的設定方式**
   - 微軟官方的 Private Marketplace 目前**只提供給 GitHub Enterprise 客戶**，使用者必須用 GitHub Enterprise 或 Copilot Business／Enterprise 帳號登入 VS Code。
   - 部署方式是透過群組原則的 `ExtensionGalleryServiceUrl`（VS Code 1.99 起，對應設定 `extensions.gallery.serviceUrl`）。1.137 起另有 `ExtensionGalleryAuthProvider`。
   - 原始碼顯示，私有 marketplace 的網址與存取檢查實作在 workbench 的 `electron-browser/extensionGalleryManifestService.ts`，它會讀取 `extensions.gallery.serviceUrl`。CLI 進程 `cliProcessMain.ts` 用的是基底類別 `ExtensionGalleryManifestService`，這個類別**只讀 `product.json` 的 `extensionsGallery.serviceUrl`**。
   - 〔推論〕所以 `code --install-extension <id>` 不會走群組原則設定的私有 marketplace，仍會連到 product.json 指定的公開 marketplace。只有修改 product.json 才會改變 CLI 連的位置，但每次 VS Code 更新都會覆蓋 product.json。
   - 〔待實測〕公司的「內部 marketplace」是不是微軟的 Private Marketplace，需要 IT 確認。也可能是 Open VSX 或 Nexus 之類的方案，那樣的話安裝方式完全不同。

### 來源
- https://code.visualstudio.com/docs/configure/command-line
- https://github.com/microsoft/vscode/blob/main/src/vs/platform/extensionManagement/common/extensionManagementCLI.ts （`listExtensions`）
- https://github.com/microsoft/vscode/blob/main/src/vs/platform/extensionManagement/common/extensionManagement.ts （`DISABLED_EXTENSIONS_STORAGE_PATH`）
- https://github.com/microsoft/vscode/blob/main/src/vs/platform/extensionManagement/common/extensionEnablementService.ts （PROFILE scope）
- https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/extensionManagement/browser/extensionEnablementService.ts （WORKSPACE scope）
- https://github.com/microsoft/vscode/blob/main/src/vs/platform/userDataProfile/common/userDataProfile.ts
- https://github.com/microsoft/vscode/blob/main/resources/win32/bin/code.cmd
- https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows
- https://bun.com/docs/lint/rules/bun/no-unportable-commands
- https://github.com/oven-sh/bun/issues/40846
- https://code.visualstudio.com/docs/enterprise/extensions#_host-a-private-extension-marketplace
- https://code.visualstudio.com/docs/enterprise/policies （`ExtensionGalleryServiceUrl` 1.99、`ExtensionGalleryAuthProvider` 1.137）
- https://github.com/microsoft/vscode/blob/main/src/vs/code/node/cliProcessMain.ts
- https://github.com/microsoft/vscode/blob/main/src/vs/platform/extensionManagement/common/extensionGalleryManifestService.ts
- https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/extensionManagement/electron-browser/extensionGalleryManifestService.ts

### 建議的 SPEC.md 修改
§7.2「環境檢查」第一點改為：

> - 透過 `cmd.exe /d /s /c code --list-extensions --show-versions` 偵測**已安裝**的擴充套件（`code` 是 `.cmd`，不能直接 spawn）。這個指令不會區分啟用或停用，也只列出預設 profile。找不到 `code` 時回報提示，而不是錯誤。
> - 停用狀態不在偵測範圍內。缺少擴充套件的訊息附註「若已安裝但停用，請在 VS Code 中啟用」。

§13 第 2 項標記為「已查證：無法以 CLI 分辨；`state.vscdb` 是內部格式，不採用」。另外新增一項：「公司內部 marketplace 的種類（微軟 Private Marketplace 需要 GitHub Enterprise）。CLI 不負責安裝擴充套件，只提供連結。」

---

## 第 7 項：Bun `--compile` 產出的 Windows exe

**判定：⚠ 部分不同**。規格的方向可行，但需要補上幾個限制：Bun 的最低版本、建置必須在 Windows 上進行、簽章後要驗證、交叉編譯需要連網下載 runtime。

### 事實

1. **目標平台與版本**
   - 官方文件列出 `bun-windows-x64` 與 `bun-windows-arm64`。x64 目標的 `-baseline`／`-modern` 後綴「still accepted for backward compatibility」，單一 binary 會在執行時選擇 AVX2 或 AVX-512 的程式碼路徑。
   - 目前最新版是 **Bun v1.4.3**（2026-10-10）。
   - 文件的 Cross-compile 章節說明：目標和主機不同時，Bun 會下載該目標的 runtime。有一個已修正的 bug（#43446，1.3.14）：Windows 主機編譯 `bun-windows-x64-baseline` 時，下載的 runtime 解壓失敗。
   - 〔待實測〕在公司網路裡，交叉編譯（例如在 x64 機器上產出 arm64）需要能連到 Bun 的 runtime 下載來源，或事先放好快取。
2. **exe 大小**
   - 官方文件沒有給 Windows 的具體數字，只寫 Bun 的 binary「still way too big」。
   - v1.4.3 的 `bun-windows-x64.zip` 為 44.6 MB，`bun-windows-aarch64.zip` 為 39.9 MB（GitHub release 的 asset 大小）。產出的 exe 大約是 runtime 本身加上 bundle。〔待實測〕解壓後的實際大小，預估在 100 MB 上下。
3. **Windows 中繼資料與圖示**
   - CLI 參數有 `--windows-icon` 與 `--windows-hide-console`。JS API 的 `compile.windows` 另外提供 `title`、`publisher`、`version`、`description`、`copyright`。
   - 官方警告：除了 `hideConsole`，**交叉編譯時都不能使用**，因為這些選項依賴 Windows API。所以要設定版本資訊或圖示，就必須在 Windows 主機上編譯。
   - 〔待實測〕在 x64 Windows 上編譯 arm64 目標算不算「交叉編譯」。
4. **程式碼簽章**
   - 官方文件只有 macOS `codesign` 的章節，沒有 Windows signtool 的說明。
   - 曾有已知 bug：簽章後 exe 會壞掉，例如變成印出 Bun 的說明文字。相關 issue 是 #10574（1.1.5，`Set-AuthenticodeSignature`）與 #20109（1.2.15，signtool）。
   - 這個問題由 **PR #22960「implement authenticode stripping for --compile」** 修正，2025-09-26 合併，包含在 **v1.2.23**。修正後，資料放在 PE 的 `.bun` section，編譯時會先移除既有的 Authenticode 簽章並重新計算 checksum，「ensuring that generated executables can be properly signed with external tools」。
   - 由此可知流程必須是**先 compile，再用 signtool 簽章**。簽章之後不能再修改 exe。
5. **已知的 Windows 子程序問題**（官方 issue tracker，皆為未解）
   - `.cmd`／`.bat` 不能不經 shell 直接 spawn。這是 Windows 與 Node 的共通行為，見第 2 項。
   - #32011（1.3.14）：`node:child_process` 的 `execFileSync`／`spawnSync` 在呼叫某些原生 exe 時卡住，最後 ETIMEDOUT。改用 `shell:true` 或 `cmd /c` 就正常。
   - #40846：PATH 快照問題（見上）。
   - #43660：管線串接時，若主控台 codepage 不是 UTF-8，輸出的 UTF-8 會變亂碼。
   - #11328（Bun Shell）：參數與路徑都含空白時，呼叫 `.cmd` 會失敗。
   - 另外有數個 Windows x64 上 segfault 或 GC 相關的未解 issue（#40302、#40607）。
6. **防毒誤判**
   - 官方 issue #16981 曾回報 Windows Defender 把 Bun 的 release zip（1.2.2 baseline）判為 trojan，已於 2026-02 關閉。
   - Bun issue tracker 裡**找不到**專門針對 `--compile` 產出物被誤判的報告。
   - #45086（未解）指出：Bun 1.4 新增的 compile cache 放在 `%TEMP%\node-compile-cache\`，被 Defender 掃描時效能會變差好幾倍，可用 `NODE_DISABLE_COMPILE_CACHE=1` 停用。〔待實測〕這個 cache 是否也作用在 standalone exe 上。
   - 一般經驗是：用公司憑證簽章，加上內部散佈，可以降低 SmartScreen 與 Defender 的誤判。這是業界常識，沒有 Bun 官方來源。

### 來源
- https://bun.com/docs/bundler/executables （targets、Windows-specific flags、cross-compile、macOS codesign）
- https://github.com/oven-sh/bun/releases/tag/bun-v1.4.3
- https://github.com/oven-sh/bun/issues/10574 、https://github.com/oven-sh/bun/issues/20109 （簽章後壞掉，已修正）
- https://github.com/oven-sh/bun/pull/22960 （Authenticode stripping，v1.2.23）
- https://github.com/oven-sh/bun/issues/43446 、https://github.com/oven-sh/bun/issues/32011 、https://github.com/oven-sh/bun/issues/40846 、https://github.com/oven-sh/bun/issues/43660 、https://github.com/oven-sh/bun/issues/11328
- https://github.com/oven-sh/bun/issues/16981 、https://github.com/oven-sh/bun/issues/45086

### 建議的 SPEC.md 修改
§3.1「打包」改為：

> - **打包**：用 Bun `--compile`（Bun 至少 1.2.23，鎖定在 CI 實測過的版本）打包成單一 `.exe`（windows-x64、windows-arm64），這是唯一的發佈形式。
> - 建置在 Windows runner 上進行，因為圖示與版本資訊（`compile.windows.*`）不支援交叉編譯。
> - 流程是先 compile，再 `signtool sign /fd sha256 /tr <時間戳伺服器>`。簽章後必須執行 `signtool verify /pa`，並執行 `<cli> --version` 做冒煙測試。
> - CLI 呼叫外部工具時一律 spawn 真正的 `.exe`。遇到 `.cmd` 時透過 `cmd.exe /d /s /c` 執行。

§13 第 7 項改為只列〔待實測〕的部分：exe 大小、公司防毒對簽章後 exe 的反應、arm64 runtime 的取得方式。

---

## 第 8 項：Claude Code hooks 與 skills

**判定：⚠ 部分不同**。所有機制都存在，但 **`onFailure` 對 `Stop` hook 沒有作用**，而且規格寫的是「全部 hook 都設 `onFailure: "block"`」。另外，`PostToolBatch` 在 changelog 中找不到加入的版本。

### 事實

1. **`onFailure`**
   - 適用於 command 與 http hook，值為 `"continue"`（預設）或 `"block"`，**需要 v2.1.295 以上**。hooks 文件寫明了這一點，changelog 2.1.295 也有「Added `onFailure: "block"` for command and HTTP hooks」。
   - 以下情況算失敗：無法啟動、exit code 不是 0 或 2、HTTP 錯誤、逾時、JSON 輸出無效。只輸出純文字不算失敗。
   - 設為 `"block"` 時，失敗的效果等同該事件的 exit 2。
   - 官方明文：「**The field has no effect on** `Stop`, `SubagentStop`, `TaskCompleted`, and `TeammateIdle` hooks」，也不作用在 `async`／`asyncRewake` 的背景 hook。
   - 套到規格的三個 hook：
     - `SessionStart`：exit 2 不會阻擋任何東西，所以 `block` 實際意義有限。
     - `PostToolUse`：工具已經執行完，exit 2 的效果是把 stderr 回饋給 Claude。
     - `Stop`：設了也無效。
2. **`PostToolBatch`**
   - 這個事件存在，在一批平行工具呼叫全部完成之後、下一次呼叫模型之前觸發一次。不支援 matcher，輸入包含 `tool_calls[]`，每項有 `tool_name`、`tool_input`、`tool_use_id`、`tool_response`。
   - **hooks 文件沒有標注最低版本，changelog 搜尋「PostToolBatch」也找不到**，所以加入的版本無法從文件確認。
   - 注意它的 `decision:"block"` 或 `continue:false` 會「stops the agentic loop」，也就是結束這一輪，而不是把訊息回饋給 Claude 讓它繼續修。要回饋的話應該用 `hookSpecificOutput.additionalContext`。
   - 規格 §7.3 目前沒有使用這個事件，只有 §13 提到。
3. **`Stop` 的 `stop_hook_active`**
   - 已確認。文件原文：「`stop_hook_active` field is `true` when Claude Code is already continuing as a result of a stop hook」。
   - 另外有連續 8 次繼續的上限，每次 Claude 呼叫工具時重新計算，可用 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` 調整（changelog 2.1.143）。
   - `PostToolUse` 和 `Stop` 都用最上層的 `decision:"block"` 加 `reason`，`systemMessage` 會顯示給使用者。
   - `additionalContext`、`systemMessage` 與純文字 stdout 的上限是 **10,000 字元**，超過的部分會改存成檔案，只留 2,000 字元預覽。規格的「少於 4,000 字元」在這個範圍內。
4. **exec form（`args`）**
   - changelog 2.1.139 加入。設定了 `args` 時，會在 PATH 上解析 `command` 並直接 spawn，不經 shell，任何平台都不做斷詞。
   - Windows 上 `command` 必須解析到真正的 `.exe`，`.cmd`／`.bat` shim 無法執行。
   - 如果 `command` 是不含路徑分隔符號的名稱、又含有空白，會記錄警告。
   - 文件也建議：在 Windows 沒有 Git Bash 的環境，採用「exec form 加 `onFailure: "block"`」來避免 hook 默默放行。這和規格「Scoop shim 是 `.exe`」的前提相符。
5. **`.claude/rules` 的 `paths` frontmatter**
   - 已確認。`paths:` 是 glob 的 YAML 清單（2.1.84 起），支援 `{ts,tsx}`。展開數上限為 1,000 個 pattern 或 4 MiB（2.1.217 修正了展開過多時崩潰的問題）。
   - 在 Claude 用 Read、Write、Edit 處理符合的檔案時載入，用 Bash 的 `cat`、`head` 讀取單一檔案時也會載入。沒有 `paths` 的規則永遠載入。
   - `claude -p` 模式下的載入問題已於 2.1.69 修正。
6. **skill 的 `disable-model-invocation` 與 `` !`cmd` ``**
   - 兩者都已確認。`disable-model-invocation: true` 會讓 Claude 無法自行呼叫該 skill，只能由使用者用 `/name` 呼叫。
   - `` !`cmd` `` 會在 skill 內容送給 Claude 之前執行，並用輸出取代原本的位置。
   - 需要注意三件事：
     - (a) 注入的指令**不會跳出權限詢問**。非 auto 模式下，只要權限檢查結果不是 allow，**整個 skill 呼叫就會中止**。所以 `allowed-tools` 必須涵蓋 `<cli>` 指令，規格已有這一點。
     - (b) Windows 上預設 `shell: bash`：有 Git Bash 就用 Bash 工具執行，沒有就退回 PowerShell 工具。如果明確寫了 `shell: bash` 卻沒有 Git Bash，會直接失敗。
     - (c) 設定 `disableSkillShellExecution: true`（2.1.91 起，常見於 managed settings）會把注入的指令換成 `[shell command execution disabled by policy]`。

### 來源
- https://code.claude.com/docs/en/hooks （Block the action when a hook fails、Exec form and shell form、PostToolBatch、Stop input、PostToolUse decision control、output cap）
- https://code.claude.com/docs/en/skills （frontmatter、Inject dynamic context、Permission checks on injected commands、How injected commands run）
- https://code.claude.com/docs/en/memory （Path-specific rules）
- https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md （2.1.295 onFailure、2.1.139 args、2.1.143 stop cap、2.1.91 disableSkillShellExecution、2.1.84 paths list、2.1.217 brace budget、2.1.69 rules in -p）

### 建議的 SPEC.md 修改
§7.3 第一點改為：

> - **`.claude/settings.json` 的 hooks**：全部以 exec form 呼叫 `<cli>`。`SessionStart` 與 `PostToolUse` 設定 `onFailure: "block"`，需要 Claude Code ≥ 2.1.295。`Stop` 不設，因為官方說明該欄位對 `Stop` 無效。`Stop` 的 hook 失敗時由「`claude-last-seen` 檢查」補位。

「環境檢查」補上：`claude.minVersion` 的預設值至少為 `2.1.295`。

skill 段補上：`allowed-tools` 必須同時涵蓋 `Bash(<cli> *)` 與 `PowerShell(<cli> *)`，因為沒有 Git Bash 的 Windows 會改走 PowerShell。不寫 `shell: bash`。若組織設定了 `disableSkillShellExecution`，嵌入的內容會失效，skill 內文要指示 Claude 改為直接執行 `<cli> doctor`。

§13 第 8 項改為：「`PostToolBatch` 的最低版本在文件與 changelog 中都沒有記載，若要採用須實機確認。它的 block 會結束這一輪，不適合用來回饋」。
