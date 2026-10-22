import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import { createDepsLayer } from "../src/layers/deps.ts";
import type { Finding } from "../src/report/finding.ts";
import type { ToolRequest, ToolResult, ToolRunner } from "../src/tools/runner.ts";
import { TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Setup {
  declaration: string;
  /** Files on disk, path → content. */
  files?: Record<string, string>;
  /** Files git tracks; defaults to every file on disk. */
  tracked?: string[] | "not-a-repo";
  tool?: (req: ToolRequest) => ToolResult;
}

async function check(setup: Setup): Promise<{ findings: Finding[]; requests: ToolRequest[] }> {
  const dir = mkdtempSync(join(tmpdir(), "devguard-deps-"));
  dirs.push(dir);
  const files = { ".devguard.yaml": setup.declaration, ...setup.files };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const requests: ToolRequest[] = [];
  const tools: ToolRunner = {
    run(req) {
      requests.push(req);
      return Promise.resolve(setup.tool?.(req) ?? { code: 0, stdout: "", stderr: "" });
    },
  };
  const tracked = setup.tracked ?? Object.keys(files);
  const layer = createDepsLayer({
    trackedFiles: () => Promise.resolve(tracked === "not-a-repo" ? undefined : tracked),
  });
  const r = await runCheck({ cwd: dir, today: TODAY, tools, listFiles: () => Promise.resolve(Object.keys(files)) }, [
    declarationLayer,
    layer,
  ]);
  return { findings: r.findings, requests };
}

/** `overrides`: lines indented by 6 spaces, e.g. "      deps.manager: poetry\n". */
const decl = (language: string, path = "./", overrides = "") =>
  `standard: team@1.0.0\ncomponents:\n  - path: ${path}\n    language: ${language}\n` +
  (overrides ? `    overrides:\n${overrides}` : "");

const summary = (findings: Finding[]) =>
  findings.map((f) => `${f.level}:${f.rule}:${f.component ?? ""}:${f.file ?? ""}`);

describe("deps layer: Python lockfile", () => {
  it("reports a missing uv.lock", async () => {
    const { findings } = await check({ declaration: decl("python"), files: { "pyproject.toml": "" } });
    expect(summary(findings)).toEqual(["error:deps/lockfile-missing:./ (Python):uv.lock"]);
  });

  it("passes with a committed uv.lock or poetry.lock", async () => {
    for (const lock of ["uv.lock", "poetry.lock"]) {
      const { findings } = await check({ declaration: decl("python"), files: { "pyproject.toml": "", [lock]: "" } });
      expect(findings).toEqual([]);
    }
  });

  it("reports a lockfile that exists but is not tracked by git", async () => {
    const { findings } = await check({
      declaration: decl("python"),
      files: { "pyproject.toml": "", "uv.lock": "" },
      tracked: [".devguard.yaml", "pyproject.toml"],
    });
    expect(summary(findings)).toEqual(["error:deps/lockfile-untracked:./ (Python):uv.lock"]);
    expect(findings[0]?.fix).toBe("git add uv.lock");
  });

  it("does not count a requirements.txt without hashes, and says so", async () => {
    const { findings } = await check({
      declaration: decl("python"),
      files: { "requirements.txt": "requests==2.32.0\n" },
    });
    expect(summary(findings)).toEqual(["error:deps/lockfile-missing:./ (Python):uv.lock"]);
    expect(findings[0]?.message).toContain("requirements.txt");
  });

  it("uses poetry.lock in the message when deps.manager is poetry", async () => {
    const { findings } = await check({
      declaration: decl("python", "svc/", "      deps.manager: poetry\n"),
      files: { "svc/pyproject.toml": "" },
    });
    expect(summary(findings)).toEqual(["error:deps/lockfile-missing:svc/ (Python):svc/poetry.lock"]);
  });

  it("accepts a workspace lockfile in a parent directory", async () => {
    const { findings } = await check({
      declaration: decl("python", "packages/a/"),
      files: { "packages/a/pyproject.toml": "", "uv.lock": "" },
    });
    expect(findings).toEqual([]);
  });

  it("checks existence only outside a git repo", async () => {
    const { findings } = await check({
      declaration: decl("python"),
      files: { "uv.lock": "" },
      tracked: "not-a-repo",
    });
    expect(findings).toEqual([]);
  });

  it("skips the lockfile rule when deps.lockfile is turned off", async () => {
    const { findings } = await check({
      declaration: decl("python", "./", "      deps.lockfile: {value: false, reason: legacy}\n"),
    });
    expect(summary(findings)).toEqual(["deviation:declaration/deviation:./ (Python):.devguard.yaml"]);
  });
});

describe("deps layer: Python requirements.txt with hashes", () => {
  it("counts a fully hashed requirements.txt as the lockfile", async () => {
    const { findings } = await check({
      declaration: decl("python"),
      files: { "requirements.txt": "# pinned\nrequests==2.32.0 \\\n    --hash=sha256:abc\n" },
    });
    expect(findings).toEqual([]);
  });
});

describe("deps layer: TypeScript lockfile", () => {
  it("requires package-lock.json for npm", async () => {
    const { findings } = await check({ declaration: decl("typescript", "web/"), files: { "web/package.json": "{}" } });
    expect(summary(findings)).toEqual(["error:deps/lockfile-missing:web/ (TypeScript):web/package-lock.json"]);
  });

  it("follows deps.manager", async () => {
    const pnpm = decl("typescript", "./", "      deps.manager: pnpm\n");
    expect((await check({ declaration: pnpm, files: { "pnpm-lock.yaml": "" } })).findings).toEqual([]);
    const wrong = await check({ declaration: pnpm, files: { "package-lock.json": "{}" } });
    expect(summary(wrong.findings)).toEqual(["error:deps/lockfile-missing:./ (TypeScript):pnpm-lock.yaml"]);
    const yarn = decl("typescript", "app/", "      deps.manager: yarn\n");
    expect((await check({ declaration: yarn, files: { "yarn.lock": "" } })).findings).toEqual([]);
  });
});

const GO_MOD = "module example.com/app\n\ngo 1.26\n\nrequire (\n\tgithub.com/google/uuid v1.6.0\n)\n";

describe("deps layer: Go", () => {
  it("passes with go.mod and go.sum committed and a tidy module", async () => {
    const { findings, requests } = await check({
      declaration: decl("go", "svc/"),
      files: { "svc/go.mod": GO_MOD, "svc/go.sum": "" },
    });
    expect(findings).toEqual([]);
    expect(requests).toEqual([{ language: "go", tool: "go", dir: "svc/", args: ["mod", "tidy", "-diff"] }]);
  });

  it("requires go.sum once the module has requirements", async () => {
    const { findings } = await check({ declaration: decl("go"), files: { "go.mod": GO_MOD } });
    expect(summary(findings)).toEqual(["error:deps/lockfile-missing:./ (Go):go.sum"]);
  });

  it("does not require go.sum for a module without requirements", async () => {
    const { findings } = await check({ declaration: decl("go"), files: { "go.mod": "module m\n\ngo 1.26\n" } });
    expect(findings).toEqual([]);
  });

  it("reports a missing go.mod without running go", async () => {
    const { findings, requests } = await check({ declaration: decl("go") });
    expect(summary(findings)).toEqual(["error:deps/lockfile-missing:./ (Go):go.mod"]);
    expect(requests).toEqual([]);
  });

  it("reports an untidy module with the diff and the fix", async () => {
    const { findings } = await check({
      declaration: decl("go", "svc/"),
      files: { "svc/go.mod": GO_MOD, "svc/go.sum": "" },
      tool: () => ({ code: 1, stdout: "--- go.mod\n+++ go.mod\n-\tgithub.com/google/uuid v1.6.0\n", stderr: "" }),
    });
    expect(summary(findings)).toEqual(["error:deps/go-mod-untidy:svc/ (Go):svc/go.mod"]);
    expect(findings[0]?.message).toContain("github.com/google/uuid");
    expect(findings[0]?.fix).toBe("cd svc && go mod tidy");
  });

  it("shows stderr when go fails without a diff", async () => {
    const { findings } = await check({
      declaration: decl("go"),
      files: { "go.mod": "module m\n" },
      tool: () => ({ code: 1, stdout: "", stderr: "go: module lookup disabled by GOPROXY=off" }),
    });
    expect(findings[0]?.message).toContain("GOPROXY=off");
    expect(findings[0]?.fix).toBe("go mod tidy");
  });
});

const POM = (plugins: string, deps = "") => `<project>
  <dependencies>${deps}
  </dependencies>
  <build><plugins>${plugins}</plugins></build>
</project>
`;
const ENFORCER = `<plugin>
  <artifactId>maven-enforcer-plugin</artifactId>
  <configuration><rules>
    <banDynamicVersions/>
    <dependencyConvergence/>
  </rules></configuration>
</plugin>`;

describe("deps layer: Java", () => {
  it("passes a pom.xml whose Enforcer has both rules", async () => {
    const { findings } = await check({ declaration: decl("java"), files: { "pom.xml": POM(ENFORCER) } });
    expect(findings).toEqual([]);
  });

  it("reports missing Enforcer rules, ignoring commented-out ones", async () => {
    const commented = ENFORCER.replace("<dependencyConvergence/>", "<!-- <dependencyConvergence/> -->");
    const { findings } = await check({ declaration: decl("java"), files: { "pom.xml": POM(commented) } });
    expect(summary(findings)).toEqual(["error:deps/enforcer-rule-missing:./ (Java):pom.xml"]);
    expect(findings[0]?.message).toContain("dependencyConvergence");
    expect(findings[0]?.message).not.toContain("banDynamicVersions");

    const none = await check({ declaration: decl("java"), files: { "pom.xml": POM("") } });
    expect(none.findings[0]?.message).toContain("banDynamicVersions、dependencyConvergence");
  });

  it("reports a missing pom.xml", async () => {
    const { findings } = await check({ declaration: decl("java") });
    expect(summary(findings)).toEqual(["error:deps/manifest-missing:./ (Java):pom.xml"]);
  });

  it("requires gradle.lockfile for Gradle", async () => {
    const gradle = decl("java", "api/", "      build.tool: gradle\n");
    const missing = await check({ declaration: gradle, files: { "api/build.gradle": "" } });
    expect(summary(missing.findings)).toEqual(["error:deps/lockfile-missing:api/ (Java):api/gradle.lockfile"]);
    const ok = await check({ declaration: gradle, files: { "api/build.gradle": "", "api/gradle.lockfile": "" } });
    expect(ok.findings).toEqual([]);
  });
});

describe("deps layer: banned packages", () => {
  const at = (findings: Finding[]) =>
    findings.filter((f) => f.rule === "deps/banned").map((f) => `${f.file ?? ""}:${String(f.line)}:${f.message}`);

  it("finds banned Python packages in pyproject.toml and requirements.txt, by normalized name", async () => {
    const pyproject = [
      "[project]",
      'name = "app"',
      "dependencies = [",
      '  "requests>=2",',
      '  "PyCrypto==2.6",',
      "]",
      "[project.optional-dependencies]",
      'test = ["nose; python_version<\'3\'", "pytest"]',
      "[dependency-groups]",
      'dev = [{include-group = "nose"}, "ruff"]',
      "[tool.poetry.group.dev.dependencies]",
      'python = "^3.11"',
      'nose = "*"',
      "[tool.ruff]",
      'select = ["nose"]',
    ].join("\n");
    const { findings } = await check({
      declaration: decl("python"),
      files: { "uv.lock": "", "pyproject.toml": pyproject, "requirements.txt": "-r base.txt\n# x\nnose==1.3\n" },
    });
    expect(at(findings)).toEqual([
      "pyproject.toml:5:直接依賴了禁用套件 PyCrypto",
      "pyproject.toml:8:直接依賴了禁用套件 nose",
      "pyproject.toml:13:直接依賴了禁用套件 nose",
      "requirements.txt:3:直接依賴了禁用套件 nose",
    ]);
  });

  it("finds banned npm packages in any dependency section", async () => {
    const pkg = JSON.stringify(
      { dependencies: { moment: "^2", react: "^19" }, devDependencies: { "node-fetch": "^3" } },
      null,
      2,
    );
    const { findings } = await check({
      declaration: decl("typescript"),
      files: { "package.json": pkg, "package-lock.json": "{}" },
    });
    expect(at(findings)).toEqual([
      "package.json:3:直接依賴了禁用套件 moment",
      "package.json:7:直接依賴了禁用套件 node-fetch",
    ]);
  });

  it("ignores a package.json that is not valid JSON", async () => {
    const { findings } = await check({
      declaration: decl("typescript"),
      files: { "package.json": "{", "package-lock.json": "{}" },
    });
    expect(findings).toEqual([]);
  });

  it("finds banned Go modules among direct requirements only", async () => {
    const goMod = [
      "module m",
      "require github.com/pkg/errors v0.9.1",
      "require (",
      "\tgithub.com/golang/protobuf/v2 v2.0.0 // pinned",
      "\tgithub.com/golang/protobuf v1.5.4 // indirect",
      ")",
    ].join("\n");
    const { findings } = await check({ declaration: decl("go"), files: { "go.mod": goMod, "go.sum": "" } });
    expect(at(findings)).toEqual([
      "go.mod:2:直接依賴了禁用套件 github.com/pkg/errors",
      "go.mod:4:直接依賴了禁用套件 github.com/golang/protobuf/v2",
    ]);
  });

  it("finds banned Maven and Gradle coordinates", async () => {
    const deps = `
    <!-- <dependency><groupId>junit</groupId><artifactId>junit</artifactId></dependency> -->
    <dependency>
      <groupId>log4j</groupId>
      <artifactId>log4j</artifactId>
    </dependency>`;
    const maven = await check({ declaration: decl("java"), files: { "pom.xml": POM(ENFORCER, deps) } });
    expect(at(maven.findings)).toEqual(["pom.xml:4:直接依賴了禁用套件 log4j:log4j"]);

    const gradle = await check({
      declaration: decl("java", "./", "      build.tool: gradle\n"),
      files: {
        "gradle.lockfile": "",
        "build.gradle.kts":
          '// testImplementation("junit:junit:4.13")\ndependencies {\n  testImplementation("junit:junit:4.13.2")\n}\n',
      },
    });
    expect(at(gradle.findings)).toEqual(["build.gradle.kts:3:直接依賴了禁用套件 junit:junit"]);
  });

  it("no longer reports a package removed from deps.banned; the removal is a deviation", async () => {
    const { findings } = await check({
      declaration: decl(
        "typescript",
        "./",
        "      deps.banned: {value: [request, node-fetch], reason: 舊專案還在用}\n",
      ),
      files: { "package.json": '{"dependencies": {"moment": "^2"}}', "package-lock.json": "{}" },
    });
    expect(summary(findings)).toEqual(["deviation:declaration/deviation:./ (TypeScript):.devguard.yaml"]);
  });

  it("requires a reason for removing a banned package", async () => {
    const { findings } = await check({
      declaration: decl("typescript", "./", "      deps.banned: [request, node-fetch]\n"),
      files: { "package-lock.json": "{}" },
    });
    expect(summary(findings)).toEqual(["error:declaration/looser-without-reason:./ (TypeScript):.devguard.yaml"]);
  });

  it("reports packages the declaration adds to deps.banned", async () => {
    const { findings } = await check({
      declaration: decl("typescript", "./", "      deps.banned: [moment, request, node-fetch, lodash]\n"),
      files: { "package.json": '{"dependencies": {"lodash": "^4"}}', "package-lock.json": "{}" },
    });
    expect(summary(findings)).toEqual(["error:deps/banned:./ (TypeScript):package.json"]);
  });
});

describe("deps layer: without a usable declaration", () => {
  it("adds nothing when no component was resolved", async () => {
    const { findings } = await check({ declaration: "standard: team@9.9.9\ncomponents: []\n" });
    expect(summary(findings)).toEqual(["error:standard/newer-than-cli::.devguard.yaml"]);
  });
});
