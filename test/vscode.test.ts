import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "jsonc-parser";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import type { Interaction } from "../src/fix/interaction.ts";
import { runFix } from "../src/fix/run.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import type { CheckLayer } from "../src/layers/types.ts";
import { vscodeFixLayer, vscodeLayer } from "../src/layers/vscode.ts";
import type { Finding } from "../src/report/finding.ts";
import { renderVscode } from "../src/report/vscode.ts";
import { PROBLEM_MATCHER } from "../src/vscode/workspace.ts";
import { rules, TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-vscode-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const YES: Interaction = {
  yes: true,
  interactive: false,
  write: () => undefined,
  confirm: () => Promise.resolve(false),
};

type Json = Record<string, unknown>;
const readJson = (dir: string, name: string): Json => parse(readFileSync(join(dir, name), "utf8")) as Json;

async function findings(dir: string, layer: CheckLayer): Promise<Finding[]> {
  const listFiles = () => Promise.resolve([]);
  const result = await runCheck({ cwd: dir, today: TODAY, listFiles }, [declarationLayer, layer]);
  return result.findings.filter((f) => f.rule.startsWith("vscode/"));
}

const check = (dir: string) => findings(dir, vscodeLayer);
const fix = (dir: string) => runFix({ cwd: dir, today: TODAY, io: YES }, [declarationLayer, vscodeFixLayer]);

const component = (path: string, language: string, extra = "") =>
  `  - path: ${path}\n    language: ${language}\n${extra}`;
const decl = (...components: string[]) => `standard: team@1.0.0\ncomponents:\n${components.join("")}`;

describe("VS Code workspace settings are generated for the languages in use (SPEC §7.2)", () => {
  it("check leaves a workspace that was never set up alone; fix and install generate the files", async () => {
    const dir = repo({ ".devguard.yaml": decl(component("./", "typescript")) });
    expect(await check(dir)).toEqual([]);
    const toGenerate = await findings(dir, vscodeFixLayer);
    expect(rules(toGenerate)).toEqual(["hint:vscode/not-generated"]);
    expect(toGenerate[0]?.fix).toMatch(/^devguard fix/);
    expect(await fix(dir)).toBe(0);
    expect(await findings(dir, vscodeFixLayer)).toEqual([]);
    expect(Object.keys(readJson(dir, ".vscode/settings.json"))).toContain("files.eol");
  });

  it("a generated file that was deleted is an error fix regenerates", async () => {
    const dir = repo({ ".devguard.yaml": decl(component("./", "go")) });
    await fix(dir);
    rmSync(join(dir, ".vscode/tasks.json"));
    const found = await check(dir);
    expect(rules(found)).toEqual(["error:vscode/missing-file"]);
    expect(found[0]?.message).toContain(".vscode/tasks.json");
    await fix(dir);
    expect(await check(dir)).toEqual([]);
  });

  it("TypeScript: tsdk, ESLint working directories, recommended extensions and the standards tasks", async () => {
    const dir = repo({ ".devguard.yaml": decl(component("./web", "typescript"), component("./api", "typescript")) });
    await fix(dir);
    expect(readJson(dir, ".vscode/settings.json")).toMatchObject({
      "files.eol": "\n",
      "js/ts.tsdk.path": "web/node_modules/typescript/lib",
      "eslint.workingDirectories": ["./web", "./api"],
      "[typescript]": { "editor.defaultFormatter": "esbenp.prettier-vscode", "editor.formatOnSave": true },
    });
    expect(readJson(dir, ".vscode/extensions.json")).toEqual({
      recommendations: ["dbaeumer.vscode-eslint", "esbenp.prettier-vscode", "vitest.explorer"],
      unwantedRecommendations: ["biomejs.biome"],
    });
    const tasks = readJson(dir, ".vscode/tasks.json").tasks as Json[];
    expect(tasks.map((t) => t.label)).toEqual([
      "standards: doctor",
      "standards: check",
      "standards: fix",
      "standards: test & coverage",
    ]);
    expect(tasks.every((t) => t.type === "process")).toBe(true);
    expect(tasks[0]).toMatchObject({ args: ["doctor", "--quiet"], runOptions: { runOn: "folderOpen" } });
    expect(tasks[1]).toMatchObject({ args: ["check", "--format", "vscode"], problemMatcher: { owner: "devguard" } });
  });

  it("the check task's problem matcher reads what `check --format vscode` prints", () => {
    const line = renderVscode([
      { level: "error", layer: "code", rule: "eslint/no-var", message: "x", file: "a.ts", line: 3 },
    ]);
    const match = new RegExp(PROBLEM_MATCHER.pattern.regexp).exec(line.trim());
    expect(match?.slice(1)).toEqual(["a.ts", "3", "1", "error", "x", "eslint/no-var"]);
  });

  it("Python: Ruff on save and fromEnvironment for the Ruff and mypy extensions; black & co. not recommended", async () => {
    const dir = repo({ ".devguard.yaml": decl(component("./", "python")) });
    await fix(dir);
    expect(readJson(dir, ".vscode/settings.json")).toMatchObject({
      "[python]": {
        "editor.defaultFormatter": "charliermarsh.ruff",
        "editor.codeActionsOnSave": { "source.fixAll": "explicit", "source.organizeImports": "explicit" },
      },
      "ruff.importStrategy": "fromEnvironment",
      "mypy-type-checker.importStrategy": "fromEnvironment",
      "mypy-type-checker.cwd": "${nearestConfig}",
      "python.defaultInterpreterPath": "${workspaceFolder}/.venv",
    });
    expect(readJson(dir, ".vscode/extensions.json").unwantedRecommendations).toEqual([
      "ms-python.black-formatter",
      "ms-python.isort",
      "ms-python.flake8",
      "ms-python.pylint",
    ]);
  });

  it("Go: golangci-lint v2 on save and gofumpt in gopls", async () => {
    const dir = repo({ ".devguard.yaml": decl(component("./", "go")) });
    await fix(dir);
    expect(readJson(dir, ".vscode/settings.json")).toMatchObject({
      "go.lintTool": "golangci-lint-v2",
      "go.lintOnSave": "package",
      gopls: { "formatting.gofumpt": true },
    });
    expect(readJson(dir, ".vscode/extensions.json").recommendations).toEqual(["golang.go"]);
  });

  it("Java: no format on save, Checkstyle as the build pins it, and a Spotless task", async () => {
    const pom = `<project><build><plugins><plugin>
  <artifactId>maven-checkstyle-plugin</artifactId><version>3.6.0</version>
  <dependencies><dependency><groupId>com.puppycrawl.tools</groupId><artifactId>checkstyle</artifactId><version>10.21.0</version></dependency></dependencies>
</plugin></plugins></build></project>`;
    const dir = repo({ ".devguard.yaml": decl(component("./svc", "java")), "svc/pom.xml": pom });
    await fix(dir);
    expect(readJson(dir, ".vscode/settings.json")).toMatchObject({
      "[java]": { "editor.formatOnSave": false },
      "java.checkstyle.configuration": "${workspaceFolder}/svc/checkstyle.xml",
      "java.checkstyle.version": "10.21.0",
    });
    const tasks = readJson(dir, ".vscode/tasks.json").tasks as Json[];
    expect(tasks.find((t) => t.label === "standards: format (Spotless)")).toMatchObject({
      type: "process",
      args: ["-B", "-ntp", "spotless:apply"],
      options: { cwd: "${workspaceFolder}/svc" },
    });
  });
});

describe("only the CLI-managed keys are checked and repaired (SPEC §7.2, §8, §9.2)", () => {
  async function installed(): Promise<string> {
    const dir = repo({ ".devguard.yaml": decl(component("./", "typescript")) });
    await fix(dir);
    return dir;
  }

  it("a changed managed key is an error on its line; fix reverts it and keeps comments and other keys", async () => {
    const dir = await installed();
    const path = join(dir, ".vscode/settings.json");
    const text = readFileSync(path, "utf8").replace(
      '"files.eol": "\\n"',
      '// mine\n  "files.eol": "\\r\\n",\n  "editor.fontSize": 15',
    );
    writeFileSync(path, text);
    const findings = await check(dir);
    expect(rules(findings)).toEqual(["error:vscode/setting"]);
    expect(findings[0]).toMatchObject({ layer: "consistency", file: ".vscode/settings.json", line: 3 });
    expect(await fix(dir)).toBe(0);
    expect(await check(dir)).toEqual([]);
    const after = readFileSync(path, "utf8");
    expect(after).toContain("// mine");
    expect(after).toContain('"editor.fontSize": 15');
  });

  it("accepts the deprecated typescript.tsdk in place of js/ts.tsdk.path", async () => {
    const dir = await installed();
    const path = join(dir, ".vscode/settings.json");
    writeFileSync(path, readFileSync(path, "utf8").replace('"js/ts.tsdk.path"', '"typescript.tsdk"'));
    expect(await check(dir)).toEqual([]);
  });

  it("Biome replaces ESLint and Prettier: a leftover Prettier recommendation is an error fix removes", async () => {
    const dir = repo({
      ".devguard.yaml": decl(component("./", "typescript", "    overrides:\n      lint.tool: biome\n")),
      ".vscode/extensions.json":
        '{\n  // team\n  "recommendations": ["esbenp.prettier-vscode", "ms-vsliveshare.vsliveshare"]\n}\n',
    });
    const messages = (await check(dir)).map((f) => f.message);
    expect(messages).toContain(".vscode/extensions.json：recommendations 不應包含 esbenp.prettier-vscode");
    await fix(dir);
    expect(readJson(dir, ".vscode/extensions.json")).toEqual({
      recommendations: ["ms-vsliveshare.vsliveshare", "biomejs.biome", "vitest.explorer"],
      unwantedRecommendations: ["dbaeumer.vscode-eslint", "esbenp.prettier-vscode"],
    });
    expect(readFileSync(join(dir, ".vscode/extensions.json"), "utf8")).toContain("// team");
  });

  it("a changed standards task is replaced in place; the developer's own tasks stay", async () => {
    const dir = await installed();
    const doc = readJson(dir, ".vscode/tasks.json");
    const tasks = doc.tasks as Json[];
    tasks.splice(1, 1, { ...tasks[1], type: "shell" });
    tasks.push({ label: "mine", type: "shell", command: "make" });
    writeFileSync(join(dir, ".vscode/tasks.json"), JSON.stringify(doc, null, 2));
    expect(rules(await check(dir))).toEqual(["error:vscode/task"]);
    await fix(dir);
    const after = readJson(dir, ".vscode/tasks.json").tasks as Json[];
    expect(after.map((t) => t.label)).toEqual([
      "standards: doctor",
      "standards: check",
      "standards: fix",
      "standards: test & coverage",
      "mine",
    ]);
    expect(after[1]?.type).toBe("process");
  });

  it("a .vscode file that is not valid JSONC is reported and left alone", async () => {
    const dir = await installed();
    writeFileSync(join(dir, ".vscode/settings.json"), "{ broken");
    expect(rules(await check(dir))).toEqual(["error:vscode/unreadable"]);
  });

  it("hints when .gitignore ignores the whole .vscode/ directory", async () => {
    const dir = await installed();
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n.vscode/\n");
    const findings = await check(dir);
    expect(rules(findings)).toEqual(["hint:vscode/gitignored"]);
    expect(findings[0]).toMatchObject({ file: ".gitignore", line: 2 });
    expect(findings[0]?.fix).toContain("!.vscode/settings.json");
    writeFileSync(join(dir, ".gitignore"), ".vscode/*\n!.vscode/settings.json\n");
    expect(await check(dir)).toEqual([]);
  });

  it("nothing to manage without components", async () => {
    const dir = repo({ ".devguard.yaml": "standard: team@1.0.0\ncomponents: []\n" });
    expect(await check(dir)).toEqual([]);
  });
});
