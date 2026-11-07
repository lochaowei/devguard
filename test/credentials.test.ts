import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import { credentialsLayer } from "../src/layers/credentials.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import type { Finding } from "../src/report/finding.ts";
import { rules, TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-credentials-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const decl = (language: string, path = "./") =>
  `standard: team@1.3.0\ncomponents:\n  - path: ${path}\n    language: ${language}\n`;

async function check(files: Record<string, string>): Promise<Finding[]> {
  return (await runCheck({ cwd: repo(files), today: TODAY }, [declarationLayer, credentialsLayer])).findings;
}

describe("credentials written into project files are errors, reported without their value", () => {
  it("passes a project without package-source settings", async () => {
    expect(await check({ ".devguard.yaml": decl("typescript") })).toEqual([]);
    expect(await check({ ".devguard.yaml": decl("python"), "pyproject.toml": '[project]\nname = "a"\n' })).toEqual([]);
    expect(await check({ ".devguard.yaml": decl("java") })).toEqual([]);
  });

  it("does not check where packages come from: any registry, index or source is fine (#64)", async () => {
    const npmrc = "registry=https://registry.npmjs.org/\n@corp:registry=https://npm.pkg.github.com\n";
    expect(await check({ ".devguard.yaml": decl("typescript"), ".npmrc": npmrc })).toEqual([]);
    const toml = '[[tool.uv.index]]\nname = "corp"\nurl = "https://pypi.example.com/simple"\n';
    expect(await check({ ".devguard.yaml": decl("python"), "pyproject.toml": toml })).toEqual([]);
  });

  it("npm: reports _auth, _authToken and _password unless they reference an environment variable", async () => {
    const npmrc = [
      "//npm.example.com/:_auth=c2VjcmV0OnB3",
      "_authToken=cHc=",
      "//npm.example.com/:_password=aHVudGVyMg==",
      "//npm.example.com/:_authToken=${NPM_TOKEN}",
    ].join("\n");
    const findings = await check({ ".devguard.yaml": decl("typescript"), ".npmrc": npmrc });
    expect(rules(findings)).toEqual([
      "error:credentials/plaintext",
      "error:credentials/plaintext",
      "error:credentials/plaintext",
    ]);
    expect(findings.map((f) => f.line)).toEqual([1, 2, 3]);
    for (const secret of ["c2VjcmV0OnB3", "cHc=", "aHVudGVyMg=="])
      expect(JSON.stringify(findings)).not.toContain(secret);
    expect(findings[0]?.repairs).toBeUndefined();
  });

  it("checks the .npmrc of each TypeScript component's directory", async () => {
    const leak = "_authToken=cHc=\n";
    const findings = await check({ ".devguard.yaml": decl("typescript", "web"), ".npmrc": leak, "web/.npmrc": leak });
    expect(findings.map((f) => [f.rule, f.file, f.component])).toEqual([
      ["credentials/plaintext", "web/.npmrc", "web/ (TypeScript)"],
    ]);
  });

  it("Python: reports user:password@ in uv indexes, uv index settings and Poetry sources", async () => {
    const toml = [
      "[tool.uv]",
      'extra-index-url = ["https://bob:pw2@pypi.example.com/simple"]',
      "[[tool.uv.index]]",
      'name = "corp"',
      'url = "https://alice:s3cret@pypi.example.com/simple"',
      "[[tool.poetry.source]]",
      'name = "corp"',
      'url = "https://carol:pw3@pypi.example.com/simple"',
    ].join("\n");
    const findings = await check({ ".devguard.yaml": decl("python"), "pyproject.toml": toml });
    expect(findings.map((f) => f.message)).toEqual([
      "pyproject.toml 的 [[tool.uv.index]] corp 網址內含帳密；帳密不得進 repo",
      "pyproject.toml 的 [tool.uv] extra-index-url 網址內含帳密；帳密不得進 repo",
      "pyproject.toml 的 [[tool.poetry.source]] corp 網址內含帳密；帳密不得進 repo",
    ]);
    for (const secret of ["s3cret", "pw2", "pw3"]) expect(JSON.stringify(findings)).not.toContain(secret);
  });

  it("Python: leaves a pyproject.toml that is not valid TOML to the Python settings check", async () => {
    expect(await check({ ".devguard.yaml": decl("python"), "pyproject.toml": "[project\n" })).toEqual([]);
  });

  it("Java: reports a password in .mvn/settings.xml unless it is an ${env.*} reference", async () => {
    const settings = (password: string) =>
      `<settings><servers><server><id>corp</id><username>u</username>\n<password>${password}</password></server></servers></settings>`;
    expect(await check({ ".devguard.yaml": decl("java"), ".mvn/settings.xml": settings("${env.PW}") })).toEqual([]);
    const findings = await check({ ".devguard.yaml": decl("java"), ".mvn/settings.xml": settings("hunter2") });
    expect(findings.map((f) => [f.rule, f.file, f.line])).toEqual([["credentials/plaintext", ".mvn/settings.xml", 2]]);
    expect(JSON.stringify(findings)).not.toContain("hunter2");
    expect(await check({ ".devguard.yaml": decl("java"), ".mvn/settings.xml": "<settings>" })).toEqual([]);
  });
});
