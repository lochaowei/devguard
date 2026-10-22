import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { viaCmd } from "../src/process/cmd-shim.ts";

const root = mkdtempSync(join(tmpdir(), "devguard-cmd-"));
const dir = join(root, "with space & amp");
mkdirSync(dir);
const script = join(dir, "echo args.cmd");
// Prints each argument on its own line, with quotes removed; delayed expansion keeps `&` and `|` literal.
writeFileSync(
  script,
  [
    "@echo off",
    "setlocal EnableDelayedExpansion",
    ":loop",
    'if "%~1"=="" goto end',
    'set "a=%~1"',
    "echo(!a!",
    "shift",
    "goto loop",
    ":end",
    "",
  ].join("\r\n"),
);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function runVia(args: string[]) {
  const c = viaCmd(script, args);
  return spawnSync(c.file, c.args, { encoding: "utf8", windowsVerbatimArguments: c.windowsVerbatimArguments });
}

describe.runIf(process.platform === "win32")("viaCmd", () => {
  it("runs a .cmd whose path contains spaces and cmd metacharacters", () => {
    const r = runVia(["plain"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("plain\r\n");
  });

  it("passes arguments with spaces and metacharacters through intact", () => {
    const r = runVia(["a b", "x&y", "p|q", "<lt>", "c^d"]);
    expect(r.stdout.split("\r\n").slice(0, -1)).toEqual(["a b", "x&y", "p|q", "<lt>", "c^d"]);
  });

  it("builds a cmd.exe /d /s /c command line", () => {
    expect(viaCmd("C:\\x\\npm.cmd", ["ci"])).toEqual({
      file: "cmd.exe",
      args: ["/d", "/s", "/c", '""C:\\x\\npm.cmd" "ci""'],
      windowsVerbatimArguments: true,
    });
  });

  it("refuses arguments cmd.exe cannot pass through literally", () => {
    expect(() => viaCmd(script, ["%PATH%"])).toThrow("cmd.exe");
    expect(() => viaCmd(script, ['say "hi"'])).toThrow("cmd.exe");
  });
});
