import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import { draftDeclaration } from "../src/draft.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import { createDepsLayer } from "../src/layers/deps.ts";
import { toolVersionsLayer } from "../src/layers/tool-versions.ts";
import { rules, TODAY } from "./helpers.ts";
import { noTools, read, repo, upgrade } from "./standard-helpers.ts";

// team@1.4.0 as this CLI bundles it: mypy 2.x is in range (#113); Bun is an allowed TypeScript deps.manager (#138).

const uvLock = (packages: Record<string, string>) =>
  "version = 1\n" +
  Object.entries(packages)
    .map(([name, version]) => `\n[[package]]\nname = "${name}"\nversion = "${version}"\n`)
    .join("");

const python = (standard: string, overrides = "") =>
  `standard: ${standard}\ncomponents:\n  - path: ./\n    language: python\n` +
  (overrides === "" ? "" : `    overrides:\n${overrides}`);

const versionFindings = async (declaration: string, lock: string) =>
  rules(
    (
      await runCheck({ cwd: repo({ ".devguard.yaml": declaration, "uv.lock": lock }), today: TODAY, tools: noTools }, [
        declarationLayer,
        toolVersionsLayer,
      ])
    ).findings,
  );

describe("team@1.4.0 allows mypy 2.x (#113)", () => {
  it("accepts a locked mypy 2.4.0", async () => {
    expect(await versionFindings(python("team@1.4.0"), uvLock({ mypy: "2.4.0" }))).toEqual([]);
  });

  it("still rejects mypy 3", async () => {
    expect(await versionFindings(python("team@1.4.0"), uvLock({ mypy: "3.0.0" }))).toEqual([
      "error:tool-version/out-of-range",
    ]);
  });

  it("leaves team@1.3.0 as it was: mypy 2.4.0 is out of range", async () => {
    expect(await versionFindings(python("team@1.3.0"), uvLock({ mypy: "2.4.0" }))).toEqual([
      "error:tool-version/out-of-range",
    ]);
  });

  it("draft writes team@1.4.0", async () => {
    const files = { "pyproject.toml": '[project]\nname = "app"\n', "app.py": "" };
    const { text } = await draftDeclaration({ cwd: repo(files), today: TODAY, files: Object.keys(files) });
    expect(text).toContain("standard: team@1.4.0");
  });

  it("standard upgrade previews and applies team@1.3.0 → team@1.4.0", async () => {
    const dir = repo({ ".devguard.yaml": python("team@1.3.0") });
    expect((await upgrade(dir)).out).toContain("team@1.3.0 → team@1.4.0");
    expect((await upgrade(dir, { apply: true })).code).toBe(0);
    expect(read(dir, ".devguard.yaml")).toContain("standard: team@1.4.0");
  });
});

describe("only the declared type checker's range is checked, in every standard (#113)", () => {
  it("skips mypy's range when the component declares basedpyright", async () => {
    const declaration = python("team@1.3.0", "      typecheck.tool: basedpyright\n");
    expect(await versionFindings(declaration, uvLock({ mypy: "2.1.0" }))).toEqual([]);
  });

  it("skips pyright's and basedpyright's ranges when the component declares mypy", async () => {
    const lock = uvLock({ pyright: "1.0.0", basedpyright: "1.0.0" });
    expect(await versionFindings(python("team@1.3.0"), lock)).toEqual([]);
  });

  it("skips mypy's range on legacy@1.0.0 too when the component declares pyright", async () => {
    const declaration = python("legacy@1.0.0", "      typecheck.tool: pyright\n");
    expect(await versionFindings(declaration, uvLock({ mypy: "2.4.0" }))).toEqual([]);
  });

  it("standard upgrade proposes no mypy change for a component that declares basedpyright", async () => {
    const declaration = python("team@1.2.0", "      typecheck.tool: basedpyright\n");
    const dir = repo({ ".devguard.yaml": declaration, "uv.lock": uvLock({ mypy: "2.1.0" }) });
    const { out } = await upgrade(dir, { target: "team@1.3.0" });
    expect(out).toContain("team@1.2.0 → team@1.3.0");
    expect(out).not.toContain("mypy 2.1.0");
  });

  it("still checks the declared checker's range", async () => {
    const declaration = python("team@1.3.0", "      typecheck.tool: basedpyright\n");
    expect(await versionFindings(declaration, uvLock({ basedpyright: "1.0.0" }))).toEqual([
      "error:tool-version/out-of-range",
    ]);
  });
});

/** The start of elysia's real bun.lock (Bun is its only package manager), with a few of its packages. */
const BUN_LOCK = readFileSync(join(import.meta.dirname, "fixtures/typescript/bun.lock"), "utf8");

const bunProject = (standard: string) =>
  repo({
    ".devguard.yaml":
      `standard: ${standard}\ncomponents:\n  - path: ./\n    language: typescript\n` +
      "    overrides:\n      deps.manager: bun\n",
    "package.json": '{ "name": "elysia" }',
    "bun.lock": BUN_LOCK,
  });

const bunFindings = async (standard: string) =>
  (
    await runCheck({ cwd: bunProject(standard), today: TODAY, tools: noTools }, [
      declarationLayer,
      createDepsLayer({ trackedFiles: () => Promise.resolve(undefined) }),
      toolVersionsLayer,
    ])
  ).findings;

describe("team@1.4.0 allows Bun as the TypeScript deps.manager (#138)", () => {
  it("counts bun.lock as the lockfile and checks the tool versions it locks", async () => {
    const findings = await bunFindings("team@1.4.0");
    // elysia locks ESLint 9.39.1 and TypeScript 5.9.3; team@1.4.0 asks for ESLint 10 and TypeScript 6.
    expect(rules(findings)).toEqual(["error:tool-version/out-of-range", "error:tool-version/out-of-range"]);
    expect(findings.map((f) => f.file)).toEqual(["bun.lock", "bun.lock"]);
    const messages = findings.map((f) => f.message);
    expect(messages[0]).toMatch(/eslint.*9\.39\.1/);
    expect(messages[1]).toMatch(/typescript.*5\.9\.3/);
  });

  it("leaves team@1.3.0 as it was: bun is not an allowed deps.manager", async () => {
    const findings = await bunFindings("team@1.3.0");
    const declared = findings.filter((f) => f.file === ".devguard.yaml").map((f) => f.message);
    expect(declared.some((m) => m.includes("bun"))).toBe(true);
    expect(rules(findings)).toContain("error:deps/lockfile-missing");
  });

  it("draft writes deps.manager: bun for a project with only bun.lock", async () => {
    const files = { "package.json": '{ "name": "elysia" }', "bun.lock": BUN_LOCK, "src/index.ts": "" };
    const { text } = await draftDeclaration({ cwd: repo(files), today: TODAY, files: Object.keys(files) });
    expect(text).toContain("standard: team@1.4.0");
    expect(text).toContain("deps.manager: bun");
  });
});
