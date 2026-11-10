/**
 * Items devguard no longer acts on (#64): the internal mirrors and the vulnerability scans. team@1.3.0 drops them;
 * older bundled standards still define them, but no check reads them. A declaration that sets one gets a hint, not an
 * error, whatever its standard version, so nobody believes a mirror or a scan is still enforced.
 */
export const RETIRED_ITEMS = {
  global: [
    "mirrors.auth",
    "mirrors.pypi",
    "mirrors.npm",
    "mirrors.go",
    "mirrors.gosumdb",
    "mirrors.govulndb",
    "mirrors.osv",
    "mirrors.maven",
    "mirrors.nvd",
    "mirrors.tools",
    "mirrors.vscode",
  ],
  /** In every language that has them (only Go has `tools.govulncheck`). */
  language: [
    "deps.vulnScan",
    "deps.vulnFailOn",
    "deps.ignoredVulns",
    "tools.govulncheck",
    "tools.checkstyle",
    "tools.maven-checkstyle-plugin",
  ],
} as const;

const CHECKSTYLE_REMOVED = "Checkstyle 已從 Java 檢查移除（#193），devguard 不再產生、要求或執行它";

/** Why a retired item does nothing, for the ones whose reason is not the mirrors / vulnerability scans one. */
const RETIRED_NOTES: Readonly<Record<string, string>> = {
  "tools.checkstyle": `${CHECKSTYLE_REMOVED}，這一項沒有作用`,
  "tools.maven-checkstyle-plugin": `${CHECKSTYLE_REMOVED}，這一項沒有作用`,
};

/** The hint for a declaration that sets a retired item. */
export const retiredMessage = (key: string): string =>
  `「${key}」${RETIRED_NOTES[key] ?? "沒有作用：devguard 不再檢查內部鏡像，也不再執行弱點掃描"}`;

/**
 * Values an item used to allow that no bundled standard offers any more. Java's `lint.tool` and `lint.rules` named
 * Checkstyle (#193); they are PMD only now. A declaration that still sets the old value gets a hint, not an error.
 */
const RETIRED_VALUES: Readonly<Record<string, (value: unknown) => boolean>> = {
  "lint.tool": (value) => value === "checkstyle+pmd",
  "lint.rules": (value) => Array.isArray(value) && value.includes("google_checks"),
};

export const isRetiredValue = (key: string, value: unknown): boolean => RETIRED_VALUES[key]?.(value) ?? false;

export const retiredValueMessage = (key: string): string =>
  `「${key}」寫的是 Checkstyle 時期的值：${CHECKSTYLE_REMOVED}，Java 的靜態分析現在只有 PMD`;

export const isRetired = (scope: "global" | "language", key: string): boolean =>
  (RETIRED_ITEMS[scope] as readonly string[]).includes(key);
