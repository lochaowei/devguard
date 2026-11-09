import { describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import { draftDeclaration } from "../src/draft.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import { toolVersionsLayer } from "../src/layers/tool-versions.ts";
import { rules, TODAY } from "./helpers.ts";
import { noTools, read, repo, upgrade } from "./standard-helpers.ts";

// team@1.4.0 as this CLI bundles it (#113): mypy 2.x is in range.

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

  it("still checks the declared checker's range", async () => {
    const declaration = python("team@1.3.0", "      typecheck.tool: basedpyright\n");
    expect(await versionFindings(declaration, uvLock({ basedpyright: "1.0.0" }))).toEqual([
      "error:tool-version/out-of-range",
    ]);
  });
});
