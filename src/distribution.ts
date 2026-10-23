/** Where devguard itself is released: the exe attached to each GitHub Release (SPEC §3.1). */
export const CLI_RELEASES_URL = "https://github.com/lochaowei/devguard/releases/latest";

/**
 * How to get or update a tool the CLI calls from PATH rather than from the project (golangci-lint, SPEC §5.2).
 * The developer provides the binary; the CLI only checks its version.
 */
export function pathToolHint(tool: string, range?: string): string {
  return `把${range === undefined ? "預設標準指定版本" : `版本在 ${range} 內`}的 ${tool} binary 放進 PATH`;
}

/** How to get or update the CLI, for messages shown when it is missing or too old. */
export const CLI_INSTALL_HINT = `從 ${CLI_RELEASES_URL} 下載 devguard-windows-x64.exe，改名為 devguard.exe 並放進 PATH`;
