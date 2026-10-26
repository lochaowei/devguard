import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeExec, toSpawnSpec } from "../src/process/exec.ts";

describe("toSpawnSpec", () => {
  it("starts executables directly", () => {
    expect(toSpawnSpec({ file: "uv", args: ["run", "ruff"], cwd: "C:\\p" })).toEqual({
      file: "uv",
      args: ["run", "ruff"],
      cwd: "C:\\p",
    });
  });

  it("runs .cmd and .bat files through cmd.exe /d /s /c", () => {
    expect(toSpawnSpec({ file: "C:\\p\\node_modules\\.bin\\eslint.cmd", args: ["src", "a b"], cwd: "C:\\p" })).toEqual({
      file: "cmd.exe",
      args: ["/d", "/s", "/c", '""C:\\p\\node_modules\\.bin\\eslint.cmd" "src" "a b""'],
      cwd: "C:\\p",
      windowsVerbatimArguments: true,
    });
    expect(toSpawnSpec({ file: "gradlew.BAT", args: ["check", "x&y"], cwd: "C:\\p" }).args).toEqual([
      "/d",
      "/s",
      "/c",
      '""gradlew.BAT" "check" "x&y""',
    ]);
  });

  it("refuses arguments that cmd.exe would alter", () => {
    expect(() => toSpawnSpec({ file: "x.cmd", args: ['say "hi"'], cwd: "." })).toThrow("cmd.exe");
  });

  it("keeps extra environment variables", () => {
    expect(toSpawnSpec({ file: "go", args: [], cwd: ".", env: { GOTOOLCHAIN: "local" } }).env).toEqual({
      GOTOOLCHAIN: "local",
    });
  });
});

describe("nodeExec", () => {
  it("captures exit code, stdout and stderr", async () => {
    const r = await nodeExec({
      file: process.execPath,
      args: ["-e", "process.stdout.write('out'); process.stderr.write(process.env.DG_X ?? ''); process.exit(3)"],
      cwd: process.cwd(),
      env: { DG_X: "env" },
    });
    expect(r).toEqual({ code: 3, stdout: "out", stderr: "env" });
  });

  it("leaves out the inherited variables named in unsetEnv and passes the rest on", async () => {
    process.env.DG_UNSET = "inherited";
    process.env.DG_KEPT = "kept";
    try {
      const r = await nodeExec({
        file: process.execPath,
        args: ["-e", "process.stdout.write(`${process.env.DG_UNSET ?? '-'} ${process.env.DG_KEPT ?? '-'}`)"],
        cwd: process.cwd(),
        unsetEnv: ["DG_UNSET"],
      });
      expect(r.stdout).toBe("- kept");
    } finally {
      delete process.env.DG_UNSET;
      delete process.env.DG_KEPT;
    }
  });

  it.skipIf(process.platform !== "win32")("unsets variables whatever their case on Windows", async () => {
    process.env.Dg_Mixed = "inherited";
    try {
      const r = await nodeExec({
        file: process.execPath,
        args: ["-e", "process.stdout.write(process.env.DG_MIXED ?? '-')"],
        cwd: process.cwd(),
        unsetEnv: ["DG_MIXED"],
      });
      expect(r.stdout).toBe("-");
    } finally {
      delete process.env.Dg_Mixed;
    }
  });

  it.skipIf(process.platform !== "win32")("runs a real .cmd file with arguments intact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devguard dir-"));
    try {
      writeFileSync(join(dir, "echo args.cmd"), "@echo [%1] [%2] [%3]\r\n");
      const r = await nodeExec({ file: join(dir, "echo args.cmd"), args: ["a b", "x&y", "plain"], cwd: dir });
      expect(r.stdout.trim()).toBe('["a b"] ["x&y"] ["plain"]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("feeds stdin when given, and closes it otherwise", async () => {
    const echo = "process.stdin.on('data', (d) => process.stdout.write(d)).on('end', () => process.stdout.write('|'))";
    const run = (stdin?: string) =>
      nodeExec({
        file: process.execPath,
        args: ["-e", echo],
        cwd: process.cwd(),
        ...(stdin === undefined ? {} : { stdin }),
      });
    expect((await run("staged 版本")).stdout).toBe("staged 版本|");
    expect((await run()).stdout).toBe("|");
  });

  it("rejects arguments cmd.exe would alter instead of throwing", async () => {
    await expect(nodeExec({ file: "x.cmd", args: ["%PATH%"], cwd: "." })).rejects.toThrow("cmd.exe");
  });

  it("rejects with ENOENT when the program does not exist", async () => {
    await expect(nodeExec({ file: "devguard-no-such-program", args: [], cwd: process.cwd() })).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
