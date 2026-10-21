# 預設標準：Java

Type: grilling
Status: resolved
Blocked by: 03, 07

## Question

Java 的預設標準是什麼？決定工具選型與各項門檻：style（checkstyle / spotless，採哪套規則）、靜態分析（PMD / SpotBugs）、complexity 上限、coverage 門檻（jacoco）、Maven / Gradle 兩者如何支援、dependency 規則（禁用清單、弱點掃描工具），以專案宣告格式寫下。

> 來自「預設標準：TypeScript」的備註：`.gitattributes` 的 `* text=auto eol=lf` 已訂為跨語言共用的修正項目（Spotless 預設依 `.gitattributes` 決定換行）。`deps.ignoredVulns` 四種語言共用，每一項都需要 `reason` 與 `until`。

## Answer

Java 預設標準（`team@1.0.0` 草案）。「類型」欄的定義見[專案宣告格式](07-project-declaration-format.md)與[預設標準：Python](08-default-standard-python.md)。

| 標準項目 | 預設值 | 類型 | 落地方式 |
|---|---|---|---|
| `java.minVersion` | `17`（新專案建議 21 以上，不強制） | 下限 | `maven.compiler.release` / Gradle toolchain |
| `build.tool` | `maven` 或 `gradle`，兩者皆可；必須提交 wrapper（`mvnw` / `gradlew`），CLI 一律透過 wrapper 呼叫 | 工具選擇 | — |
| `format.tool` | Spotless 搭配 `palantir-java-format`（4 空白縮排、行寬 120） | **風格** | `spotless:check` / `spotless:apply`；VS Code 提供一個呼叫 Spotless 的 task（IDE 內建格式化不保證一致） |
| `lint.tool` | `checkstyle+pmd` | 工具選擇 | — |
| `lint.rules` | Checkstyle：以 `google_checks.xml` 為基礎，移除格式類規則；PMD：quickstart 規則集 | 規則集（移除規則算放寬） | `checkstyle.xml`、PMD ruleset |
| `complexity.cyclomatic` | `10` | 上限 | Checkstyle `CyclomaticComplexity` |
| `complexity.cognitive` | `15` | 上限 | PMD `CognitiveComplexity` |
| `test.tool` | JUnit 5 | 工具選擇 | — |
| `coverage.lines` | `80`（JaCoCo，BUNDLE 層級，LINE 與 BRANCH 都要 0.80；排除 Lombok 產生的程式碼） | 下限 | `jacoco:check` rules；`lombok.addLombokGeneratedAnnotation = true` |
| `deps.lockfile` | Maven：Enforcer 禁止 SNAPSHOT 與版本範圍，並要求 `dependencyConvergence`；Gradle：啟用 dependency locking 並提交 `gradle.lockfile` | 布林 | Maven Enforcer / Gradle locking |
| `deps.vulnScan` | `false`（進階項目，預設關閉） | 布林 | 開啟後才套用以下兩項 |
| `deps.vulnFailOn` | CVSS 7（相當於 high） | 嚴重度 | OWASP Dependency-Check 的 `failBuildOnCVSS = 7`；必須指向公司內部的 NVD 鏡像 |
| `deps.ignoredVulns` | 空；每一項都要寫 `reason` 與 `until` | 新增項目算放寬 | CLI 產生 Dependency-Check 的 suppression 檔 |
| `deps.banned` | `log4j:log4j`、`junit:junit` | 禁用清單 | Maven Enforcer `bannedDependencies` / Gradle 對應設定 |
| `deps.bannedApis` | `sun.*` | 禁用清單 | Checkstyle `IllegalImport` |

**跨語言的決定**：公司環境不允許下載外部檔案，所以四種語言的弱點掃描都改為進階項目，預設關閉。所有工具與依賴都只能透過公司內部鏡像取得，CLI 本身不連外網。Python、Go、TypeScript 三張預設標準票已經加上修訂說明。NVD API key 由 CLI 以外的方式管理；開啟弱點掃描時，doctor 只檢查有沒有設定。
