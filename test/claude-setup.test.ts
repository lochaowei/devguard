import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { format } from "prettier";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import type { Interaction } from "../src/fix/interaction.ts";
import { runFix } from "../src/fix/run.ts";
import { runInstall } from "../src/hooks/install.ts";
import { claudeCodeLayer } from "../src/layers/claude-code.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import { TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-claude-"));
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

const DECL =
  "standard: team@1.0.0\ncomponents:\n  - path: ./api\n    language: python\n  - path: ./web\n    language: typescript\n";
const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");

interface HookEntry {
  type: string;
  command: string;
  args?: string[];
  onFailure?: string;
}
interface Group {
  matcher?: string;
  hooks: HookEntry[];
}
type Settings = { hooks: Record<string, Group[]> } & Record<string, unknown>;

const settings = (dir: string): Settings => JSON.parse(read(dir, ".claude/settings.json")) as Settings;

describe(".claude/settings.json hooks from install (SPEC §7.3)", () => {
  it("calls devguard in exec form, with onFailure block on SessionStart and PostToolUse but not on Stop", async () => {
    const dir = repo({ ".devguard.yaml": DECL });
    expect(await runInstall({ cwd: dir, today: TODAY, io: io() })).toBe(0);
    const { hooks } = settings(dir);
    expect(hooks.SessionStart).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: "devguard",
            args: ["hook", "claude-session-start", "--cwd", "${CLAUDE_PROJECT_DIR}"],
            onFailure: "block",
          },
        ],
      },
    ]);
    expect(hooks.PostToolUse).toEqual([
      {
        matcher: "Edit|Write",
        hooks: [
          {
            type: "command",
            command: "devguard",
            args: ["hook", "claude-post-edit", "--cwd", "${CLAUDE_PROJECT_DIR}"],
            onFailure: "block",
          },
        ],
      },
    ]);
    expect(hooks.Stop).toEqual([
      {
        hooks: [
          { type: "command", command: "devguard", args: ["hook", "claude-stop", "--cwd", "${CLAUDE_PROJECT_DIR}"] },
        ],
      },
    ]);
  });
});

describe("install keeps the project's own Claude Code hooks", () => {
  it("replaces devguard's group in place and leaves other hooks and keys alone", async () => {
    const own = { matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] };
    const old = { hooks: [{ type: "command", command: "devguard", args: ["hook", "claude-post-edit"] }] };
    const before = { model: "x", hooks: { PostToolUse: [own, old] } };
    const dir = repo({ ".devguard.yaml": DECL, ".claude/settings.json": JSON.stringify(before, null, 2) + "\n" });
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    const after = settings(dir);
    expect(after.model).toBe("x");
    expect(after.hooks.PostToolUse?.length).toBe(2);
    expect(after.hooks.PostToolUse?.[0]).toEqual(own);
    expect(after.hooks.PostToolUse?.[1]?.matcher).toBe("Edit|Write");
  });

  it("changes nothing the second time", async () => {
    const dir = repo({ ".devguard.yaml": DECL });
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    const out = io();
    await runInstall({ cwd: dir, today: TODAY, io: out });
    expect(out.out).not.toContain(".claude/");
  });
});

describe(".claude/rules/standards-<元件>.md (SPEC §7.3)", () => {
  it("writes one rules file per component, scoped to its directory and extensions, marked as generated", async () => {
    const dir = repo({ ".devguard.yaml": DECL });
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    const py = read(dir, ".claude/rules/standards-api-python.md");
    expect(py.startsWith('---\npaths:\n  - "api/**/*.{py,pyi}"\n---\n')).toBe(true);
    expect(py).toContain("由 CLI 產生");
    expect(py).toContain("循環複雜度上限");
    expect(py.split("\n").length).toBeLessThan(200);
    const ts = read(dir, ".claude/rules/standards-web-typescript.md");
    expect(ts).toContain('"web/**/*.{ts,tsx,mts,cts}"');
  });

  it("lists a deviation with its reason", async () => {
    const decl =
      "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: go\n    overrides:\n" +
      "      complexity.cyclomatic: {value: 20, reason: 舊程式碼, until: 2099-01-01}\n";
    const dir = repo({ ".devguard.yaml": decl });
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    const go = read(dir, ".claude/rules/standards-root-go.md");
    expect(go).toContain('  - "**/*.go"');
    expect(go).toMatch(/## 目前的偏離\n\n- .*20｜理由：舊程式碼｜到期：2099-01-01/);
  });
});

describe("check and fix keep an existing Claude Code setup current", () => {
  const claudeFindings = async (dir: string) =>
    (await runCheck({ cwd: dir, today: TODAY }, [declarationLayer, claudeCodeLayer])).findings.filter(
      (f) => f.rule === "settings/claude-code",
    );

  it("says nothing for a project without the setup", async () => {
    const dir = repo({ ".devguard.yaml": DECL });
    expect(await claudeFindings(dir)).toEqual([]);
  });

  it("reports an out-of-date rules file as an error that fix regenerates", async () => {
    const dir = repo({ ".devguard.yaml": DECL });
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    writeFileSync(join(dir, ".claude/rules/standards-api-python.md"), "hand edited\n");
    const findings = await claudeFindings(dir);
    expect(findings.map((f) => [f.level, f.file])).toEqual([["error", ".claude/rules/standards-api-python.md"]]);
    expect(findings[0]?.fix).toMatch(/^devguard fix/);
    expect(await runFix({ cwd: dir, today: TODAY, io: io() })).toBe(0);
    expect(read(dir, ".claude/rules/standards-api-python.md")).toContain("由 CLI 產生");
    expect(await claudeFindings(dir)).toEqual([]);
  });
});

describe("the generated Claude Code files are already in Prettier's format (#42)", () => {
  const TS_ROOT = "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: typescript\n";
  const FILES = [
    ".claude/settings.json",
    ".claude/rules/standards-root-typescript.md",
    ".claude/skills/standards-doctor/SKILL.md",
  ];

  it("so formatting them with the project's Prettier settings changes nothing", async () => {
    const dir = repo({ ".devguard.yaml": TS_ROOT });
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    for (const file of FILES) {
      const text = read(dir, file);
      expect(await format(text, { filepath: file, printWidth: 120, endOfLine: "lf" }), file).toBe(text);
    }
  });

  it("so a Prettier-formatted setup still matches the standard", async () => {
    const dir = repo({ ".devguard.yaml": TS_ROOT });
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    for (const file of FILES) {
      const text = read(dir, file);
      writeFileSync(join(dir, file), await format(text, { filepath: file, printWidth: 120, endOfLine: "lf" }));
    }
    const result = await runCheck({ cwd: dir, today: TODAY }, [declarationLayer, claudeCodeLayer]);
    expect(result.findings.filter((f) => f.rule === "settings/claude-code")).toEqual([]);
  });
});

describe("/standards-doctor skill (SPEC §7.3)", () => {
  it("is developer-only, embeds doctor and allows devguard under Bash and PowerShell", async () => {
    const dir = repo({ ".devguard.yaml": DECL });
    await runInstall({ cwd: dir, today: TODAY, io: io() });
    const skill = read(dir, ".claude/skills/standards-doctor/SKILL.md");
    expect(skill).toMatch(/^---\n[\s\S]*disable-model-invocation: true\n/);
    expect(skill).toContain("allowed-tools: Bash(devguard *), PowerShell(devguard *)");
    expect(skill).toContain("!`devguard doctor --format claude --exit-zero`");
    expect(skill).toContain("由 CLI 產生");
    expect(skill).toContain("devguard fix --yes");
  });
});
