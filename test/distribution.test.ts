import { describe, expect, it } from "vitest";
import { CLI_INSTALL_HINT, cliInstallHint, releaseAssetName, releaseOs } from "../src/distribution.ts";

describe("releaseAssetName", () => {
  it("adds .exe only on Windows", () => {
    expect(releaseAssetName("windows", "x64")).toBe("devguard-windows-x64.exe");
    expect(releaseAssetName("linux", "arm64")).toBe("devguard-linux-arm64");
    expect(releaseAssetName("macos", "x64")).toBe("devguard-macos-x64");
  });

  it("takes another program name", () => {
    expect(releaseAssetName("linux", "x64", "t2-probe")).toBe("t2-probe-linux-x64");
  });
});

describe("releaseOs", () => {
  it("names darwin macos, and has nothing for platforms devguard is not released for", () => {
    expect([releaseOs("win32"), releaseOs("linux"), releaseOs("darwin"), releaseOs("freebsd")]).toEqual([
      "windows",
      "linux",
      "macos",
      undefined,
    ]);
  });
});

describe("cliInstallHint", () => {
  it("names the Windows exe and devguard.exe on Windows", () => {
    const hint = cliInstallHint("win32", "arm64");
    expect(hint).toContain("devguard-windows-arm64.exe");
    expect(hint).toContain("改名為 devguard.exe");
  });

  it("names the Linux and macOS executables and chmod +x elsewhere", () => {
    expect(cliInstallHint("linux", "x64")).toContain("下載 devguard-linux-x64，改名為 devguard、chmod +x");
    expect(cliInstallHint("darwin", "arm64")).toContain("下載 devguard-macos-arm64，");
  });

  it("falls back to the platform-neutral hint where no executable is released", () => {
    expect(cliInstallHint("freebsd", "x64")).toBe(CLI_INSTALL_HINT);
    expect(cliInstallHint("linux", "ia32")).toBe(CLI_INSTALL_HINT);
  });

  it("keeps the neutral hint free of single quotes, since hook lines echo it inside them", () => {
    expect(CLI_INSTALL_HINT).not.toContain("'");
  });
});
