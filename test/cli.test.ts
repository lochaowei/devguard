import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localDate } from "../src/check.ts";
import type { Interaction } from "../src/fix/interaction.ts";
import { runCli } from "../src/main.ts";
import type { ToolRequest, ToolRunner } from "../src/tools/runner.ts";
import { isolateGit } from "./git-isolation.ts";

// Real git runs here: keep it off any repo or config outside this file's temp directories.
isolateGit();

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const dirs: string[] = [];

function project(declaration?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-"));
  dirs.push(dir);
  if (declaration !== undefined) writeFileSync(join(dir, ".devguard.yaml"), declaration);
  // Satisfies the deps layer for npm components; the temp dir is not a git repo, so existing counts as committed.
  writeFileSync(join(dir, "package-lock.json"), "{}\n");
  writeFileSync(join(dir, ".gitattributes"), "* text=auto eol=lf\n");
  return dir;
}

/** ESLint reports prefer-const in every file containing "let  "; everything else is clean (Prettier, tsc). */
const fakeTools = (): ToolRunner & { calls: ToolRequest[] } => {
  const calls: ToolRequest[] = [];
  return {
    calls,
    run(req) {
      calls.push(req);
      if (req.tool !== "eslint") return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      const files = (req.args ?? []).filter((a) => a.endsWith(".ts"));
      const messy = files.filter((f) => readFileSync(join(dirs.at(-1) ?? "", req.dir, f), "utf8").includes("let  "));
      const report = messy.map((f) => ({
        filePath: join(dirs.at(-1) ?? "", req.dir, f),
        messages: [{ ruleId: "prefer-const", severity: 2, message: "'answer' is never reassigned.", line: 1, fix: {} }],
      }));
      return Promise.resolve({ code: messy.length > 0 ? 1 : 0, stdout: JSON.stringify(report), stderr: "" });
    },
  };
};

/** A non-interactive terminal, as under CI: previews only unless --yes. */
const nonInteractive = (yes: boolean): Interaction & { text: string } => {
  const io = {
    text: "",
    yes,
    interactive: false,
    write: (text: string) => {
      io.text += text;
    },
    confirm: () => Promise.resolve(false),
  };
  return io;
};

/** The CLI in-process, with the project's tools faked ("real" for the real runner). */
async function run(args: string[], tools: ToolRunner | "real" = fakeTools()) {
  let out = "";
  let err = "";
  const code = await runCli(args, {
    cwd: process.cwd(),
    ...(tools === "real" ? {} : { tools }),
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    stdin: () => Promise.resolve(""),
    interaction: (yes) => {
      const io = nonInteractive(yes);
      io.write = (t) => (out += t);
      return io;
    },
  });
  return { code, out, err };
}

/** The real CLI process: `node src/cli.ts`. */
function spawn(args: string[], input?: string) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DEVIATING = [
  "standard: team@1.0.0",
  "components:",
  "  - path: web/",
  "    language: typescript",
  "    overrides:",
  '      coverage.lines: {value: 60, reason: "legacy", until: 2099-01-01}',
  "",
].join("\n");

const ESLINT_CONFIG = `import tseslint from "typescript-eslint";

// A stand-in for eslint-plugin-sonarjs, which this sample does not install.
const sonarjs = { rules: { "cognitive-complexity": { meta: { schema: false }, create: () => ({}) } } };

export default tseslint.config({ ignores: ["eslint.config.js"] }, tseslint.configs.strictTypeChecked, {
  languageOptions: { parserOptions: { projectService: true } },
  plugins: { sonarjs },
  rules: { complexity: ["error", 10], "sonarjs/cognitive-complexity": ["error", 15] },
});
`;

/** Writes TypeScript tool configs that meet team@1.0.0, with the given coverage threshold. */
function writeTsConfigs(dir: string, coverage: number): void {
  const tsOptions = ["strict", "noUncheckedIndexedAccess", "noImplicitOverride", "noFallthroughCasesInSwitch"];
  const thresholds = ["lines", "branches", "functions", "statements"]
    .map((k) => `${k}: ${String(coverage)}`)
    .join(", ");
  const compilerOptions = { ...Object.fromEntries(tsOptions.map((o) => [o, true])), types: [] };
  const files: Record<string, string> = {
    "tsconfig.json": `${JSON.stringify({ compilerOptions }, null, 2)}\n`,
    ".prettierrc": '{ "printWidth": 120, "endOfLine": "lf" }\n',
    ".npmrc": "registry=https://nexus.example.internal/repository/npm-proxy/\n",
    "eslint.config.js": ESLINT_CONFIG,
    "vitest.config.ts": `export default { test: { coverage: { include: ["src/**"], thresholds: { ${thresholds} } } } };\n`,
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}

/** DEVIATING plus web/ tool configs that match it, so the deviation is the only finding. */
function deviatingProject(): string {
  const dir = project(DEVIATING);
  const web = join(dir, "web");
  mkdirSync(web);
  writeTsConfigs(web, 60);
  return dir;
}

describe("devguard check", () => {
  it("exits 0 for a clean declaration", async () => {
    const dir = project("standard: team@1.0.0\ncomponents:\n  - { path: ./, language: typescript }\n");
    writeTsConfigs(dir, 80);
    const r = await run(["check", "--cwd", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("通過");
  });

  it("exits 0 with deviations, 1 with --strict", async () => {
    const dir = deviatingProject();
    expect((await run(["check", "--cwd", dir])).code).toBe(0);
    expect((await run(["check", "--cwd", dir, "--strict"])).code).toBe(1);
  });

  it("exits 1 when the declaration is missing", async () => {
    const r = await run(["check", "--cwd", project()]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("找不到 .devguard.yaml");
  });

  it("exits 1 on a YAML syntax error", async () => {
    expect((await run(["check", "--cwd", project("standard: [\n")])).code).toBe(1);
  });

  it("prints JSON with --format json", async () => {
    const r = await run(["check", "--cwd", deviatingProject(), "--format", "json"]);
    const json = JSON.parse(r.out) as { standard: string; findings: { level: string }[] };
    expect(json.standard).toBe("team@1.0.0");
    expect(json.findings.map((x) => x.level)).toEqual(["deviation"]);
  });

  it("prints sarif, vscode and claude formats with the same exit code as text", async () => {
    const dir = project();
    const out = async (format: string) => {
      const r = await run(["check", "--cwd", dir, "--format", format]);
      expect(r.code).toBe(1);
      return r.out;
    };
    expect(await out("vscode")).toMatch(/^\.devguard\.yaml:1:1: error: 找不到 \.devguard\.yaml.* \[[^\]]+\]$/m);
    expect(await out("claude")).toMatch(/^devguard：1 個錯誤.*\n- 錯誤 .*找不到 \.devguard\.yaml/);
    // The missing declaration is not a code finding, so SARIF has no results.
    const sarif = JSON.parse(await out("sarif")) as { version: string; runs: { results: unknown[] }[] };
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0]?.results).toEqual([]);
    expect((await run(["check", "--cwd", deviatingProject(), "--format", "vscode", "--strict"])).code).toBe(1);
  });

  it("exits 2 on usage errors", async () => {
    expect((await run(["frobnicate"])).code).toBe(2);
    expect((await run(["check", "--format", "xml"])).code).toBe(2);
    expect((await run(["check", "--nope"])).code).toBe(2);
    expect((await run([])).code).toBe(2);
  });

  it("rejects an unknown --only category and --full together with files", async () => {
    const dir = project("standard: team@1.0.0\ncomponents: []\n");
    const bad = await run(["check", "--cwd", dir, "--only", "speling"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("lint|format|typecheck");
    expect((await run(["check", "--cwd", dir, "--full", join(dir, "a.ts")])).code).toBe(2);
    expect((await run(["check", "--cwd", dir, join(tmpdir(), "elsewhere.ts")])).code).toBe(2);
  });

  it("exits 2 with `npm ci` when the TypeScript tools are not installed", async () => {
    const dir = project("standard: team@1.0.0\ncomponents:\n  - {path: ./, language: typescript}\n");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    const r = await run(["check", "--cwd", dir, "--only", "lint", join(dir, "a.ts")], "real");
    expect(r.code).toBe(2);
    expect(r.err).toContain("eslint");
    expect(r.err).toContain("npm ci");
  });

  it("exits 2 with `uv sync` when the Python tools are not installed", async () => {
    const dir = project("standard: team@1.0.0\ncomponents:\n  - {path: ./, language: python}\n");
    writeFileSync(join(dir, "a.py"), "a = 1\n");
    const r = await run(["check", "--cwd", dir, "--only", "lint", join(dir, "a.py")], "real");
    expect(r.code).toBe(2);
    expect(r.err).toContain("ruff");
    expect(r.err).toContain("uv sync");
  });

  it("prints the version and help", async () => {
    expect((await run(["--version"])).out).toBe("devguard 0.1.0\n");
    expect((await run(["--help"])).code).toBe(0);
  });
});

describe("devguard fix", () => {
  /** A clean TypeScript project whose .gitattributes lacks the LF rule. */
  function fixableProject(): string {
    const dir = project("standard: team@1.0.0\ncomponents:\n  - { path: ./, language: typescript }\n");
    writeTsConfigs(dir, 80);
    writeFileSync(join(dir, ".gitattributes"), "*.png binary\n");
    return dir;
  }

  it("marks the finding as fixable, without the internal repairs in JSON", async () => {
    const r = await run(["check", "--cwd", fixableProject(), "--format", "json"]);
    const json = JSON.parse(r.out) as { findings: Record<string, unknown>[] };
    expect(json.findings).toHaveLength(1);
    expect(json.findings[0]?.fix).toMatch(/^devguard fix/);
    expect(json.findings[0]).not.toHaveProperty("repairs");
  });

  it("only previews and exits 1 when not interactive and without --yes", async () => {
    const dir = fixableProject();
    const r = await run(["fix", "--cwd", dir]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("+* text=auto eol=lf");
    expect(readFileSync(join(dir, ".gitattributes"), "utf8")).toBe("*.png binary\n");
  });

  it("applies with --yes, after which check passes", async () => {
    const dir = fixableProject();
    expect((await run(["fix", "--cwd", dir, "--yes"])).code).toBe(0);
    expect((await run(["check", "--cwd", dir])).code).toBe(0);
  });
});

describe("devguard fix --code", () => {
  const MESSY = "let  answer = 42;\nexport { answer };\n";

  /** A TypeScript project that meets team@1.0.0 except for a.ts, which ESLint and Prettier can fix. */
  function messyProject(): string {
    const dir = project("standard: team@1.0.0\ncomponents:\n  - { path: ./, language: typescript }\n");
    writeTsConfigs(dir, 80);
    writeFileSync(join(dir, "a.ts"), MESSY);
    return dir;
  }

  it("only previews and exits 1 when not interactive and without --yes", async () => {
    const dir = messyProject();
    const r = await run(["fix", "--code", "--cwd", dir, join(dir, "a.ts")]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("[eslint/prefer-const]");
    expect(r.out).toContain("prettier --write --log-level warn a.ts");
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe(MESSY);
  });

  it("takes files only together with --code", async () => {
    expect((await run(["fix", "a.ts"])).code).toBe(2);
  });
});

describe("devguard draft", () => {
  /** A project with no declaration whose web/ TypeScript component has a coverage threshold of 60. */
  function undeclared(): string {
    const dir = project();
    const web = join(dir, "web");
    mkdirSync(join(web, "src"), { recursive: true });
    writeTsConfigs(web, 60);
    writeFileSync(join(web, "package.json"), "{}\n");
    writeFileSync(join(web, "src", "app.ts"), "");
    return dir;
  }

  it("is what check suggests when the declaration is missing", async () => {
    expect((await run(["check", "--cwd", project()])).out).toContain("devguard draft");
  });

  it("writes a draft that check rejects until the TODO reasons are filled in", async () => {
    const dir = undeclared();
    const r = await run(["draft", "--cwd", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(".devguard.yaml");
    const text = readFileSync(join(dir, ".devguard.yaml"), "utf8");
    expect(text).toContain("path: web/");
    expect(text).toContain("coverage.lines");

    const todo = await run(["check", "--cwd", dir, "--format", "json"]);
    expect(todo.code).toBe(1);
    expect(todo.out).toContain("declaration/todo-reason");

    writeFileSync(join(dir, ".devguard.yaml"), text.replace(/reason: .*TODO.*/, "reason: legacy tests"));
    expect((await run(["check", "--cwd", dir])).code).toBe(0);
  });

  it("--ignore leaves paths out of the draft's components, and check then gives no uncovered-files hint", async () => {
    const dir = undeclared();
    mkdirSync(join(dir, "examples"));
    writeFileSync(join(dir, "examples", "demo.ts"), "");
    mkdirSync(join(dir, "gen"));
    writeFileSync(join(dir, "gen", "api.py"), "");
    const r = await run(["draft", "--cwd", dir, "--ignore", "examples/", "--ignore", "gen/**"]);
    expect(r.code).toBe(0);
    const text = readFileSync(join(dir, ".devguard.yaml"), "utf8");
    expect(text).toContain("ignore:\n  - examples/\n  - gen/**\n");
    expect(text).not.toContain("path: ./");

    writeFileSync(join(dir, ".devguard.yaml"), text.replace(/reason: .*TODO.*/, "reason: legacy tests"));
    const check = await run(["check", "--cwd", dir, "--format", "json"]);
    expect(check.out).not.toContain("declaration/uncovered-files");
  });

  it("does not overwrite an existing declaration", async () => {
    const existing = "standard: team@1.0.0\ncomponents: []\n";
    const dir = project(existing);
    const r = await run(["draft", "--cwd", dir]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(".devguard.yaml");
    expect(readFileSync(join(dir, ".devguard.yaml"), "utf8")).toBe(existing);
  });
});

describe("devguard hook / install", () => {
  it("rejects an unknown hook name with exit 2 and lists the known ones", async () => {
    const r = await run(["hook", "git-nope"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("git-pre-commit");
  });

  it("install refuses outside a git repo with exit 2", async () => {
    const r = await run(["install", "--yes", "--cwd", project("standard: team@1.0.0\ncomponents: []\n")]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("不是 git repo");
  });
});

describe("devguard doctor", () => {
  const gitProject = () => {
    const dir = project("standard: team@1.0.0\ncomponents: []\n");
    spawnSync("git", ["init", "-q"], { cwd: dir });
    return dir;
  };

  it("reports the missing hook with devguard install and exits 1", async () => {
    const r = await run(["doctor", "--cwd", gitProject(), "--format", "json"]);
    expect(r.code).toBe(1);
    const report = JSON.parse(r.out) as { findings: { layer: string; rule: string; fix?: string }[] };
    expect(report.findings).toContainEqual(
      expect.objectContaining({ layer: "environment", rule: "environment/hook-missing", fix: "devguard install" }),
    );
  });

  it("exits 0 with --exit-zero although it found problems (for the /standards-doctor skill)", async () => {
    const r = await run(["doctor", "--exit-zero", "--format", "claude", "--cwd", gitProject()]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("environment/hook-missing");
  });

  it("reports a directory outside git instead of failing", async () => {
    const r = await run(["doctor", "--cwd", project("standard: team@1.0.0\ncomponents: []\n")]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("environment/not-a-git-repo");
  });

  it("prints nothing with --quiet once installed, and only the problems otherwise", async () => {
    const dir = gitProject();
    const before = await run(["doctor", "--quiet", "--cwd", dir]);
    expect(before.out).toContain("environment/hook-missing");
    expect((await run(["install", "--yes", "--cwd", dir])).code).toBe(0);
    expect(await run(["doctor", "--quiet", "--cwd", dir])).toMatchObject({ code: 0, out: "" });
    // Only hints remain (Claude Code's hooks have not run here yet).
    expect((await run(["doctor", "--cwd", dir])).out).toContain("0 個錯誤、0 個偏離");
  });
});

describe("the real CLI process (end to end)", { timeout: 120_000 }, () => {
  it("prints the version, and exits 2 with the usage on bad arguments", () => {
    expect(spawn(["--version"])).toMatchObject({ code: 0, out: "devguard 0.1.0\n" });
    const bad = spawn(["frobnicate"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("用法：devguard");
  });

  it("passes the Claude Code hook its JSON input on stdin and answers on stdout", () => {
    const dir = project("standard: team@1.0.0\ncomponents: []\n");
    const input = JSON.stringify({ hook_event_name: "PostToolUse", tool_input: { file_path: join(dir, "README.md") } });
    const r = spawn(["hook", "claude-post-edit", "--cwd", dir], input);
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
  });

  it("exits 2 on a Claude Code hook input that is not JSON", () => {
    expect(spawn(["hook", "claude-stop"], "nope").code).toBe(2);
  });
  // fix --code with the real ESLint, Prettier and tsc: test/cli.e2e.test.ts (its own file, so it runs in parallel).
});

describe("localDate", () => {
  it("formats the local calendar date", () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});
