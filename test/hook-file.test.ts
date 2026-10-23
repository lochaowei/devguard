import { describe, expect, it } from "vitest";
import { inspectHookFile, renderHookFile } from "../src/hooks/file.ts";

describe("git hook file (SPEC §7.4)", () => {
  it("is a POSIX sh script with one command line that calls the CLI", () => {
    const text = renderHookFile("pre-commit");
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    const commands = text.split("\n").filter((l) => l !== "" && !l.startsWith("#"));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('exec devguard hook git-pre-commit "$@"');
    expect(text).toContain("由 CLI 產生");
  });

  it("stops the commit with the install command and the --no-verify hint when the CLI is missing", () => {
    const line = renderHookFile("pre-commit")
      .split("\n")
      .find((l) => l.startsWith("command -v"));
    expect(line).toMatch(/^command -v devguard >\/dev\/null 2>&1 \|\| \{.*exit 1; \}/);
    expect(line).toContain("scoop install devguard");
    expect(line).toContain("--no-verify");
  });

  it("can call the CLI through another command (tests run `node src/cli.ts`)", () => {
    const text = renderHookFile("pre-commit", { command: 'node "C:/x y/src/cli.ts"' });
    expect(text).toContain("command -v node >/dev/null");
    expect(text).toContain('exec node "C:/x y/src/cli.ts" hook git-pre-commit "$@"');
  });

  it("carries the CLI marker and a checksum that inspection accepts", () => {
    const text = renderHookFile("pre-push");
    expect(text).toMatch(/^# devguard-hook pre-push sha256=[0-9a-f]{64}$/m);
    expect(inspectHookFile(text)).toEqual({ kind: "devguard", hook: "pre-push", intact: true });
  });

  it("detects a hand-edited hook by its checksum, also with CRLF line ends", () => {
    const text = renderHookFile("pre-commit");
    expect(inspectHookFile(text.replace("exec devguard", "exec true || devguard"))).toEqual({
      kind: "devguard",
      hook: "pre-commit",
      intact: false,
    });
    expect(inspectHookFile(text.replace(/\n/g, "\r\n")).kind).toBe("devguard");
  });

  it("calls a hook without the marker foreign", () => {
    expect(inspectHookFile("#!/bin/sh\nnpx lint-staged\n")).toEqual({ kind: "foreign" });
  });
});
