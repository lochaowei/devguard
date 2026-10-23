import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.ts";
import { createGitHooksCheck, type HookFrameworkProbe } from "../src/environment/git-hooks.ts";
import { renderHookFile, type GitHookName } from "../src/hooks/file.ts";
import { nodeExec, type Exec } from "../src/process/exec.ts";
import type { Finding } from "../src/report/finding.ts";
import { rules, TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DECL = "standard: team@1.0.0\ncomponents: []\n";

function repo(files: Record<string, string> = { ".devguard.yaml": DECL }, git = true): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-doctor-"));
  dirs.push(dir);
  if (git) execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const environment = (findings: Finding[]) => findings.filter((f) => f.layer === "environment");

describe("devguard doctor: check plus the environment layer (SPEC §3.2, §11)", () => {
  it("reports a missing pre-commit hook with the install command, alongside the check findings", async () => {
    const dir = repo({});
    const { findings } = await runDoctor({ cwd: dir, today: TODAY });
    expect(rules(findings)).toContain("error:declaration/missing");
    const hook = findings.find((f) => f.rule === "environment/hook-missing");
    expect(hook).toMatchObject({ level: "error", layer: "environment" });
    expect(hook?.fix).toContain("devguard install");
  });
});

describe("git hooks installed (SPEC §7.4)", () => {
  const PRE_COMMIT = ".git/hooks/pre-commit";

  it("passes with devguard's intact hook", async () => {
    const dir = repo({ ".devguard.yaml": DECL, [PRE_COMMIT]: renderHookFile("pre-commit") });
    expect(environment((await runDoctor({ cwd: dir, today: TODAY })).findings)).toEqual([]);
  });

  it("reports devguard's hook whose checksum no longer matches", async () => {
    const edited = renderHookFile("pre-commit").replace("exec devguard", "exec true || devguard");
    const dir = repo({ ".devguard.yaml": DECL, [PRE_COMMIT]: edited });
    const findings = environment((await runDoctor({ cwd: dir, today: TODAY })).findings);
    expect(rules(findings)).toEqual(["error:environment/hook-modified"]);
    expect(findings[0]?.fix).toContain("devguard install");
  });

  it("accepts a hand-written hook that calls devguard and reports one that does not", async () => {
    const calling = '#!/bin/sh\nnpm test\nexec devguard hook git-pre-commit "$@"\n';
    const ok = repo({ ".devguard.yaml": DECL, [PRE_COMMIT]: calling });
    expect(environment((await runDoctor({ cwd: ok, today: TODAY })).findings)).toEqual([]);

    const dir = repo({ ".devguard.yaml": DECL, [PRE_COMMIT]: "#!/bin/sh\nnpm test\n" });
    const [finding] = environment((await runDoctor({ cwd: dir, today: TODAY })).findings);
    expect(finding).toMatchObject({ level: "error", rule: "environment/hook-foreign" });
    expect(finding?.fix).toContain("devguard hook git-pre-commit");
  });
});

describe("an existing hook framework (SPEC §7.4 step 2)", () => {
  const husky =
    (missing: GitHookName[]): HookFrameworkProbe =>
    () =>
      Promise.resolve({ name: "husky", file: ".husky/pre-commit", missing });

  it("checks the framework's config for the devguard entry instead of the hook file", async () => {
    const dir = repo();
    const checks = [createGitHooksCheck({ framework: husky(["pre-commit"]) })];
    const findings = environment((await runDoctor({ cwd: dir, today: TODAY, checks })).findings);
    expect(rules(findings)).toEqual(["error:environment/framework-entry-missing"]);
    expect(findings[0]).toMatchObject({ file: ".husky/pre-commit", fix: "devguard install" });
  });

  it("passes when the framework calls devguard for every hook", async () => {
    const checks = [createGitHooksCheck({ framework: husky([]) })];
    expect(environment((await runDoctor({ cwd: repo(), today: TODAY, checks })).findings)).toEqual([]);
  });
});

/** Real git, except that reading `core.hooksPath` answers as if `git config --show-scope --show-origin` gave `line`. */
function gitConfigSays(line: string): Exec {
  return (command) =>
    command.file === "git" && command.args[0] === "config" && command.args.includes("core.hooksPath")
      ? Promise.resolve({ code: 0, stdout: `${line}\n`, stderr: "" })
      : nodeExec(command);
}

describe("core.hooksPath and where it is set (SPEC §7.4)", () => {
  it("finds the hooks under core.hooksPath", async () => {
    const dir = repo({ ".devguard.yaml": DECL, ".githooks/pre-commit": renderHookFile("pre-commit") });
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: dir });
    expect(environment((await runDoctor({ cwd: dir, today: TODAY })).findings)).toEqual([]);
  });

  it("reports core.hooksPath pointing at /dev/null, with where it is set", async () => {
    const dir = repo();
    execFileSync("git", ["config", "core.hooksPath", "/dev/null"], { cwd: dir });
    const findings = environment((await runDoctor({ cwd: dir, today: TODAY })).findings);
    expect(rules(findings)).toEqual(["error:environment/hooks-path-disabled"]);
    expect(findings[0]?.message).toContain(".git/config");
    expect(findings[0]?.fix).toContain("devguard install");
  });

  it("reports core.hooksPath pointing at a directory that does not exist", async () => {
    const dir = repo();
    execFileSync("git", ["config", "core.hooksPath", "no-such-dir"], { cwd: dir });
    const findings = environment((await runDoctor({ cwd: dir, today: TODAY })).findings);
    expect(rules(findings)).toEqual(["error:environment/hooks-path-missing"]);
    expect(findings[0]?.message).toContain("no-such-dir");
  });

  it("names the global config file when core.hooksPath is set there", async () => {
    const dir = repo();
    const exec = gitConfigSays("global\tfile:C:/Users/dev/.gitconfig\t/dev/null");
    const [finding] = environment((await runDoctor({ cwd: dir, today: TODAY, exec })).findings);
    expect(finding?.rule).toBe("environment/hooks-path-disabled");
    expect(finding?.message).toContain("global");
    expect(finding?.message).toContain("C:/Users/dev/.gitconfig");
  });
});
