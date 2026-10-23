import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import { runDoctor } from "../src/doctor.ts";
import { createStandardUpgradeCheck } from "../src/environment/standard-upgrade.ts";
import { createDeclarationLayer } from "../src/layers/declaration.ts";
import type { Interaction } from "../src/fix/interaction.ts";
import { runFix } from "../src/fix/run.ts";
import { diffStandards, upgradeSuggestion } from "../src/standard/upgrade.ts";
import { runStandardUpgrade } from "../src/standard/upgrade-run.ts";
import type { PackageRequest, ToolRunner } from "../src/tools/runner.ts";
import { team_1_0_0 } from "../src/standard/team-1.0.0.ts";
import type { ItemValue, Language, Standard } from "../src/standard/types.ts";
import { rules, TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-upgrade-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");

/** Test-only standard versions: team@1.0.0 under another id, optionally changed. */
const version = (id: string, change: (s: Standard) => Standard = (s) => s): Standard => change({ ...team_1_0_0, id });

describe("upgradeSuggestion: doctor suggests a minor or patch upgrade (SPEC §5.5)", () => {
  it("suggests the newest minor or patch of the same major", () => {
    const bundled = [team_1_0_0, version("team@1.0.1"), version("team@1.2.0"), version("team@2.0.0")];
    const finding = upgradeSuggestion("team@1.0.0", bundled);
    expect(finding).toMatchObject({
      level: "hint",
      rule: "standard/upgrade-available",
      fix: "devguard standard upgrade team@1.2.0",
    });
    expect(finding?.message).toContain("team@1.2.0");
  });

  it("is silent when the declared version is the newest of its major", () => {
    expect(upgradeSuggestion("team@1.0.0", [team_1_0_0, version("team@2.0.0")])).toBeUndefined();
    expect(upgradeSuggestion("team@1.0.0", [team_1_0_0])).toBeUndefined();
  });

  it("is silent for a malformed or unknown standard", () => {
    expect(upgradeSuggestion("team", [team_1_0_0])).toBeUndefined();
    expect(upgradeSuggestion("other@1.0.0", [team_1_0_0])).toBeUndefined();
  });
});

/** `s` with the value of one item of `language` replaced. */
function withItem(s: Standard, language: Language, key: string, value: ItemValue): Standard {
  const items = s.languages[language];
  const item = items[key];
  if (!item) throw new Error(`no item ${key}`);
  return { ...s, languages: { ...s.languages, [language]: { ...items, [key]: { ...item, value } } } };
}

const withPython = (s: Standard, key: string, value: ItemValue) => withItem(s, "python", key, value);

/** team@1.1.0 for tests: Python coverage loosened to 70, a new optional global item, `deps.bannedApis` dropped. */
const team_1_1_0 = version("team@1.1.0", (s) => {
  const loosened = withPython(s, "coverage.lines", 70);
  const python = Object.fromEntries(Object.entries(loosened.languages.python).filter(([k]) => k !== "deps.bannedApis"));
  return {
    ...loosened,
    global: { ...s.global, "docs.url": { kind: "style", label: "說明網址", value: "https://example.internal" } },
    languages: { ...loosened.languages, python },
  };
});

describe("diffStandards: the standard items that change", () => {
  it("lists changed, added and removed items for the languages in use", () => {
    expect(diffStandards(team_1_0_0, team_1_1_0, ["python"])).toEqual([
      { scope: "global", key: "docs.url", label: "說明網址", after: "https://example.internal" },
      { scope: "python", key: "coverage.lines", label: "覆蓋率門檻 (%)", before: 80, after: 70 },
      { scope: "python", key: "deps.bannedApis", label: "禁用 API", before: [] },
    ]);
  });

  it("ignores languages the project does not use", () => {
    expect(diffStandards(team_1_0_0, team_1_1_0, ["go"])).toHaveLength(1);
  });
});

/** A Python component whose pyproject.toml meets team@1.0.0 (written by `fix`), with ruff 0.17.2 locked. */
async function pythonRepo(overrides: string): Promise<string> {
  const dir = repo({
    ".devguard.yaml": `standard: team@1.0.0 # keep me\ncomponents:\n  - path: ./\n    language: python\n    overrides:\n${overrides}`,
    "uv.lock": 'version = 1\n\n[[package]]\nname = "ruff"\nversion = "0.17.2"\n',
  });
  const quiet: Interaction = {
    yes: true,
    interactive: false,
    write: () => undefined,
    confirm: () => Promise.resolve(false),
  };
  expect(await runFix({ cwd: dir, today: TODAY, io: quiet })).toBe(0);
  return dir;
}

const OVERRIDES =
  '      coverage.lines:\n        value: 70\n        reason: "legacy"\n      complexity.cyclomatic: 8\n';

/** team@1.1.0 plus a narrower line length and a newer ruff line. */
const team_1_1_0_ruff = withPython(withPython(team_1_1_0, "format.lineLength", 100), "tools.ruff", ">=0.18,<0.19");

/** team@2.0.0: cyclomatic tightened to 6, so the override 8 becomes looser. */
const team_2_0_0 = version("team@2.0.0", (s) => withPython(s, "complexity.cyclomatic", 6));

const BUNDLED = [team_1_0_0, team_1_1_0_ruff, team_2_0_0];

function fakeTools() {
  const managed: PackageRequest[] = [];
  const tools: ToolRunner = {
    run: () => Promise.reject(new Error("no tools in this test")),
    manage: (r) => {
      managed.push(r);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
  };
  return { tools, managed };
}

async function upgrade(dir: string, extra: { target?: string; apply?: boolean; tools?: ToolRunner } = {}) {
  let out = "";
  const code = await runStandardUpgrade({
    cwd: dir,
    today: TODAY,
    bundled: BUNDLED,
    apply: false,
    tools: fakeTools().tools,
    write: (t) => (out += t),
    ...extra,
  });
  return { code, out };
}

describe("devguard standard upgrade (SPEC §5.5)", () => {
  it("previews item changes, impact, tool versions and commands without changing anything", async () => {
    const dir = await pythonRepo(OVERRIDES);
    const before = { decl: read(dir, ".devguard.yaml"), py: read(dir, "pyproject.toml") };
    const { tools, managed } = fakeTools();
    const { out } = await upgrade(dir, { target: "team@1.1.0", tools });
    expect(out).toContain("team@1.0.0 → team@1.1.0");
    expect(out).toContain("Python｜覆蓋率門檻 (%)：80 → 70");
    expect(out).toContain('整體｜說明網址：（新增）"https://example.internal"');
    expect(out).toMatch(/多餘的覆寫.*\n.*coverage\.lines/);
    expect(out).toContain("ruff 0.17.2 不在新的版本範圍 >=0.18,<0.19 內");
    expect(out).toContain("uv add --dev ruff>=0.18,<0.19");
    expect(out).toContain("--apply");
    expect(read(dir, ".devguard.yaml")).toBe(before.decl);
    expect(read(dir, "pyproject.toml")).toBe(before.py);
    expect(managed).toEqual([]);
  });

  it("--apply updates the declaration and config files, then runs the commands through the mirror", async () => {
    const dir = await pythonRepo(OVERRIDES);
    const { tools, managed } = fakeTools();
    const { code } = await upgrade(dir, { target: "team@1.1.0", apply: true, tools });
    expect(code).toBe(0);
    const decl = read(dir, ".devguard.yaml");
    expect(decl).toContain("standard: team@1.1.0 # keep me");
    expect(decl).not.toContain("coverage.lines");
    expect(decl).toContain("complexity.cyclomatic: 8");
    expect(read(dir, "pyproject.toml")).toContain("line-length = 100");
    expect(managed).toEqual([
      {
        language: "python",
        dir: "",
        args: ["add", "--dev", "ruff>=0.18,<0.19"],
        mirror: team_1_0_0.global["mirrors.pypi"]?.value,
      },
    ]);
  });

  it("shows overrides that become new errors, and upgrades to the newest bundled version by default", async () => {
    const dir = await pythonRepo("      complexity.cyclomatic: 8\n");
    const { out } = await upgrade(dir);
    expect(out).toContain("team@1.0.0 → team@2.0.0");
    expect(out).toMatch(/新的錯誤或偏離.*\n.*循環複雜度上限：6 → 8：比預設寬鬆/);
  });

  it("refuses an unknown target or one that is not newer", async () => {
    const dir = await pythonRepo("      complexity.cyclomatic: 8\n");
    expect(await upgrade(dir, { target: "team@9.0.0" })).toMatchObject({ code: 2 });
    const same = await upgrade(dir, { target: "team@1.0.0" });
    expect(same.code).toBe(0);
    expect(same.out).toContain("已經是");
  });

  it("needs a declaration to upgrade", async () => {
    const dir = repo({});
    const result = await upgrade(dir);
    expect(result.code).toBe(2);
    expect(result.out).toContain(".devguard.yaml");
  });

  it("builds npm and go commands per component; PATH tools and Java build files are left to the person", async () => {
    const dir = repo({
      ".devguard.yaml":
        "standard: team@1.0.0\ncomponents:\n  - path: web/\n    language: typescript\n" +
        "  - path: svc/\n    language: go\n  - path: api/\n    language: java\n",
      "web/package-lock.json": JSON.stringify({ packages: { "node_modules/eslint": { version: "10.1.0" } } }),
      "svc/go.mod": "module x\n\ngo 1.26\n\ntool mvdan.cc/gofumpt\n\nrequire mvdan.cc/gofumpt v0.9.1\n",
      "api/pom.xml":
        "<project><build><plugins><plugin><artifactId>maven-pmd-plugin</artifactId><version>3.26.0</version>" +
        "</plugin></plugins></build></project>",
    });
    let target = version("team@1.1.0");
    target = withItem(target, "typescript", "tools.eslint", ">=11,<12");
    target = withItem(target, "go", "tools.gofumpt", ">=0.10,<1");
    target = withItem(target, "go", "tools.golangci-lint", ">=2.13,<3");
    target = withItem(target, "java", "tools.maven-pmd-plugin", ">=3.27,<4");
    let out = "";
    await runStandardUpgrade({
      cwd: dir,
      today: TODAY,
      bundled: [team_1_0_0, target],
      apply: false,
      tools: fakeTools().tools,
      write: (t) => (out += t),
    });
    expect(out).toContain(
      "cd web && npm install --save-dev eslint@>=11 <12（鏡像：https://nexus.example.internal/repository/npm-proxy/）",
    );
    expect(out).toContain("cd svc && go get -tool mvdan.cc/gofumpt@v0.10.0（");
    expect(out).toMatch(/把版本在 \S+ 內的 golangci-lint binary 放進 PATH（請自行執行）/);
    expect(out).toContain("請在 api/pom.xml 把 maven-pmd-plugin 改成 >=3.27,<4 內的版本");
  });
});

describe("the upgrade suggestion is doctor's, not check's (SPEC §5.5)", () => {
  const bundled = [team_1_0_0, version("team@1.1.0")];

  it("check does not report it", async () => {
    const dir = repo({ ".devguard.yaml": "standard: team@1.0.0\ncomponents: []\n" });
    const { findings } = await runCheck({ cwd: dir, today: TODAY }, [createDeclarationLayer({ bundled })]);
    expect(rules(findings)).not.toContain("hint:standard/upgrade-available");
  });

  it("doctor adds standard/upgrade-available when a newer minor is bundled", async () => {
    const dir = repo({ ".devguard.yaml": "standard: team@1.0.0\ncomponents: []\n" });
    const checks = [createStandardUpgradeCheck(bundled)];
    const { findings } = await runDoctor({ cwd: dir, today: TODAY, checks });
    expect(rules(findings)).toContain("hint:standard/upgrade-available");
    expect(read(dir, ".devguard.yaml")).toContain("team@1.0.0");
  });
});
