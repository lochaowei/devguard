import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { Interaction } from "../src/fix/interaction.ts";
import { frameworkEntry, planFrameworkHooks } from "../src/hooks/frameworks.ts";
import { runInstall } from "../src/hooks/install.ts";
import { TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-frameworks-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

function io(): Interaction & { out: string } {
  const result = {
    out: "",
    yes: true,
    interactive: false,
    write: (text: string) => {
      result.out += text;
    },
    confirm: () => Promise.resolve(false),
  };
  return result;
}

const DECL = "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: python\n";
const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");

const PRE_COMMIT_CONFIG = `# shared hooks
repos:
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.6.0 # pinned
    hooks:
      - id: ruff
`;

interface PreCommitHook {
  id: string;
  entry?: string;
  language?: string;
  stages?: string[];
  pass_filenames?: boolean;
}

describe("install into an existing hook framework (SPEC §7.4)", () => {
  it("pre-commit: adds a local `language: unsupported` hook and keeps comments and order", async () => {
    const dir = repo({ ".devguard.yaml": DECL, ".pre-commit-config.yaml": PRE_COMMIT_CONFIG });
    expect(await runInstall({ cwd: dir, today: TODAY, io: io() })).toBe(0);
    const text = read(dir, ".pre-commit-config.yaml");
    expect(text.startsWith(PRE_COMMIT_CONFIG.trimEnd())).toBe(true);
    const config = parse(text) as { repos: { repo: string; hooks: PreCommitHook[] }[] };
    const local = config.repos.find((r) => r.repo === "local");
    const commit = local?.hooks.find((h) => h.entry === "devguard hook git-pre-commit");
    expect(commit).toMatchObject({ language: "unsupported", pass_filenames: false, stages: ["pre-commit"] });
    expect(existsSync(join(dir, ".git/hooks/pre-commit"))).toBe(false);
  });

  it("pre-commit: running install again injects nothing more", async () => {
    const dir = repo({ ".devguard.yaml": DECL, ".pre-commit-config.yaml": PRE_COMMIT_CONFIG });
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    const once = read(dir, ".pre-commit-config.yaml");
    const again = io();
    await runInstall({ cwd: dir, today: TODAY, io: again });
    expect(read(dir, ".pre-commit-config.yaml")).toBe(once);
    expect(again.out).not.toContain(".pre-commit-config.yaml：");
  });

  it("husky: appends one line to .husky/pre-commit, once", async () => {
    const dir = repo({ ".devguard.yaml": DECL, ".husky/pre-commit": "npx lint-staged\n" });
    execFileSync("git", ["config", "core.hooksPath", ".husky/_"], { cwd: dir });
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    const lines = read(dir, ".husky/pre-commit").trimEnd().split("\n");
    expect(lines[0]).toBe("npx lint-staged");
    expect(lines.slice(1)).toHaveLength(1);
    expect(lines[1]).toContain('devguard hook git-pre-commit "$@"');
    expect(lines[1]).toContain("github.com/lochaowei/devguard/releases");
    expect(existsSync(join(dir, ".husky/_/pre-commit"))).toBe(false);
  });

  it("lefthook: adds a job to the hook's jobs, once, keeping comments", async () => {
    const config =
      "# team hooks\npre-commit:\n  jobs:\n    - name: eslint # js\n      run: npx eslint {staged_files}\n";
    const dir = repo({ ".devguard.yaml": DECL, "lefthook.yml": config });
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    const text = read(dir, "lefthook.yml");
    expect(text).toContain("- name: eslint # js");
    const jobs = (parse(text) as { "pre-commit": { jobs: { name: string; run: string }[] } })["pre-commit"].jobs;
    expect(jobs).toEqual([
      { name: "eslint", run: "npx eslint {staged_files}" },
      { name: "devguard", run: "devguard hook git-pre-commit" },
    ]);
  });

  it("lefthook: follows a hook written with `commands`", async () => {
    const config = "pre-commit:\n  commands:\n    lint:\n      run: npm run lint\n";
    const dir = repo({ ".devguard.yaml": DECL, ".lefthook.yaml": config });
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    const hook = (parse(read(dir, ".lefthook.yaml")) as { "pre-commit": { commands: Record<string, unknown> } })[
      "pre-commit"
    ];
    expect(hook.commands.devguard).toEqual({ run: "devguard hook git-pre-commit" });
  });
});

describe("core.hooksPath conflicts (SPEC §7.4)", () => {
  const install = async (dir: string, hooksPath?: string) => {
    if (hooksPath) execFileSync("git", ["config", "core.hooksPath", hooksPath], { cwd: dir });
    const out = io();
    await runInstall({ cwd: dir, today: TODAY, io: out });
    return out.out;
  };

  it("pre-commit with core.hooksPath set: reports the value and where it is set", async () => {
    const out = await install(
      repo({ ".devguard.yaml": DECL, ".pre-commit-config.yaml": PRE_COMMIT_CONFIG }),
      ".githooks",
    );
    expect(out).toContain("core.hooksPath 衝突");
    expect(out).toContain(".githooks");
    expect(out).toContain(".git/config");
    expect(out).toContain("pre-commit");
  });

  it("husky with core.hooksPath pointing elsewhere: reported", async () => {
    const out = await install(repo({ ".devguard.yaml": DECL, ".husky/pre-commit": "npx lint-staged\n" }), ".githooks");
    expect(out).toContain("core.hooksPath 衝突");
    expect(out).toContain(".husky/_");
  });

  it("husky without core.hooksPath: husky's hooks are not installed, reported", async () => {
    const out = await install(repo({ ".devguard.yaml": DECL, ".husky/pre-commit": "npx lint-staged\n" }));
    expect(out).toContain("core.hooksPath 衝突");
    expect(out).toContain("npx husky");
  });

  it("core.hooksPath set to /dev/null: reported even without a framework", async () => {
    const out = await install(repo({ ".devguard.yaml": DECL }), "/dev/null");
    expect(out).toContain("core.hooksPath 衝突");
    expect(out).toContain("/dev/null");
  });

  it("no conflict for husky's own hooks path, lefthook, or a plain hooks directory", async () => {
    const husky = await install(repo({ ".devguard.yaml": DECL, ".husky/pre-commit": "x\n" }), ".husky/_");
    const lefthook = await install(repo({ ".devguard.yaml": DECL, "lefthook.yml": "pre-commit: {}\n" }), ".githooks");
    const plain = await install(repo({ ".devguard.yaml": DECL }), ".githooks");
    for (const out of [husky, lefthook, plain]) expect(out).not.toContain("衝突");
  });
});

describe("frameworkEntry: whether the framework calls devguard (for doctor)", () => {
  it("undefined when the repo uses no framework", async () => {
    expect(await frameworkEntry(repo(), "pre-commit")).toBeUndefined();
  });

  it("names the framework and file, and whether the hook's entry is there", async () => {
    const dir = repo({ ".devguard.yaml": DECL, "lefthook.yml": "pre-commit:\n  jobs: []\n" });
    const file = "lefthook.yml";
    expect(await frameworkEntry(dir, "pre-commit")).toEqual({ framework: "lefthook", file, present: false });
    expect(await frameworkEntry(dir, "pre-push")).toEqual({ framework: "lefthook", file, present: false });
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    expect(await frameworkEntry(dir, "pre-commit")).toEqual({ framework: "lefthook", file, present: true });
    expect(await frameworkEntry(dir, "pre-push")).toEqual({ framework: "lefthook", file, present: true });
  });

  it.each([
    [
      "lefthook.toml",
      '[pre-commit]\n# keep\nparallel = true\n\n[[pre-commit.jobs]]\nname = "lint"\nrun = "npm run lint"\n',
    ],
    [".lefthook.json", '{\n  // keep\n  "pre-commit": { "jobs": [{ "name": "lint", "run": "npm run lint" }] }\n}\n'],
    [".config/lefthook.toml", ""],
  ])("lefthook in %s: detected, injected once, comments kept", async (file, config) => {
    const dir = repo({ ".devguard.yaml": DECL, [file]: config });
    expect(await frameworkEntry(dir, "pre-commit")).toEqual({ framework: "lefthook", file, present: false });
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    expect(await frameworkEntry(dir, "pre-commit")).toEqual({ framework: "lefthook", file, present: true });
    expect(await frameworkEntry(dir, "pre-push")).toEqual({ framework: "lefthook", file, present: true });
    const text = read(dir, file);
    if (config.includes("keep")) expect(text).toContain("keep");
    expect(text).toContain("devguard hook git-pre-commit");
    expect(existsSync(join(dir, ".git/hooks/pre-commit"))).toBe(false);
    const again = io();
    await runInstall({ cwd: dir, today: TODAY, io: again });
    expect(read(dir, file)).toBe(text);
  });

  it("husky: looks in the hook's own script", async () => {
    const dir = repo({ ".husky/pre-commit": "devguard hook git-pre-commit\n" });
    expect(await frameworkEntry(dir, "pre-commit")).toEqual({
      framework: "husky",
      file: ".husky/pre-commit",
      present: true,
    });
  });
});

describe("pre-push alongside pre-commit", () => {
  const both = ["pre-commit", "pre-push"] as const;

  it("pre-commit: one local hook per stage", async () => {
    const dir = repo({ ".pre-commit-config.yaml": PRE_COMMIT_CONFIG });
    const plan = await planFrameworkHooks(dir, { name: "pre-commit", file: ".pre-commit-config.yaml" }, both);
    expect(plan.writes).toHaveLength(1);
    const config = parse(plan.writes[0]?.after ?? "") as { repos: { hooks: PreCommitHook[] }[] };
    const ours = config.repos.flatMap((r) => r.hooks).filter((h) => h.id.startsWith("devguard"));
    expect(ours.map((h) => [h.entry, h.stages])).toEqual([
      ["devguard hook git-pre-commit", ["pre-commit"]],
      ["devguard hook git-pre-push", ["pre-push"]],
    ]);
  });

  it("husky: creates .husky/pre-push as an executable script", async () => {
    const dir = repo({ ".husky/pre-commit": "npx lint-staged\n" });
    const plan = await planFrameworkHooks(dir, { name: "husky", file: ".husky" }, both, "node cli.ts");
    const push = plan.writes.find((w) => w.file === ".husky/pre-push");
    expect(push).toMatchObject({ before: "", mode: 0o755 });
    expect(push?.after).toContain('node cli.ts hook git-pre-push "$@"');
  });

  it("lefthook: a job under each hook", async () => {
    const dir = repo({ "lefthook.yml": "pre-commit:\n  jobs: []\n" });
    const plan = await planFrameworkHooks(dir, { name: "lefthook", file: "lefthook.yml" }, both);
    const config = parse(plan.writes[0]?.after ?? "") as Record<string, { jobs: { run: string }[] }>;
    expect(config["pre-push"]?.jobs).toEqual([{ name: "devguard", run: "devguard hook git-pre-push" }]);
  });
});
