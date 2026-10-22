import type { ItemDef, Standard } from "./types.ts";

// Draft values from SPEC §5–§6.

const cyclomatic: ItemDef = { kind: "max", label: "循環複雜度上限", value: 10 };
const cognitive: ItemDef = { kind: "max", label: "認知複雜度上限", value: 15 };
const coverage: ItemDef = { kind: "min", label: "覆蓋率門檻 (%)", value: 80 };
const lockfile: ItemDef = { kind: "bool", label: "必須有 lockfile", value: true };
const vulnScan: ItemDef = { kind: "bool", label: "弱點掃描（進階）", value: false };
const ignoredVulns: ItemDef = { kind: "ignoredVulns", label: "忽略的弱點", value: [] };
const bannedApisEmpty: ItemDef = { kind: "list", label: "禁用 API", value: [] };

const mirror = (label: string, value: string): ItemDef => ({ kind: "style", label, value });

/**
 * TODO(SPEC §12 item 5): PLACEHOLDER tool version ranges. The team has not set the real ranges, nor the exact
 * golangci-lint version, for team@1.0.0 yet. These only bracket the current major/minor lines so the check can run;
 * replace every `placeholderRange` with the agreed range before releasing team@1.0.0 (see README「工具版本範圍」).
 */
const placeholderRange = (tool: string, range: string, pinnedAs: readonly string[] = [tool]): ItemDef => ({
  kind: "versionRange",
  label: `${tool} 版本範圍`,
  value: range,
  pinnedAs,
});

const pythonTools: Record<string, ItemDef> = {
  "tools.ruff": placeholderRange("ruff", ">=0.17,<0.18"),
  "tools.mypy": placeholderRange("mypy", ">=1.18,<2"),
  "tools.pyright": placeholderRange("pyright", ">=1.1.400,<1.2"),
  "tools.pytest": placeholderRange("pytest", ">=8,<10"),
  "tools.pytest-cov": placeholderRange("pytest-cov", ">=6,<8"),
};

const typescriptTools: Record<string, ItemDef> = {
  "tools.eslint": placeholderRange("eslint", ">=10,<11"),
  "tools.prettier": placeholderRange("prettier", ">=3,<4"),
  "tools.typescript": placeholderRange("typescript", ">=6,<7"),
  "tools.typescript-eslint": placeholderRange("typescript-eslint", ">=8,<9"),
  "tools.eslint-plugin-sonarjs": placeholderRange("eslint-plugin-sonarjs", ">=3,<4"),
  "tools.biome": placeholderRange("biome", ">=2,<3", ["@biomejs/biome"]),
  "tools.vitest": placeholderRange("vitest", ">=5,<6"),
  "tools.jest": placeholderRange("jest", ">=30,<31"),
};

const goTools: Record<string, ItemDef> = {
  // SPEC §5.2 exception: an exact binary from the internal Scoop bucket, checked on PATH. ≥2.12 for gomodguard_v2.
  "tools.golangci-lint": { ...placeholderRange("golangci-lint", ">=2.12,<3", []), onPath: true },
  "tools.gofumpt": placeholderRange("gofumpt", ">=0.9,<1", ["mvdan.cc/gofumpt"]),
  "tools.goimports": placeholderRange("goimports", ">=0.38,<1", ["golang.org/x/tools/cmd/goimports"]),
  "tools.govulncheck": placeholderRange("govulncheck", ">=1.1,<2", ["golang.org/x/vuln/cmd/govulncheck"]),
};

const javaTools: Record<string, ItemDef> = {
  "tools.maven-checkstyle-plugin": placeholderRange("maven-checkstyle-plugin", ">=3.6,<4"),
  "tools.maven-pmd-plugin": placeholderRange("maven-pmd-plugin", ">=3.26,<4"),
  "tools.spotless-maven-plugin": placeholderRange("spotless-maven-plugin", ">=2.44,<3"),
  "tools.jacoco-maven-plugin": placeholderRange("jacoco-maven-plugin", ">=0.8.12,<0.9"),
  "tools.maven-enforcer-plugin": placeholderRange("maven-enforcer-plugin", ">=3.5,<4"),
  "tools.spotless-gradle-plugin": placeholderRange("spotless-gradle-plugin", ">=7,<8", ["com.diffplug.spotless"]),
  // Gradle's built-in plugins pin the tool itself through `toolVersion`.
  "tools.checkstyle": placeholderRange("checkstyle", ">=10.21,<11"),
  "tools.pmd": placeholderRange("pmd", ">=7,<8"),
  "tools.jacoco": placeholderRange("jacoco", ">=0.8.12,<0.9"),
};

export const team_1_0_0: Standard = {
  id: "team@1.0.0",
  global: {
    "claude.minVersion": { kind: "minVersion", label: "Claude Code 最低版本", value: "2.1.295" },
    "mirrors.auth": { kind: "choice", label: "鏡像帳密模式", value: "none", allowed: ["none", "env"] },
    "mirrors.pypi": mirror("PyPI 鏡像", "https://nexus.example.internal/repository/pypi-proxy/simple"),
    "mirrors.npm": mirror("npm 鏡像", "https://nexus.example.internal/repository/npm-proxy/"),
    "mirrors.go": mirror("Go 鏡像", "https://nexus.example.internal/repository/go-proxy/"),
    "mirrors.gosumdb": mirror("Go checksum 資料庫鏡像", "https://nexus.example.internal/repository/go-sumdb-proxy/"),
    "mirrors.govulndb": mirror("Go 弱點資料庫鏡像", "https://nexus.example.internal/repository/go-vulndb-proxy/"),
    "mirrors.maven": mirror("Maven 鏡像", "https://nexus.example.internal/repository/maven-public/"),
    "mirrors.tools": mirror("工具 binary 來源", "https://nexus.example.internal/repository/raw-tools/"),
    "mirrors.vscode": mirror("VS Code 內部 marketplace", "https://vsmarketplace.example.internal"),
  },
  languages: {
    python: {
      "python.minVersion": { kind: "minVersion", label: "Python 最低版本", value: "3.11" },
      "lint.tool": { kind: "choice", label: "Lint / Format 工具", value: "ruff", allowed: ["ruff"] },
      "lint.rules": {
        kind: "list",
        label: "Ruff 規則組",
        value: ["E", "W", "F", "I", "B", "UP", "C90", "SIM", "N", "S", "TID"],
      },
      "format.lineLength": { kind: "style", label: "行寬", value: 120 },
      "complexity.cyclomatic": cyclomatic,
      "typecheck.tool": { kind: "choice", label: "型別檢查工具", value: "mypy", allowed: ["mypy", "pyright"] },
      "typecheck.strict": { kind: "bool", label: "型別檢查嚴格模式", value: true },
      "test.tool": { kind: "choice", label: "測試工具", value: "pytest", allowed: ["pytest"] },
      "coverage.lines": coverage,
      "deps.manager": { kind: "choice", label: "套件管理工具", value: "uv", allowed: ["uv", "poetry"] },
      "deps.lockfile": lockfile,
      "deps.vulnScan": vulnScan,
      "deps.vulnFailOn": { kind: "severity", label: "弱點掃描門檻", value: "any" },
      "deps.ignoredVulns": ignoredVulns,
      "deps.banned": { kind: "list", label: "禁用套件", value: ["pycrypto", "nose"] },
      "deps.bannedApis": bannedApisEmpty,
      ...pythonTools,
    },
    go: {
      "go.minVersion": { kind: "minVersion", label: "Go 最低版本", value: "1.26" },
      "lint.tool": { kind: "choice", label: "Lint 工具", value: "golangci-lint", allowed: ["golangci-lint"] },
      "lint.rules": {
        kind: "list",
        label: "golangci-lint linters",
        value: [
          "errcheck",
          "govet",
          "ineffassign",
          "staticcheck",
          "unused",
          "gosec",
          "revive",
          "errorlint",
          "bodyclose",
          "misspell",
          "cyclop",
          "gocognit",
          "gomodguard_v2",
          "depguard",
        ],
      },
      "format.tools": { kind: "style", label: "格式化工具", value: ["gofumpt", "goimports"] },
      "complexity.cyclomatic": cyclomatic,
      "complexity.cognitive": cognitive,
      "coverage.lines": coverage,
      "deps.lockfile": lockfile,
      "deps.vulnScan": vulnScan,
      "deps.vulnFailOn": { kind: "severity", label: "弱點掃描門檻", value: "any" },
      "deps.ignoredVulns": ignoredVulns,
      "deps.banned": {
        kind: "list",
        label: "禁用模組",
        value: ["github.com/pkg/errors", "github.com/golang/protobuf"],
      },
      "deps.bannedApis": { kind: "list", label: "禁用套件 import", value: ["io/ioutil"] },
      ...goTools,
    },
    typescript: {
      "node.minVersion": { kind: "minVersion", label: "Node 最低版本", value: "22" },
      "lint.tool": {
        kind: "choice",
        label: "Lint / Format 工具",
        value: "eslint+prettier",
        allowed: ["eslint+prettier", "biome"],
      },
      "lint.rules": { kind: "list", label: "ESLint 規則集", value: ["typescript-eslint/strictTypeChecked"] },
      "format.printWidth": { kind: "style", label: "行寬", value: 120 },
      "format.endOfLine": { kind: "style", label: "換行字元", value: "lf" },
      "typecheck.strict": { kind: "bool", label: "tsconfig strict", value: true },
      "typecheck.options": {
        kind: "list",
        label: "額外的 tsconfig 檢查",
        value: ["noUncheckedIndexedAccess", "noImplicitOverride", "noFallthroughCasesInSwitch"],
      },
      "complexity.cyclomatic": cyclomatic,
      "complexity.cognitive": cognitive,
      "test.tool": { kind: "choice", label: "測試工具", value: "vitest", allowed: ["vitest", "jest"] },
      "coverage.lines": coverage,
      "deps.manager": { kind: "choice", label: "套件管理工具", value: "npm", allowed: ["npm", "pnpm", "yarn"] },
      "deps.lockfile": lockfile,
      "deps.vulnScan": vulnScan,
      "deps.vulnFailOn": { kind: "severity", label: "弱點掃描門檻", value: "high" },
      "deps.ignoredVulns": ignoredVulns,
      "deps.banned": { kind: "list", label: "禁用套件", value: ["moment", "request", "node-fetch"] },
      "deps.bannedApis": bannedApisEmpty,
      ...typescriptTools,
    },
    java: {
      "java.minVersion": { kind: "minVersion", label: "Java 最低版本", value: "17" },
      "build.tool": { kind: "choice", label: "建置工具", value: "maven", allowed: ["maven", "gradle"] },
      "format.tool": { kind: "style", label: "格式化工具", value: "palantir-java-format" },
      "lint.tool": { kind: "choice", label: "靜態分析工具", value: "checkstyle+pmd", allowed: ["checkstyle+pmd"] },
      "lint.rules": { kind: "list", label: "規則集", value: ["google_checks", "pmd-quickstart"] },
      "complexity.cyclomatic": cyclomatic,
      "complexity.cognitive": cognitive,
      "test.tool": { kind: "choice", label: "測試框架", value: "junit5", allowed: ["junit5"] },
      "coverage.lines": coverage,
      "deps.lockfile": lockfile,
      "deps.vulnScan": vulnScan,
      "deps.vulnFailOn": { kind: "severity", label: "弱點掃描門檻", value: "high" },
      "deps.ignoredVulns": ignoredVulns,
      "deps.banned": { kind: "list", label: "禁用套件", value: ["log4j:log4j", "junit:junit"] },
      "deps.bannedApis": { kind: "list", label: "禁用 API", value: ["sun.*"] },
      ...javaTools,
    },
  },
};
