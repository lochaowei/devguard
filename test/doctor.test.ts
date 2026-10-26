import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.ts";
import { createGitHooksCheck, type FrameworkEntryProbe } from "../src/environment/git-hooks.ts";
import { renderHookFile, type GitHookName } from "../src/hooks/file.ts";
import { runInstall } from "../src/hooks/install.ts";
import { nodeExec, type Exec } from "../src/process/exec.ts";
import type { Finding } from "../src/report/finding.ts";
import { ToolMissingError, type ToolRunner } from "../src/tools/runner.ts";
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

/** A developer whose pushes run the full tests (SPEC §7.4): pre-push problems are errors. */
const FULL = { DEVGUARD_PRE_PUSH: "full" };

describe("devguard doctor: check plus the environment layer (SPEC §3.2, §11)", () => {
  it("reports a missing pre-commit hook with the install command, alongside the check findings", async () => {
    const dir = repo({});
    const { findings } = await runDoctor({ cwd: dir, today: TODAY });
    expect(rules(findings)).toContain("error:declaration/missing");
    const hook = findings.find((f) => f.rule === "environment/hook-missing");
    expect(hook).toMatchObject({ level: "error", layer: "environment" });
    expect(hook?.fix).toContain("devguard install");
  });

  it("reports a tool that is not installed as an error with the install command and still runs the environment checks (SPEC §7.3, §7.4)", async () => {
    const dir = repo({
      ".devguard.yaml": "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: python\n",
      "app.py": "x = 1\n",
    });
    const tools: ToolRunner = {
      run: () => Promise.reject(new ToolMissingError("找不到 ruff：專案環境（.venv）中沒有安裝", "uv sync")),
    };
    const { findings } = await runDoctor({
      cwd: dir,
      today: TODAY,
      tools,
      listFiles: () => Promise.resolve(["app.py"]),
    });
    const missing = findings.filter((f) => f.rule === "environment/tool-missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ level: "error", layer: "environment", fix: "uv sync" });
    expect(missing[0]?.message).toContain("找不到 ruff");
    expect(rules(findings)).toContain("error:environment/hook-missing");
  });
});

describe("git hooks installed (SPEC §7.4)", () => {
  /** A repo with devguard's intact pre-push hook and the given pre-commit hook. */
  const withPreCommit = (text: string) =>
    repo({ ".devguard.yaml": DECL, ".git/hooks/pre-push": renderHookFile("pre-push"), ".git/hooks/pre-commit": text });

  it("passes with devguard's intact hooks", async () => {
    const dir = withPreCommit(renderHookFile("pre-commit"));
    expect(environment((await runDoctor({ cwd: dir, today: TODAY })).findings)).toEqual([]);
  });

  it("reports devguard's hook whose checksum no longer matches", async () => {
    const dir = withPreCommit(renderHookFile("pre-commit").replace("exec devguard", "exec true || devguard"));
    const findings = environment((await runDoctor({ cwd: dir, today: TODAY })).findings);
    expect(rules(findings)).toEqual(["error:environment/hook-modified"]);
    expect(findings[0]?.fix).toContain("devguard install");
  });

  it("lists a missing pre-push hook only as a hint while pushes do not run the tests (DEVGUARD_PRE_PUSH unset)", async () => {
    const dir = repo({ ".devguard.yaml": DECL, ".git/hooks/pre-commit": renderHookFile("pre-commit") });
    const findings = environment((await runDoctor({ cwd: dir, today: TODAY, env: {} })).findings);
    expect(rules(findings)).toEqual(["hint:environment/hook-missing"]);
    expect(findings[0]?.message).toContain("DEVGUARD_PRE_PUSH=full");
    expect(findings[0]?.fix).toContain("devguard install");
  });

  it("reports a missing pre-push hook as an error when DEVGUARD_PRE_PUSH=full", async () => {
    const dir = repo({ ".devguard.yaml": DECL, ".git/hooks/pre-commit": renderHookFile("pre-commit") });
    const findings = environment((await runDoctor({ cwd: dir, today: TODAY, env: FULL })).findings);
    expect(rules(findings)).toEqual(["error:environment/hook-missing"]);
  });

  it("accepts a hand-written hook that calls devguard and reports one that does not", async () => {
    const ok = withPreCommit('#!/bin/sh\nnpm test\nexec devguard hook git-pre-commit "$@"\n');
    expect(environment((await runDoctor({ cwd: ok, today: TODAY })).findings)).toEqual([]);

    const dir = withPreCommit("#!/bin/sh\nnpm test\n");
    const [finding] = environment((await runDoctor({ cwd: dir, today: TODAY })).findings);
    expect(finding).toMatchObject({ level: "error", rule: "environment/hook-foreign" });
    expect(finding?.fix).toContain("devguard hook git-pre-commit");
  });
});

describe("an existing hook framework (SPEC §7.4 step 2)", () => {
  const lefthook =
    (missing: GitHookName[]): FrameworkEntryProbe =>
    (_cwd, hook) =>
      Promise.resolve({ framework: "lefthook", file: "lefthook.yml", present: !missing.includes(hook) });

  it("checks the framework's config for the devguard entry instead of the hook file", async () => {
    const checks = [createGitHooksCheck({ framework: lefthook(["pre-push"]) })];
    const findings = environment((await runDoctor({ cwd: repo(), today: TODAY, checks, env: FULL })).findings);
    expect(rules(findings)).toEqual(["error:environment/framework-entry-missing"]);
    expect(findings[0]).toMatchObject({ file: "lefthook.yml", fix: "devguard install" });
    expect(findings[0]?.message).toContain("pre-push");
  });

  it("lists a missing pre-push entry only as a hint while pushes do not run the tests", async () => {
    const checks = [createGitHooksCheck({ framework: lefthook(["pre-push"]) })];
    const findings = environment((await runDoctor({ cwd: repo(), today: TODAY, checks, env: {} })).findings);
    expect(rules(findings)).toEqual(["hint:environment/framework-entry-missing"]);
  });

  it("passes when the framework calls devguard for every hook", async () => {
    const checks = [createGitHooksCheck({ framework: lefthook([]) })];
    expect(environment((await runDoctor({ cwd: repo(), today: TODAY, checks })).findings)).toEqual([]);
  });

  it("reads a real husky setup: entries missing until install injects them", async () => {
    const dir = repo({ ".devguard.yaml": DECL, ".husky/pre-commit": "npm test\n", ".husky/_/h": "" });
    execFileSync("git", ["config", "core.hooksPath", ".husky/_"], { cwd: dir });
    const before = environment((await runDoctor({ cwd: dir, today: TODAY, env: FULL })).findings);
    expect(rules(before)).toEqual([
      "error:environment/framework-entry-missing",
      "error:environment/framework-entry-missing",
    ]);
    await runInstall({
      cwd: dir,
      today: TODAY,
      io: { yes: true, interactive: false, write: () => undefined, confirm: () => Promise.resolve(false) },
    });
    // install also writes the Claude Code setup; only the git hooks matter here.
    const after = await runDoctor({ cwd: dir, today: TODAY, checks: [createGitHooksCheck()] });
    expect(environment(after.findings)).toEqual([]);
  });

  it("pre-commit framework: reports hooks `pre-commit install` has not written yet", async () => {
    const dir = repo({ ".devguard.yaml": DECL, ".pre-commit-config.yaml": "repos: []\n" });
    const io = { yes: true, interactive: false, write: () => undefined, confirm: () => Promise.resolve(false) };
    await runInstall({ cwd: dir, today: TODAY, io });
    const checks = [createGitHooksCheck()];
    const before = environment((await runDoctor({ cwd: dir, today: TODAY, checks, env: FULL })).findings);
    expect(rules(before)).toEqual([
      "error:environment/framework-not-installed",
      "error:environment/framework-not-installed",
    ]);
    const optedOut = environment((await runDoctor({ cwd: dir, today: TODAY, checks, env: {} })).findings);
    expect(rules(optedOut)).toEqual([
      "error:environment/framework-not-installed",
      "hint:environment/framework-not-installed",
    ]);
    expect(before[1]?.fix).toBe("pre-commit install --hook-type pre-commit --hook-type pre-push");
    expect(before[1]?.message).toContain("pre-push");

    // What `pre-commit install --hook-type pre-commit --hook-type pre-push` writes (abridged).
    const generated = (hook: string) =>
      `#!/usr/bin/env bash\n# File generated by pre-commit: https://pre-commit.com\nARGS=(hook-impl --config=.pre-commit-config.yaml --hook-type=${hook})\n`;
    writeFileSync(join(dir, ".git/hooks/pre-commit"), generated("pre-commit"));
    writeFileSync(join(dir, ".git/hooks/pre-push"), generated("pre-push"));
    expect(environment((await runDoctor({ cwd: dir, today: TODAY, checks })).findings)).toEqual([]);
  });

  it("reports a core.hooksPath that conflicts with the framework", async () => {
    const dir = repo({ ".devguard.yaml": DECL, ".husky/pre-commit": "npm test\n" });
    const [finding] = environment((await runDoctor({ cwd: dir, today: TODAY })).findings);
    expect(finding).toMatchObject({ level: "error", rule: "environment/hooks-path-conflict" });
    expect(finding?.message).toContain("npx husky");
  });
});

/** Real git, except that reading `core.hooksPath` answers as if `git config --show-origin` gave `line`. */
function gitConfigSays(line: string): Exec {
  return (command) =>
    command.file === "git" && command.args[0] === "config" && command.args.includes("core.hooksPath")
      ? Promise.resolve({ code: 0, stdout: `${line}\n`, stderr: "" })
      : nodeExec(command);
}

describe("core.hooksPath and where it is set (SPEC §7.4)", () => {
  it("finds the hooks under core.hooksPath", async () => {
    const dir = repo({
      ".devguard.yaml": DECL,
      ".githooks/pre-commit": renderHookFile("pre-commit"),
      ".githooks/pre-push": renderHookFile("pre-push"),
    });
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
    const exec = gitConfigSays("file:C:/Users/dev/.gitconfig\t/dev/null");
    const [finding] = environment((await runDoctor({ cwd: dir, today: TODAY, exec })).findings);
    expect(finding?.rule).toBe("environment/hooks-path-disabled");
    expect(finding?.message).toContain("C:/Users/dev/.gitconfig");
    expect(finding?.fix).toContain('git config --file "C:/Users/dev/.gitconfig" --unset core.hooksPath');
  });
});
