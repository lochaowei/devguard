import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Interaction } from "../src/fix/interaction.ts";
import { inspectHookFile } from "../src/hooks/file.ts";
import { runInstall } from "../src/hooks/install.ts";
import { runFix } from "../src/fix/run.ts";
import { lefthookWrote, TODAY } from "./helpers.ts";
import { isolateGit } from "./git-isolation.ts";

// Real git runs here: keep it off any repo or config outside this file's temp directories.
isolateGit();

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string> = {}, git = true): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-install-"));
  dirs.push(dir);
  if (git) execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

function io(yes = true): Interaction & { out: string } {
  const result = {
    out: "",
    yes,
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

describe("devguard install (SPEC §3.2, §7.4)", () => {
  it("installs .git/hooks/pre-commit with the CLI marker and checksum", async () => {
    const dir = repo({ ".devguard.yaml": DECL });
    const out = io();
    expect(await runInstall({ cwd: dir, today: TODAY, io: out })).toBe(0);
    const hook = read(dir, ".git/hooks/pre-commit");
    expect(inspectHookFile(hook)).toEqual({ kind: "devguard", hook: "pre-commit", intact: true });
    expect(hook).toContain("exec devguard hook git-pre-commit");
    expect(out.out).toContain(".git/hooks/pre-commit：新增");
  });

  it("generates the tool settings the standard asks for in the same run", async () => {
    const dir = repo({ ".devguard.yaml": DECL });
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    expect(read(dir, "pyproject.toml")).toContain("[tool.ruff]");
  });

  it("generates the VS Code workspace settings in the same run (SPEC §7.2)", async () => {
    const dir = repo({ ".devguard.yaml": DECL });
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    expect(read(dir, ".vscode/settings.json")).toContain('"ruff.importStrategy": "fromEnvironment"');
    expect(read(dir, ".vscode/extensions.json")).toContain("charliermarsh.ruff");
    expect(read(dir, ".vscode/tasks.json")).toContain("standards: doctor");
  });

  it("writes into core.hooksPath when it is set", async () => {
    const dir = repo({ ".devguard.yaml": DECL });
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: dir });
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    expect(inspectHookFile(read(dir, ".githooks/pre-commit")).kind).toBe("devguard");
    expect(existsSync(join(dir, ".git/hooks/pre-commit"))).toBe(false);
  });

  it("uses the given hook command", async () => {
    const dir = repo({ ".devguard.yaml": DECL });
    await runInstall({ cwd: dir, today: TODAY, io: io(), hookCommand: "node cli.ts" });
    expect(read(dir, ".git/hooks/pre-commit")).toContain("exec node cli.ts hook git-pre-commit");
  });

  it("regenerates a modified devguard hook and leaves an intact one alone", async () => {
    const dir = repo({ ".devguard.yaml": DECL });
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    const path = join(dir, ".git/hooks/pre-commit");
    const original = readFileSync(path, "utf8");
    writeFileSync(path, original.replace("exec devguard", "exec true || devguard"));
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    expect(readFileSync(path, "utf8")).toBe(original);
    const again = io();
    expect(await runInstall({ cwd: dir, today: TODAY, io: again })).toBe(0);
    expect(again.out).not.toContain("pre-commit");
  });

  it("devguard fix regenerates a modified devguard hook, keeping its command, but never installs one (SPEC §9.1)", async () => {
    const dir = repo({ ".devguard.yaml": DECL });
    const command = 'node "C:/x/cli.ts"';
    await runInstall({ cwd: dir, today: TODAY, io: io(), hookCommand: command });
    const path = join(dir, ".git/hooks/pre-commit");
    const original = readFileSync(path, "utf8");
    writeFileSync(path, original.replace("# devguard-hook", "echo hi\n# devguard-hook"));
    const out = io();
    expect(await runFix({ cwd: dir, today: TODAY, io: out })).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(out.out).toContain(".git/hooks/pre-commit");

    const fresh = repo({ ".devguard.yaml": DECL });
    await runFix({ cwd: fresh, today: TODAY, io: io() });
    expect(existsSync(join(fresh, ".git/hooks/pre-commit"))).toBe(false);
  });

  it("also installs .git/hooks/pre-push with the CLI marker and checksum", async () => {
    const dir = repo({ ".devguard.yaml": DECL });
    const out = io();
    await runInstall({ cwd: dir, today: TODAY, io: out });
    const hook = read(dir, ".git/hooks/pre-push");
    expect(inspectHookFile(hook)).toEqual({ kind: "devguard", hook: "pre-push", intact: true });
    expect(hook).toContain("exec devguard hook git-pre-push");
    expect(out.out).toContain(".git/hooks/pre-push：新增");
  });

  it("does not overwrite a hook devguard did not write, and prints the line to add", async () => {
    const dir = repo({ ".devguard.yaml": DECL, ".git/hooks/pre-commit": "#!/bin/sh\nnpx lint-staged\n" });
    const out = io();
    await runInstall({ cwd: dir, today: TODAY, io: out });
    expect(read(dir, ".git/hooks/pre-commit")).toBe("#!/bin/sh\nnpx lint-staged\n");
    expect(out.out).toContain("不是 devguard 產生的");
    expect(out.out).toContain("devguard hook git-pre-commit");
  });

  it("only previews without --yes in a non-interactive run", async () => {
    const dir = repo({ ".devguard.yaml": DECL });
    expect(await runInstall({ cwd: dir, today: TODAY, io: io(false) })).toBe(1);
    expect(existsSync(join(dir, ".git/hooks/pre-commit"))).toBe(false);
  });

  describe("pre-commit framework: the next step when `pre-commit install` has not run (#70)", () => {
    const COMMAND = "pre-commit install --hook-type pre-commit --hook-type pre-push";
    // What `pre-commit install --hook-type pre-commit --hook-type pre-push` writes (abridged).
    const generated = (hook: string) =>
      `#!/usr/bin/env bash\n# File generated by pre-commit: https://pre-commit.com\nARGS=(hook-impl --config=.pre-commit-config.yaml --hook-type=${hook})\n`;

    it("prints the command when applying, without changing the exit code", async () => {
      const dir = repo({ ".devguard.yaml": DECL, ".pre-commit-config.yaml": "repos: []\n" });
      const out = io();
      expect(await runInstall({ cwd: dir, today: TODAY, io: out })).toBe(0);
      expect(out.out).toContain(COMMAND);
      expect(out.out.indexOf(COMMAND)).toBeGreaterThan(out.out.indexOf("已套用"));
    });

    it("prints the command in a preview, with the preview's exit code", async () => {
      const dir = repo({ ".devguard.yaml": DECL, ".pre-commit-config.yaml": "repos: []\n" });
      const out = io(false);
      expect(await runInstall({ cwd: dir, today: TODAY, io: out })).toBe(1);
      expect(out.out).toContain(COMMAND);
      expect(read(dir, ".pre-commit-config.yaml")).toBe("repos: []\n");
    });

    it("prints the command when nothing else is left to fix", async () => {
      const dir = repo({ ".devguard.yaml": DECL, ".pre-commit-config.yaml": "repos: []\n" });
      await runInstall({ cwd: dir, today: TODAY, io: io() });
      const again = io(false);
      expect(await runInstall({ cwd: dir, today: TODAY, io: again })).toBe(0);
      expect(again.out).toContain("沒有需要修正的設定");
      expect(again.out).toContain(COMMAND);
    });

    it("says nothing once pre-commit has written both hooks", async () => {
      const dir = repo({
        ".devguard.yaml": DECL,
        ".pre-commit-config.yaml": "repos: []\n",
        ".git/hooks/pre-commit": generated("pre-commit"),
        ".git/hooks/pre-push": generated("pre-push"),
      });
      const out = io();
      expect(await runInstall({ cwd: dir, today: TODAY, io: out })).toBe(0);
      expect(out.out).not.toContain("pre-commit install");
    });

    it("still asks for it when only the pre-push hook is missing", async () => {
      const dir = repo({
        ".devguard.yaml": DECL,
        ".pre-commit-config.yaml": "repos: []\n",
        ".git/hooks/pre-commit": generated("pre-commit"),
      });
      const out = io();
      await runInstall({ cwd: dir, today: TODAY, io: out });
      expect(out.out).toContain(COMMAND);
    });

    it("does not ask for it while core.hooksPath keeps pre-commit from installing (doctor reports the conflict)", async () => {
      const dir = repo({ ".devguard.yaml": DECL, ".pre-commit-config.yaml": "repos: []\n" });
      execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: dir });
      const out = io();
      await runInstall({ cwd: dir, today: TODAY, io: out });
      expect(out.out).toContain("pre-commit 在 core.hooksPath 有設定時拒絕安裝 hook");
      expect(out.out).not.toContain("下一步");
    });

    it("does not apply to a repo without a hook framework", async () => {
      const dir = repo({ ".devguard.yaml": DECL });
      const out = io();
      await runInstall({ cwd: dir, today: TODAY, io: out });
      expect(out.out).not.toContain("pre-commit install");
    });
  });

  describe("lefthook framework: the next step when `lefthook install` has not run (#93)", () => {
    const NEXT = "下一步：執行 lefthook install";

    it("prints the command after adding devguard's jobs to lefthook.yml", async () => {
      const dir = repo({ ".devguard.yaml": DECL, "lefthook.yml": "pre-commit:\n  jobs: []\n" });
      const out = io();
      expect(await runInstall({ cwd: dir, today: TODAY, io: out })).toBe(0);
      expect(read(dir, "lefthook.yml")).toContain("devguard hook git-pre-push");
      expect(out.out).toContain(NEXT);
      expect(out.out.indexOf(NEXT)).toBeGreaterThan(out.out.indexOf("已套用"));
    });

    it("says nothing once lefthook has written both hooks", async () => {
      const dir = repo({
        ".devguard.yaml": DECL,
        "lefthook.yml": "pre-commit:\n  jobs: []\n",
        ".git/hooks/pre-commit": lefthookWrote("pre-commit"),
        ".git/hooks/pre-push": lefthookWrote("pre-push"),
      });
      const out = io();
      expect(await runInstall({ cwd: dir, today: TODAY, io: out })).toBe(0);
      expect(out.out).not.toContain("下一步");
    });

    it("finds the hooks lefthook wrote under core.hooksPath", async () => {
      const dir = repo({
        ".devguard.yaml": DECL,
        "lefthook.yml": "pre-commit:\n  jobs: []\n",
        ".githooks/pre-commit": lefthookWrote("pre-commit"),
        ".githooks/pre-push": lefthookWrote("pre-push"),
      });
      execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: dir });
      const out = io();
      await runInstall({ cwd: dir, today: TODAY, io: out });
      expect(out.out).not.toContain("下一步");
    });

    it("recognises the hooks lefthook before 1.5 wrote", async () => {
      // The last line of lefthook 1.0–1.4's hook template (internal/templates/hook.tmpl), abridged around it.
      const older = (hook: string) =>
        `#!/bin/sh\ncall_lefthook()\n{\n  lefthook "$@"\n}\n\ncall_lefthook "run ${hook} $@"\n`;
      const dir = repo({
        ".devguard.yaml": DECL,
        "lefthook.yml": "pre-commit:\n  jobs: []\n",
        ".git/hooks/pre-commit": older("pre-commit"),
        ".git/hooks/pre-push": older("pre-push"),
      });
      const out = io();
      await runInstall({ cwd: dir, today: TODAY, io: out });
      expect(out.out).not.toContain("下一步");
    });

    it("still asks for it when a hook of the same name is not lefthook's", async () => {
      const dir = repo({
        ".devguard.yaml": DECL,
        "lefthook.yml": "pre-commit:\n  jobs: []\n",
        ".git/hooks/pre-commit": lefthookWrote("pre-commit"),
        ".git/hooks/pre-push": "#!/bin/sh\nnpm test\n",
      });
      const out = io();
      await runInstall({ cwd: dir, today: TODAY, io: out });
      expect(out.out).toContain(NEXT);
    });
  });

  it("refuses outside a git repository", async () => {
    const dir = repo({ ".devguard.yaml": DECL }, false);
    await expect(runInstall({ cwd: dir, today: TODAY, io: io() })).rejects.toThrow("git repo");
  });
});

describe("devguard install: a type checker the project already configures (#68)", () => {
  const decl = (overrides = "") =>
    "standard: team@1.2.0\ncomponents:\n  - path: ./\n    language: python\n" +
    (overrides === "" ? "" : `    overrides:\n      ${overrides}\n`);
  const BASED = '[project]\nname = "app"\n\n[tool.basedpyright]\ntypeCheckingMode = "strict"\n';

  /** The preview of `install` without --yes: nothing is written. */
  async function preview(files: Record<string, string>) {
    const out = io(false);
    await runInstall({ cwd: repo(files), today: TODAY, io: out });
    return out.out;
  }

  it("warns in the preview when mypy is declared but the project has [tool.basedpyright]", async () => {
    const out = await preview({ ".devguard.yaml": decl(), "pyproject.toml": BASED });
    expect(out).toContain(
      [
        "pyproject.toml：警告：已有宣告以外的型別檢查器設定，不會修改宣告；請自行決定",
        "    ./ (Python) 宣告的 typecheck.tool 是 mypy，但 [tool.basedpyright] 是 basedpyright 的設定",
        "    要改用既有的工具，請在 .devguard.yaml 這個元件的 overrides 宣告：",
        "      typecheck.tool: basedpyright",
      ].join("\n"),
    );
  });

  it("says the standard must be upgraded first when it does not allow the configured checker", async () => {
    const onOld = "standard: team@1.1.0\ncomponents:\n  - path: ./\n    language: python\n";
    const out = await preview({ ".devguard.yaml": onOld, "pyproject.toml": BASED });
    expect(out).toContain(
      "typecheck.tool: basedpyright（目前宣告的標準不允許，需先以 devguard standard upgrade 升級）",
    );
  });

  it("does not change the declaration itself", async () => {
    const dir = repo({ ".devguard.yaml": decl(), "pyproject.toml": BASED });
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    expect(read(dir, ".devguard.yaml")).toBe(decl());
  });

  it("says nothing when the declared type checker is the configured one", async () => {
    expect(
      await preview({ ".devguard.yaml": decl("typecheck.tool: basedpyright"), "pyproject.toml": BASED }),
    ).not.toContain("警告");
    const pyrightconfig = { "pyproject.toml": '[project]\nname = "app"\n', "pyrightconfig.json": "{}" };
    expect(await preview({ ".devguard.yaml": decl("typecheck.tool: basedpyright"), ...pyrightconfig })).not.toContain(
      "警告",
    );
  });

  it("names both pyright-based checkers for a pyrightconfig.json, and mypy for a mypy.ini", async () => {
    const files = { "pyproject.toml": '[project]\nname = "app"\n', "pyrightconfig.json": "{}" };
    const out = await preview({ ".devguard.yaml": decl(), ...files });
    expect(out).toContain("pyrightconfig.json：警告");
    expect(out).toContain("typecheck.tool: pyright");
    expect(out).toContain("typecheck.tool: basedpyright");
    const mypy = await preview({
      ".devguard.yaml": decl("typecheck.tool: pyright"),
      "pyproject.toml": '[project]\nname = "app"\n',
      "mypy.ini": "[mypy]\nstrict = True\n",
    });
    expect(mypy).toContain("mypy.ini：警告");
    expect(mypy).toContain("typecheck.tool: mypy");
  });
});
