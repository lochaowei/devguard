import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.ts";
import { claudeCodeCheck } from "../src/environment/claude-code.ts";
import { nodeExec, type Exec } from "../src/process/exec.ts";
import { rules, TODAY } from "./helpers.ts";
import { isolateGit } from "./git-isolation.ts";

// Real git runs here: keep it off any repo or config outside this file's temp directories.
isolateGit();

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DECL = "standard: team@1.0.0\ncomponents: []\n";
const SETUP = {
  ".claude/settings.json": JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "devguard", args: ["hook", "claude-stop"] }] }] },
  }),
};

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-claude-env-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [name, text] of Object.entries({ ".devguard.yaml": DECL, ...files })) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

/** `claude --version` answers with the given text (or is missing); git is real. */
function claude(version: string | undefined): Exec & { asked: string[] } {
  const asked: string[] = [];
  const exec: Exec = (command) => {
    if (!/^claude(\.cmd)?$/.test(command.file)) return nodeExec(command);
    asked.push(command.file);
    if (version === undefined)
      return Promise.reject(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }));
    return Promise.resolve({ code: 0, stdout: `${version} (Claude Code)\n`, stderr: "" });
  };
  return Object.assign(exec, { asked });
}

async function environment(dir: string, exec: Exec) {
  const { findings } = await runDoctor({
    cwd: dir,
    today: TODAY,
    checks: [claudeCodeCheck],
    exec,
    listFiles: () => Promise.resolve([]),
  });
  return findings.filter((f) => f.layer === "environment");
}

describe("doctor: Claude Code environment (SPEC §7.3)", () => {
  it("says nothing for a project without devguard's Claude Code setup", async () => {
    const exec = claude("2.1.0");
    expect(await environment(repo({}), exec)).toEqual([]);
    expect(exec.asked).toEqual([]);
  });

  it("reports a Claude Code older than claude.minVersion as an error", async () => {
    const dir = repo({ ...SETUP, ".git/devguard/claude-last-seen": "x\n" });
    const findings = await environment(dir, claude("2.1.200"));
    expect(rules(findings)).toEqual(["error:environment/claude-version"]);
    expect(findings[0]?.message).toContain("2.1.295");
    expect(findings[0]?.message).toContain("2.1.200");
  });

  it("passes once the version is new enough and the hooks have run", async () => {
    const dir = repo({ ...SETUP, ".git/devguard/claude-last-seen": "x\n" });
    expect(await environment(dir, claude("2.1.309"))).toEqual([]);
  });

  it("hints that the hooks may never have run, or the folder is not trusted, without claude-last-seen", async () => {
    const findings = await environment(repo(SETUP), claude("2.1.309"));
    expect(rules(findings)).toEqual(["hint:environment/claude-never-ran"]);
    expect(findings[0]?.message).toContain("尚未信任此資料夾");
  });

  it("still accepts claude-last-seen where earlier versions wrote it (.git/standards-guard/)", async () => {
    const dir = repo({ ...SETUP, ".git/standards-guard/claude-last-seen": "x\n" });
    expect(await environment(dir, claude("2.1.309"))).toEqual([]);
  });

  it("hints when the claude command is not found", async () => {
    const dir = repo({ ...SETUP, ".git/devguard/claude-last-seen": "x\n" });
    expect(rules(await environment(dir, claude(undefined)))).toEqual(["hint:environment/claude-missing"]);
  });
});
