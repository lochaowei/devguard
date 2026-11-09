/** Where devguard itself is released: the executables attached to each GitHub Release (SPEC §3.1). */
export const CLI_RELEASES_URL = "https://github.com/lochaowei/devguard/releases/latest";

/** The operating systems devguard is released for, as named in release assets. */
export type ReleaseOs = "windows" | "linux" | "macos";
export type ReleaseArch = "x64" | "arm64";

const RELEASE_OS: Partial<Record<NodeJS.Platform, ReleaseOs>> = { win32: "windows", linux: "linux", darwin: "macos" };

/** The release OS for a Node platform; undefined when devguard is not released for it. */
export function releaseOs(platform: NodeJS.Platform): ReleaseOs | undefined {
  return RELEASE_OS[platform];
}

/** The release asset for one OS and architecture: `devguard-<os>-<arch>`, with `.exe` on Windows. */
export function releaseAssetName(os: ReleaseOs, arch: ReleaseArch, name = "devguard"): string {
  return `${name}-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
}

/**
 * How to get or update a tool the CLI calls from PATH rather than from the project (golangci-lint, SPEC §5.2).
 * The developer provides the binary; the CLI only checks its version.
 */
export function pathToolHint(tool: string, range?: string): string {
  return `把${range === undefined ? "預設標準指定版本" : `版本在 ${range} 內`}的 ${tool} binary 放進 PATH`;
}

/** Where golangci-lint binaries are published, named in the hint shown when it is missing from PATH (#91). */
export const GOLANGCI_LINT_RELEASES_URL = "https://github.com/golangci/golangci-lint/releases";

/**
 * How to get or update the CLI on any platform. Used where the text lands in a file shared across machines (a git
 * hook line injected into husky or lefthook), so it must not depend on the machine that wrote it.
 */
export const CLI_INSTALL_HINT =
  `從 ${CLI_RELEASES_URL} 下載對應平台的執行檔（devguard-<windows|linux|macos>-<x64|arm64>），` +
  "改名為 devguard（Windows 為 devguard.exe）並放進 PATH";

/** How to get or update the CLI on this machine, for messages shown when it is missing or too old. */
export function cliInstallHint(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const os = releaseOs(platform);
  if (os === undefined || (arch !== "x64" && arch !== "arm64")) return CLI_INSTALL_HINT;
  const asset = `從 ${CLI_RELEASES_URL} 下載 ${releaseAssetName(os, arch)}`;
  return os === "windows"
    ? `${asset}，改名為 devguard.exe 並放進 PATH`
    : `${asset}，改名為 devguard、chmod +x 並放進 PATH`;
}
