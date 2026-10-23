/** Where devguard itself is released: the exe attached to each GitHub Release (SPEC §3.1). */
export const CLI_RELEASES_URL = "https://github.com/lochaowei/devguard/releases/latest";

/** How to get or update the CLI, for messages shown when it is missing or too old. */
export const CLI_INSTALL_HINT = `從 ${CLI_RELEASES_URL} 下載 devguard-windows-x64.exe，改名為 devguard.exe 並放進 PATH`;
