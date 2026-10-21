# 查證 A：TOML 保留格式修改函式庫、各工具帳密的環境變數引用

查證日期：2026-10-22。對應 SPEC.md §9.2、§10.3、§13 第 1、4 項。
資料來源以官方文件、npm registry metadata、上游原始碼為主。npm 版本與日期取自 `https://registry.npmjs.org/<pkg>`。

---

## 1. 能保留註解的 TOML 修改函式庫（§13 #1、§9.2）

**判定：✅ 確認（有可用的函式庫）**

| 套件 | 修改時保留註解／格式 | 最新版本（發佈日） | 維護狀態 | Bun／打包 |
|---|---|---|---|---|
| `@decimalturn/toml-patch` | **是**。README 原文：「Patch, parse, and stringify TOML (v1.1.0) while preserving comments, whitespace and formatting」。`patch(existing, obj)` 會比對差異，只改有變動的部分。刪除或重排項目時，同一行的尾註與緊貼在上方的註解會跟著該項目移動 | 3.3.1（2026-10-17） | 活躍。從 timhall/toml-patch fork 出來，現在已獨立發展，約 2,500 個 commit | 純 TS，無依賴，ESM，約 200 KB，MIT。官方沒有提到 Bun，但純 JS 沒有原生或 wasm 依賴，`bun build --compile` 理論上可直接打包（**未實測**） |
| `@shopify/toml-patch` | **是**。包裝 Rust 的 `toml_edit`（保留格式的編輯器），提供 `updateTomlValues(toml, [[path, value]])` | 0.3.0（2025-04-23） | 低頻更新，API 很小 | 用 wasm-pack 的 `--target nodejs` 建置，執行時從檔案系統讀取 `.wasm`。用 `bun --compile` 打包時要另外處理 wasm 的嵌入，有風險（**未實測**） |
| `toml-patch`（timhall 原版） | 是 | 0.2.3（2019-08-01） | 停止維護 | — |
| `toml-eslint-parser` | 只產生帶位置資訊的 AST，**沒有寫回功能**。要自己用 range 做文字替換 | 1.0.3（2026-01-16） | 活躍 | 純 JS |
| `smol-toml` | **否**。只提供 `parse`／`stringify`，註解在往返時會遺失 | 1.9.1（2026-10-09） | 活躍 | 純 JS |
| `@ltd/j-toml` | **否**。parse 不保留註解，無法往返 | 1.38.0（2023-01-16） | 近 3 年沒有發佈 | 純 JS |
| `@iarna/toml` | **否** | 2.2.5（2020-04-22） | 停止維護 | 純 JS |
| `@taplo/lib`／`@taplo/core` | 只有格式化與 lint，JS 端**沒有結構化修改 API** | 0.5.0／0.2.0（2024-02-01） | JS 套件很久沒更新 | wasm |

**建議**：採用 `@decimalturn/toml-patch`。實作時先寫一組往返測試（含註解、空行、inline table、`[[tool.uv.index]]` array of tables），在 `bun --compile` 產生的 exe 上驗證。如果測試失敗，退回「只印片段」。
**注意**：`patch()` 預設不改 key 的順序（`updateOrder` 預設關閉），符合 §9.2「保留順序」的要求。官方的 Comment-Ownership 文件寫有「current scope limitations」，實作前要讀過。

來源：
- https://github.com/DecimalTurn/toml-patch （README、`docs/Comment-Ownership.md`）
- https://registry.npmjs.org/@decimalturn/toml-patch
- https://registry.npmjs.org/@shopify/toml-patch （README）
- https://github.com/squirrelchat/smol-toml
- https://github.com/ota-meshi/toml-eslint-parser
- https://registry.npmjs.org/@ltd/j-toml 、https://registry.npmjs.org/@iarna/toml 、https://registry.npmjs.org/@taplo/lib

**建議的 SPEC 修改**：
- §9.2 表格「結構化的共用檔」的做法欄：把「TOML 用能保留格式的函式庫」改成「TOML 用 `@decimalturn/toml-patch`（`patch()`）」。
- §13 #1 改為：「`@decimalturn/toml-patch` 在 `bun --compile` 產物上的往返測試（註解、空行、`[[tool.uv.index]]`）；不通過時 `pyproject.toml` 改為只印片段」。

---

## 2. npm `.npmrc` 的環境變數替換與帳密（§13 #4a、§10.3）

**判定：⚠ 部分不同（方向正確，但 SPEC 的寫法不完整，且未定義變數時會出現陷阱）**

事實：
- 語法是 `${VARIABLE_NAME}`。官方文件原文：「By default if the variable is not defined, it is left unreplaced. By adding `?` after variable name they can be forced to evaluate to an empty string instead.」
  - 變數未定義時**不會報錯**，會保留字面上的 `${NEXUS_NPM_AUTH}`。這串字會被當成 base64 解碼，送出錯誤的帳密，結果是 401。
  - `${VAR?}` 會變成空字串。
  - 原始碼（`env-replace.js`）：正規式為 `/(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/g`，可以用 `\` 跳脫。
- `_auth`、`_authToken`、`username`、`_password`、`certfile`、`keyfile` **必須限定到特定 registry**，寫法是在 key 前面加上 URI 片段，例如 `//nexus.example.internal/repository/npm-proxy/:_auth=...`。
- 編碼規則（以 `@npmcli/config` 原始碼為準）：
  - `_auth` 是 base64 的 `username:password`。
  - `_password` 也是 **base64**。讀取時會做 `Buffer.from(passReg, 'base64')`，而且 `username` 和 `_password` 必須寫在同一個檔案。
  - `_authToken` 是 Bearer token，原樣送出。Nexus 端需要啟用 npm Bearer Token Realm。
  - 結論：沒辦法直接寫 `_password=${NEXUS_PASSWORD}` 搭配明文密碼。要嘛另外提供 base64 形式的變數，要嘛使用 `_auth`。

來源：
- https://docs.npmjs.com/cli/v11/configuring-npm/npmrc （"Environment variables"、"Auth related configuration"）
- https://github.com/npm/cli/blob/latest/workspaces/config/lib/env-replace.js
- https://github.com/npm/cli/blob/latest/workspaces/config/lib/index.js （getCredentialsByURI：`_password` 以 base64 解碼）

**建議的 SPEC 修改**（§10.3 表格的 npm 列）：
> npm：`.npmrc` 寫 `//nexus.example.internal/repository/npm-proxy/:_auth=${NEXUS_NPM_AUTH}`（`NEXUS_NPM_AUTH` 為 `username:password` 的 base64），或在 Nexus 啟用 Bearer Token Realm 後寫 `:_authToken=${NEXUS_NPM_TOKEN}`。變數未定義時，npm 會保留字面值而不報錯，所以 doctor 必須檢查變數是否存在。

另外，`mirrors.auth: env` 那句「統一使用 `NEXUS_USERNAME`、`NEXUS_PASSWORD`」與 npm 需要另一個 base64 變數互相矛盾，要明確寫出 npm 是例外（多一個 `NEXUS_NPM_AUTH`）。pnpm 與 yarn 的替換行為本次沒有查證。

---

## 3. uv 各 index 的帳密環境變數（§13 #4b、§10.3）

**判定：⚠ 部分不同（變數名稱正確，但前提條件與 netrc 位置要補充）**

事實：
- `UV_INDEX_<NAME>_USERNAME`、`UV_INDEX_<NAME>_PASSWORD`。`<NAME>` 的規則是「the uppercase version of the index name, with non-alphanumeric characters replaced by underscores」，例如 `internal-proxy` 變成 `INTERNAL_PROXY`。
- index 名稱只能包含英數字、`-`、`_`、`.`，而且必須是 ASCII。**`[[tool.uv.index]]` 必須寫 `name`**，環境變數才對得上。
- `default = true`：把 PyPI 排除在外，這個 index 的優先順序永遠最低。它跟帳密變數沒有衝突，只要它有 `name` 就適用。
- `authenticate = "always"`：讓 uv 主動找帳密，找不到時直接報錯，適合需要登入的 Nexus。
- 帳密的其他來源，依優先順序：URL 內嵌 → netrc → uv credentials store → keyring provider（預設關閉，只支援 `subprocess`，用 `UV_KEYRING_PROVIDER=subprocess` 或 `tool.uv.keyring-provider` 開啟）。
  - netrc 一律啟用，路徑讀 `NETRC`，未設定時用 `~/.netrc`。**和 Go 在 Windows 上預設的 `%USERPROFILE%\_netrc` 檔名不同**。
- 帳密**永遠不會寫進 `uv.lock`**。

來源：
- https://docs.astral.sh/uv/concepts/indexes/ （"Providing credentials directly"、"Using credentials from environment variables"、`default`、`authenticate`）
- https://docs.astral.sh/uv/concepts/authentication/http/ （netrc、keyring、credentials store）

**建議的 SPEC 修改**：
- §10.2 的 uv 列改為：「`[[tool.uv.index]]`（`name = "nexus"`、`default = true`）」。
- §10.3 的 uv 列改為：「`UV_INDEX_NEXUS_USERNAME`／`UV_INDEX_NEXUS_PASSWORD`（`<名稱>` 是 index `name` 轉大寫，非英數字元換成 `_`）；需要登入的專案加上 `authenticate = "always"`」。
- CLI 執行 uv 時可以把 `NEXUS_USERNAME/PASSWORD` 映射成這組變數再傳入，或在 doctor 提示開發者設定。

---

## 4. Maven、Gradle、Go（§13 #4c）

**判定：✅ 確認（Go 補充 `NETRC` 與 GOAUTH；Gradle 補充命名慣例）**

- **Maven**：settings.xml 支援用「`${env.HOME}` etc. for environment variables」做 interpolation。`<server><id>` 要和 `<mirror><id>` 一致，Maven 才會挑選對應的帳密。Maven 3.10／4.0 起，帳密會綁定到同 id 的 repo 或 mirror 的 origin（`maven.repository.credentialScope`）。所以 `.mvn/settings.xml` 寫 `<username>${env.NEXUS_USERNAME}</username>` 是正確的。
  來源：https://maven.apache.org/settings.html
- **Gradle**：`ORG_GRADLE_PROJECT_myProperty` 會成為 project property，官方說這是提供 secrets 的首選方式。`credentials(PasswordCredentials)` 搭配 repository `name = "nexus"` 時，會自動讀取 `nexusUsername`／`nexusPassword` 這兩個 property，因此對應的環境變數是 `ORG_GRADLE_PROJECT_nexusUsername`／`ORG_GRADLE_PROJECT_nexusPassword`。使用者層級的檔案是 `GRADLE_USER_HOME/gradle.properties`，預設為 `USER_HOME/.gradle`。
  來源：https://docs.gradle.org/current/userguide/build_environment.html 、https://docs.gradle.org/current/userguide/supported_repository_protocols.html
- **Go**：「If NETRC is not set, the go command will read $HOME/.netrc on UNIX-like platforms or %USERPROFILE%\_netrc on Windows.」
  - `machine` 只能寫主機名稱，不能寫完整 URL，所以同一台主機無法依路徑使用不同帳密。
  - 帳密只用在 HTTPS 請求。
  - Go 1.24 以上的 `GOAUTH` 預設使用 netrc，也可以改用 `git credential fill` 或自訂指令。
  - 也可以把帳密寫進 `GOPROXY` URL，但官方提醒會留在 shell history 和 log 裡。
  來源：https://go.dev/ref/mod （"Passing credentials to private proxies"）

**建議的 SPEC 修改**（§10.3 表格）：
- Gradle 列：「`settings.gradle` 的 repository 設 `name = "nexus"` + `credentials(PasswordCredentials)`，帳密來自 `ORG_GRADLE_PROJECT_nexusUsername`／`ORG_GRADLE_PROJECT_nexusPassword` 或 `~/.gradle/gradle.properties`」。
- Go 列：「`%USERPROFILE%\_netrc`（`NETRC` 有設定時以它為準；`machine` 只寫主機名稱；僅限 HTTPS）」。doctor 檢查檔案是否存在時要先看 `NETRC`。
- 如果同一台開發機也要讓 uv 使用 netrc，要注意 uv 預設讀 `~/.netrc` 而不是 `_netrc`。建議 uv 統一使用環境變數。
