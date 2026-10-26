import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import type { Interaction } from "../src/fix/interaction.ts";
import { runFix } from "../src/fix/run.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import { mirrorsLayer } from "../src/layers/mirrors.ts";
import type { Finding } from "../src/report/finding.ts";
import { rules, TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-mirrors-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const decl = (language: string, mirrors = "") =>
  `standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: ${language}\n${mirrors}`;

async function check(files: Record<string, string>): Promise<Finding[]> {
  return (await runCheck({ cwd: repo(files), today: TODAY }, [declarationLayer, mirrorsLayer])).findings;
}

const NPM = "https://nexus.example.internal/repository/npm-proxy/";

const YES: Interaction = {
  yes: true,
  interactive: false,
  write: () => undefined,
  confirm: () => Promise.resolve(false),
};

describe("npm: the project's .npmrc points at the npm mirror (SPEC §10.2)", () => {
  it("reports a missing .npmrc registry and repairs it as a managed key", async () => {
    const findings = await check({ ".devguard.yaml": decl("typescript") });
    expect(rules(findings)).toEqual(["error:mirrors/missing"]);
    expect(findings[0]).toMatchObject({ layer: "config", file: ".npmrc" });
    expect(findings[0]?.fix).toMatch(/^devguard fix/);
    expect(findings[0]?.repairs).toEqual([{ op: "set", file: ".npmrc", path: ["registry"], value: NPM }]);
  });

  it("passes when registry is the mirror (trailing slash optional)", async () => {
    const npmrc = "registry=https://nexus.example.internal/repository/npm-proxy\n";
    expect(await check({ ".devguard.yaml": decl("typescript"), ".npmrc": npmrc })).toEqual([]);
  });

  it("reports registries that point at an external source", async () => {
    const npmrc = "registry=https://registry.npmjs.org/\n@corp:registry=https://npm.pkg.github.com\n";
    const findings = await check({ ".devguard.yaml": decl("typescript"), ".npmrc": npmrc });
    expect(rules(findings)).toEqual(["error:mirrors/external", "error:mirrors/external"]);
    expect(findings[0]?.message).toContain("https://registry.npmjs.org/");
    expect(findings.flatMap((f) => f.repairs)).toEqual([
      { op: "set", file: ".npmrc", path: ["registry"], value: NPM },
      { op: "set", file: ".npmrc", path: ["@corp:registry"], value: NPM },
    ]);
  });

  it("follows a declared mirror override, which needs a reason when it leaves the internal host", async () => {
    const npmrc = { ".npmrc": "registry=https://registry.npmjs.org/\n" };
    const bare = decl("typescript", "mirrors:\n  npm: https://registry.npmjs.org/\n");
    expect(rules(await check({ ".devguard.yaml": bare, ...npmrc }))).toEqual([
      "error:declaration/looser-without-reason",
    ]);
    const reasoned = decl("typescript", "mirrors:\n  npm: {value: https://registry.npmjs.org/, reason: 公司外開發}\n");
    expect(rules(await check({ ".devguard.yaml": reasoned, ...npmrc }))).toEqual(["deviation:declaration/deviation"]);
    const internal = decl("typescript", "mirrors:\n  npm: https://nexus.example.internal/repository/npm-group/\n");
    const internalNpmrc = { ".npmrc": "registry=https://nexus.example.internal/repository/npm-group/\n" };
    expect(await check({ ".devguard.yaml": internal, ...internalNpmrc })).toEqual([]);
  });

  describe("with mirrors.auth: env (SPEC §10.3)", () => {
    const yaml = decl("typescript", "mirrors:\n  auth: env\n");
    const AUTH_KEY = "//nexus.example.internal/repository/npm-proxy/:_auth";

    it("requires the registry-scoped _auth (or _authToken) to reference an environment variable", async () => {
      const findings = await check({ ".devguard.yaml": yaml, ".npmrc": `registry=${NPM}\n` });
      expect(rules(findings)).toEqual(["error:mirrors/auth-missing"]);
      expect(findings[0]?.repairs).toEqual([
        { op: "set", file: ".npmrc", path: [AUTH_KEY], value: "${NEXUS_NPM_AUTH}" },
      ]);
      const token = `registry=${NPM}\n//nexus.example.internal/repository/npm-proxy/:_authToken=\${NEXUS_NPM_TOKEN}\n`;
      expect(await check({ ".devguard.yaml": yaml, ".npmrc": token })).toEqual([]);
    });

    it("reports a credential written into .npmrc without printing it", async () => {
      const findings = await check({ ".devguard.yaml": yaml, ".npmrc": `registry=${NPM}\n${AUTH_KEY}=c2VjcmV0OnB3\n` });
      expect(rules(findings)).toEqual(["error:mirrors/plaintext-credentials"]);
      expect(JSON.stringify(findings)).not.toContain("c2VjcmV0OnB3");
      expect(findings[0]?.repairs).toEqual([
        { op: "set", file: ".npmrc", path: [AUTH_KEY], value: "${NEXUS_NPM_AUTH}" },
      ]);
    });
  });

  it("checks the .npmrc of each TypeScript component's directory", async () => {
    const yaml = "standard: team@1.0.0\ncomponents:\n  - path: web\n    language: typescript\n";
    const findings = await check({ ".devguard.yaml": yaml, ".npmrc": `registry=${NPM}\n` });
    expect(findings.map((f) => [f.rule, f.file, f.component])).toEqual([
      ["mirrors/missing", "web/.npmrc", "web/ (TypeScript)"],
    ]);
  });

  it("reports a credential in .npmrc even without mirrors.auth: env", async () => {
    const npmrc = `registry=${NPM}\n//nexus.example.internal/repository/npm-proxy/:_password=cHc=\n`;
    const findings = await check({ ".devguard.yaml": decl("typescript"), ".npmrc": npmrc });
    expect(rules(findings)).toEqual(["error:mirrors/plaintext-credentials"]);
    expect(JSON.stringify(findings)).not.toContain("cHc=");
  });
});

const PYPI = "https://nexus.example.internal/repository/pypi-proxy/simple";
const NEXUS_INDEX = `[[tool.uv.index]]\nname = "nexus"\nurl = "${PYPI}"\ndefault = true\n`;

describe("uv: [[tool.uv.index]] in pyproject.toml points at the PyPI mirror (SPEC §10.2)", () => {
  it("reports a missing nexus index and repairs it by adding one", async () => {
    const findings = await check({ ".devguard.yaml": decl("python"), "pyproject.toml": '[project]\nname = "a"\n' });
    expect(rules(findings)).toEqual(["error:mirrors/missing"]);
    expect(findings[0]?.file).toBe("pyproject.toml");
    expect(findings[0]?.fix).toMatch(/^devguard fix/);
    expect(findings[0]?.repairs).toEqual([
      {
        op: "add",
        file: "pyproject.toml",
        path: ["tool", "uv", "index"],
        value: { name: "nexus", url: PYPI, default: true },
      },
    ]);
  });

  it("passes with the nexus index", async () => {
    expect(await check({ ".devguard.yaml": decl("python"), "pyproject.toml": NEXUS_INDEX })).toEqual([]);
  });

  it("repairs the nexus index in place when its url or default is wrong", async () => {
    const toml = `[[tool.uv.index]]\nname = "other"\nurl = "${PYPI}"\n\n[[tool.uv.index]]\nname = "nexus"\nurl = "https://pypi.org/simple"\n`;
    const findings = await check({ ".devguard.yaml": decl("python"), "pyproject.toml": toml });
    expect(rules(findings)).toEqual(["error:mirrors/external", "error:mirrors/missing"]);
    expect(findings.flatMap((f) => f.repairs)).toEqual([
      { op: "set", file: "pyproject.toml", path: ["tool", "uv", "index", 1, "url"], value: PYPI },
      { op: "set", file: "pyproject.toml", path: ["tool", "uv", "index", 1, "default"], value: true },
    ]);
  });

  it("reports other indexes and index settings that point at an external source", async () => {
    const toml = `[tool.uv]\nextra-index-url = ["https://download.pytorch.org/whl"]\n\n${NEXUS_INDEX}\n[[tool.uv.index]]\nname = "pytorch"\nurl = "https://download.pytorch.org/whl/cu121"\n`;
    const findings = await check({ ".devguard.yaml": decl("python"), "pyproject.toml": toml });
    expect(rules(findings)).toEqual(["error:mirrors/external", "error:mirrors/external"]);
    expect(findings.map((f) => f.message).join()).toContain("https://download.pytorch.org/whl/cu121");
    expect(findings.every((f) => !f.fix?.startsWith("devguard fix"))).toBe(true);
  });

  it("with mirrors.auth: env, asks uv to always authenticate", async () => {
    const yaml = decl("python", "mirrors:\n  auth: env\n");
    const findings = await check({ ".devguard.yaml": yaml, "pyproject.toml": NEXUS_INDEX });
    expect(rules(findings)).toEqual(["error:mirrors/auth-missing"]);
    expect(findings[0]?.repairs).toEqual([
      { op: "set", file: "pyproject.toml", path: ["tool", "uv", "index", 0, "authenticate"], value: "always" },
    ]);
    const ok = `${NEXUS_INDEX}authenticate = "always"\n`;
    expect(await check({ ".devguard.yaml": yaml, "pyproject.toml": ok })).toEqual([]);
  });

  it("reports credentials embedded in an index URL without printing them", async () => {
    const toml = NEXUS_INDEX.replace("https://", "https://alice:s3cret@");
    const findings = await check({ ".devguard.yaml": decl("python"), "pyproject.toml": toml });
    expect(rules(findings)).toContain("error:mirrors/plaintext-credentials");
    expect(JSON.stringify(findings)).not.toContain("s3cret");
  });

  it("adds the index to a pyproject.toml fix creates, and leaves an invalid one to the Python settings check", async () => {
    expect(rules(await check({ ".devguard.yaml": decl("python") }))).toEqual(["error:mirrors/missing"]);
    expect(await check({ ".devguard.yaml": decl("python"), "pyproject.toml": "[[[" })).toEqual([]);
  });
});

const NEXUS_SOURCE = `[[tool.poetry.source]]\nname = "nexus"\nurl = "${PYPI}"\npriority = "primary"\n`;

describe("Poetry: [[tool.poetry.source]] in pyproject.toml points at the PyPI mirror (#53)", () => {
  const poetry = (pyproject?: string, yaml = decl("python")): Record<string, string> => ({
    ".devguard.yaml": yaml,
    "poetry.lock": "",
    ...(pyproject === undefined ? {} : { "pyproject.toml": pyproject }),
  });

  it("reports a missing nexus source, not a uv index, and repairs it by adding one", async () => {
    const findings = await check(poetry('[tool.poetry]\nname = "a"\n'));
    expect(rules(findings)).toEqual(["error:mirrors/missing"]);
    expect(findings[0]?.message).toContain("[[tool.poetry.source]]");
    expect(findings[0]?.fix).toMatch(/^devguard fix/);
    expect(findings[0]?.repairs).toEqual([
      {
        op: "add",
        file: "pyproject.toml",
        path: ["tool", "poetry", "source"],
        value: { name: "nexus", url: PYPI, priority: "primary" },
      },
    ]);
  });

  it("passes with the nexus source, even with mirrors.auth: env (credentials come from POETRY_HTTP_BASIC_NEXUS_*)", async () => {
    expect(await check(poetry(NEXUS_SOURCE))).toEqual([]);
    expect(await check(poetry(NEXUS_SOURCE, decl("python", "mirrors:\n  auth: env\n")))).toEqual([]);
  });

  it("reports a nexus source on pypi.org, and other sources that point at an external source", async () => {
    const toml =
      NEXUS_SOURCE.replace(PYPI, "https://pypi.org/simple") +
      '\n[[tool.poetry.source]]\nname = "pytorch"\nurl = "https://download.pytorch.org/whl/cu121"\npriority = "supplemental"\n';
    const findings = await check(poetry(toml));
    expect(rules(findings)).toEqual(["error:mirrors/external", "error:mirrors/external"]);
    expect(findings.map((f) => f.message).join()).toContain("https://download.pytorch.org/whl/cu121");
    expect(findings.flatMap((f) => f.repairs ?? [])).toEqual([
      { op: "set", file: "pyproject.toml", path: ["tool", "poetry", "source", 0, "url"], value: PYPI },
    ]);
  });

  it("repairs a nexus source whose priority is not primary, since Poetry would still use PyPI", async () => {
    for (const toml of [
      NEXUS_SOURCE.replace('"primary"', '"supplemental"'),
      NEXUS_SOURCE.replace(/priority.*\n/, ""),
    ]) {
      const findings = await check(poetry(toml));
      expect(rules(findings)).toEqual(["error:mirrors/missing"]);
      expect(findings[0]?.message).toContain("priority");
      expect(findings[0]?.repairs).toEqual([
        { op: "set", file: "pyproject.toml", path: ["tool", "poetry", "source", 0, "priority"], value: "primary" },
      ]);
    }
  });

  it("reports credentials embedded in a source URL without printing them", async () => {
    const findings = await check(poetry(NEXUS_SOURCE.replace("https://", "https://alice:s3cret@")));
    expect(rules(findings)).toContain("error:mirrors/plaintext-credentials");
    expect(findings.find((f) => f.rule === "mirrors/plaintext-credentials")?.fix).toContain(
      "POETRY_HTTP_BASIC_NEXUS_USERNAME / POETRY_HTTP_BASIC_NEXUS_PASSWORD",
    );
    expect(JSON.stringify(findings)).not.toContain("s3cret");
  });

  it("devguard fix adds or repairs the nexus source, after which check is clean", async () => {
    const layers = [declarationLayer, mirrorsLayer];
    const yaml = decl("python", "mirrors:\n  auth: env\n");
    const broken = NEXUS_SOURCE.replace(PYPI, "https://pypi.org/simple").replace('"primary"', '"supplemental"');
    for (const pyproject of [undefined, '[tool.poetry]\nname = "a"\n', broken]) {
      const dir = repo(poetry(pyproject, yaml));
      expect(await runFix({ cwd: dir, today: TODAY, io: YES }, layers)).toBe(0);
      expect((await runCheck({ cwd: dir, today: TODAY }, layers)).findings).toEqual([]);
      expect(readFileSync(join(dir, "pyproject.toml"), "utf8")).not.toContain("tool.uv");
    }
  });
});

const MAVEN = "https://nexus.example.internal/repository/maven-public/";
const POM = "<project><modelVersion>4.0.0</modelVersion></project>\n";

const generated = (findings: Finding[], file: string): string => {
  const repair = findings.flatMap((f) => f.repairs ?? []).find((r) => r.file === file);
  if (repair?.op !== "generate") throw new Error(`no generated ${file}`);
  return repair.content;
};

describe("Maven: .mvn/settings.xml and .mvn/maven.config are generated by the CLI (SPEC §10.2, §9.2)", () => {
  it("reports both files missing and generates them", async () => {
    const findings = await check({ ".devguard.yaml": decl("java"), "pom.xml": POM });
    expect(findings.map((f) => `${f.rule} ${f.file ?? ""}`)).toEqual([
      "mirrors/missing .mvn/settings.xml",
      "mirrors/missing .mvn/maven.config",
    ]);
    expect(findings.every((f) => f.fix?.startsWith("devguard fix"))).toBe(true);
    const settings = generated(findings, ".mvn/settings.xml");
    expect(settings).toContain(`<url>${MAVEN}</url>`);
    expect(settings).toContain("<mirrorOf>*</mirrorOf>");
    expect(settings).not.toContain("<server>");
    expect(generated(findings, ".mvn/maven.config")).toBe("--settings .mvn/settings.xml\n");
  });

  it("passes with the generated files, and keeps other maven.config arguments", async () => {
    const first = await check({ ".devguard.yaml": decl("java"), "pom.xml": POM });
    const files = {
      ".devguard.yaml": decl("java"),
      "pom.xml": POM,
      ".mvn/settings.xml": generated(first, ".mvn/settings.xml"),
      ".mvn/maven.config": "-T 1C\n--settings .mvn/settings.xml\n",
    };
    expect(await check(files)).toEqual([]);
    const findings = await check({ ...files, ".mvn/maven.config": "-T 1C\n-s other.xml\n" });
    expect(generated(findings, ".mvn/maven.config")).toBe("-T 1C\n--settings .mvn/settings.xml\n");
  });

  it("reports a mirror or repository that points at an external source", async () => {
    const settings = `<settings>
  <mirrors><mirror><id>central</id><mirrorOf>*</mirrorOf><url>https://repo.maven.apache.org/maven2</url></mirror></mirrors>
  <profiles><profile><repositories><repository><url>https://jitpack.io</url></repository></repositories></profile></profiles>
</settings>`;
    const findings = await check({
      ".devguard.yaml": decl("java"),
      "pom.xml": POM,
      ".mvn/settings.xml": settings,
      ".mvn/maven.config": "--settings .mvn/settings.xml\n",
    });
    expect(rules(findings)).toEqual(["error:mirrors/external", "error:mirrors/external"]);
    expect(findings[0]).toMatchObject({ file: ".mvn/settings.xml", line: 2 });
    expect(generated(findings, ".mvn/settings.xml")).toContain(MAVEN);
  });

  describe("with mirrors.auth: env (SPEC §10.3)", () => {
    const yaml = decl("java", "mirrors:\n  auth: env\n");

    it("generates a <server> with the mirror's id that reads NEXUS_USERNAME / NEXUS_PASSWORD", async () => {
      const findings = await check({ ".devguard.yaml": yaml, "pom.xml": POM });
      const settings = generated(findings, ".mvn/settings.xml");
      expect(settings).toMatch(
        /<server>\s*<id>nexus<\/id>\s*<username>\$\{env\.NEXUS_USERNAME\}<\/username>\s*<password>\$\{env\.NEXUS_PASSWORD\}<\/password>/,
      );
      const files = {
        ".devguard.yaml": yaml,
        "pom.xml": POM,
        ".mvn/settings.xml": settings,
        ".mvn/maven.config": "--settings .mvn/settings.xml\n",
      };
      expect(await check(files)).toEqual([]);
      const noServer = settings.replace(/<servers>[\s\S]*<\/servers>/, "");
      expect(rules(await check({ ...files, ".mvn/settings.xml": noServer }))).toEqual(["error:mirrors/auth-missing"]);
    });

    it("reports a password written into settings.xml without printing it", async () => {
      const first = await check({ ".devguard.yaml": yaml, "pom.xml": POM });
      const settings = generated(first, ".mvn/settings.xml").replace("${env.NEXUS_PASSWORD}", "hunter2");
      const findings = await check({
        ".devguard.yaml": yaml,
        "pom.xml": POM,
        ".mvn/settings.xml": settings,
        ".mvn/maven.config": "--settings .mvn/settings.xml\n",
      });
      expect(rules(findings)).toEqual(["error:mirrors/plaintext-credentials"]);
      expect(JSON.stringify(findings.map((f) => [f.message, f.fix]))).not.toContain("hunter2");
      expect(generated(findings, ".mvn/settings.xml")).not.toContain("hunter2");
    });
  });

  it("reports a settings.xml that is not valid XML", async () => {
    const findings = await check({
      ".devguard.yaml": decl("java"),
      "pom.xml": POM,
      ".mvn/settings.xml": "<settings>",
      ".mvn/maven.config": "--settings .mvn/settings.xml\n",
    });
    expect(rules(findings)).toEqual(["error:mirrors/missing"]);
  });
});

describe("devguard fix writes the project-level mirror settings (SPEC §9.2)", () => {
  it("writes .npmrc, the nexus index and the .mvn files, after which check is clean", async () => {
    const yaml = `standard: team@1.0.0\nmirrors:\n  auth: env\ncomponents:\n  - path: web\n    language: typescript\n  - path: py\n    language: python\n  - path: svc\n    language: java\n`;
    const dir = repo({
      ".devguard.yaml": yaml,
      "web/.npmrc": "# keep\nregistry=https://registry.npmjs.org/\n",
      "py/pyproject.toml": '[project]\nname = "a"\n',
      "svc/pom.xml": POM,
    });
    const layers = [declarationLayer, mirrorsLayer];
    expect((await runCheck({ cwd: dir, today: TODAY }, layers)).findings.length).toBeGreaterThan(0);
    expect(await runFix({ cwd: dir, today: TODAY, io: YES }, layers)).toBe(0);
    expect((await runCheck({ cwd: dir, today: TODAY }, layers)).findings).toEqual([]);
    expect(readFileSync(join(dir, "web/.npmrc"), "utf8")).toBe(
      `# keep\nregistry=${NPM}\n//nexus.example.internal/repository/npm-proxy/:_auth=\${NEXUS_NPM_AUTH}\n`,
    );
    expect(readFileSync(join(dir, "svc/.mvn/settings.xml"), "utf8")).toContain("由 CLI 產生");
    expect(readFileSync(join(dir, "svc/.mvn/maven.config"), "utf8")).toBe("--settings .mvn/settings.xml\n");
  });
});

describe("Gradle: settings.gradle repositories, printed as a snippet only (SPEC §10.2)", () => {
  const BUILD = "plugins { id 'java' }\n";

  it("reports missing mirror repositories and prints the snippet without writing it", async () => {
    const findings = await check({ ".devguard.yaml": decl("java"), "build.gradle": BUILD });
    expect(rules(findings)).toEqual(["error:mirrors/missing"]);
    expect(findings[0]?.file).toBe("settings.gradle");
    expect(findings[0]?.fix).not.toMatch(/^devguard fix/);
    const [repair] = findings[0]?.repairs ?? [];
    expect(repair).toMatchObject({ op: "snippet", file: "settings.gradle" });
    expect(repair?.op === "snippet" ? repair.text : "").toContain(`url = uri("${MAVEN}")`);
  });

  it("passes when settings.gradle uses only the mirror", async () => {
    const settings = `dependencyResolutionManagement {\n  repositories {\n    maven {\n      name = "nexus"\n      url = uri("${MAVEN}")\n    }\n  }\n}\n`;
    const files = { ".devguard.yaml": decl("java"), "build.gradle": BUILD, "settings.gradle": settings };
    expect(await check(files)).toEqual([]);
  });

  it("reports external repositories in the Gradle scripts", async () => {
    const settings = `dependencyResolutionManagement { repositories { maven { url = uri("${MAVEN}") } } }\n`;
    const findings = await check({
      ".devguard.yaml": decl("java"),
      "build.gradle.kts": 'repositories {\n  mavenCentral()\n  maven { url = uri("https://jitpack.io") }\n}\n',
      "settings.gradle.kts": settings,
    });
    expect(findings.map((f) => `${f.rule} ${f.file ?? ""}:${String(f.line)}`)).toEqual([
      "mirrors/external build.gradle.kts:2",
      "mirrors/external build.gradle.kts:3",
    ]);
  });

  it("with mirrors.auth: env, the snippet reads credentials from the nexus repository's properties", async () => {
    const findings = await check({
      ".devguard.yaml": decl("java", "mirrors:\n  auth: env\n"),
      "build.gradle.kts": BUILD,
    });
    const [repair] = findings[0]?.repairs ?? [];
    expect(findings[0]?.file).toBe("settings.gradle.kts");
    expect(repair?.op === "snippet" ? repair.text : "").toContain("credentials(PasswordCredentials::class)");
  });
});
