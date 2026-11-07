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
  language: ["deps.vulnScan", "deps.vulnFailOn", "deps.ignoredVulns", "tools.govulncheck"],
} as const;

export const isRetired = (scope: "global" | "language", key: string): boolean =>
  (RETIRED_ITEMS[scope] as readonly string[]).includes(key);
