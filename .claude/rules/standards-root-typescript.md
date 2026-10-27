---
paths:
  - "**/*.{ts,tsx,mts,cts}"
---

<!-- 由 CLI 產生（devguard），請勿手動修改；執行 devguard fix 重新產生 -->

# ./ (TypeScript) 的標準（team@1.1.0）

修改這個元件的檔案時遵守以下標準。完成修改後執行 `devguard check` 確認；格式與可自動修正的 lint 用 `devguard fix --code <檔案>` 修正。

## 標準項目

- Node 最低版本（node.minVersion）：22
- Lint / Format 工具（lint.tool）：eslint+prettier
- ESLint 規則集（lint.rules）：typescript-eslint/strictTypeChecked
- 行寬（format.printWidth）：120
- 換行字元（format.endOfLine）：lf
- tsconfig strict（typecheck.strict）：true
- 額外的 tsconfig 檢查（typecheck.options）：noUncheckedIndexedAccess、noImplicitOverride、noFallthroughCasesInSwitch
- 循環複雜度上限（complexity.cyclomatic）：10
- 認知複雜度上限（complexity.cognitive）：15
- 測試工具（test.tool）：vitest
- 覆蓋率門檻 (%)（coverage.lines）：80
- 套件管理工具（deps.manager）：npm
- 必須有 lockfile（deps.lockfile）：true
- 弱點掃描（進階）（deps.vulnScan）：false
- 弱點掃描門檻（deps.vulnFailOn）：high
- 忽略的弱點（deps.ignoredVulns）：（無）
- 禁用套件（deps.banned）：moment、request、node-fetch
- 禁用 API（deps.bannedApis）：（無）
- eslint 版本範圍（tools.eslint）：>=10,<11
- prettier 版本範圍（tools.prettier）：>=3,<4
- typescript 版本範圍（tools.typescript）：>=6,<7
- typescript-eslint 版本範圍（tools.typescript-eslint）：>=8,<9
- biome 版本範圍（tools.biome）：>=2,<3
- vitest 版本範圍（tools.vitest）：>=4.1,<6
- jest 版本範圍（tools.jest）：>=30,<31

## 目前的偏離

（無）
