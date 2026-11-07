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

  it("npm: accepts a quoted environment-variable reference, as npm strips the quotes", async () => {
    const npmrc = "//npm.example.com/:_authToken=\"${NPM_TOKEN}\"\n_auth='${NPM_AUTH}'\n";
    expect(await check({ ".devguard.yaml": decl("typescript"), ".npmrc": npmrc })).toEqual([]);
  });

  it("looks up each file in the component's directory and every directory above it, reporting a shared one once", async () => {
    const yaml =
      "standard: team@1.3.0\ncomponents:\n" +
      "  - {path: packages/a, language: typescript}\n  - {path: packages/b, language: typescript}\n";
    const leak = "_authToken=cHc=\n";
    const findings = await check({ ".devguard.yaml": yaml, ".npmrc": leak, "packages/b/.npmrc": leak });
    expect(findings.map((f) => [f.file, f.component])).toEqual([
      [".npmrc", "packages/a/ (TypeScript)"],
      ["packages/b/.npmrc", "packages/b/ (TypeScript)"],
    ]);
  });

  it("Python: reports a URL with a secret anywhere in pyproject.toml, named by its key path", async () => {
    const toml = [
      "[project]",
      'dependencies = ["requests", "lib @ https://user:pw1@files.example.com/lib.whl"]',
      "[tool.uv]",
      'extra-index-url = ["https://bob:pw2@pypi.example.com/simple"]',
      "[[tool.uv.index]]",
      'name = "corp"',
      'url = "https://alice:s3cret@pypi.example.com/simple"',
      "[tool.uv.pip]",
      'index-url = "https://dave:pw4@pypi.example.com/simple"',
      "[tool.uv.sources]",
      'tool = { git = "https://ghp_abcdef123456@github.com/org/tool" }',
      "[[tool.poetry.source]]",
      'name = "corp"',
      'url = "https://carol:pw3@pypi.example.com/simple"',
    ].join("\n");
    const findings = await check({ ".devguard.yaml": decl("python"), "pyproject.toml": toml });
    expect(findings.map((f) => f.message.replace(" 網址內含帳密；帳密不得進 repo", ""))).toEqual([
      "pyproject.toml 的 project.dependencies[1]",
      "pyproject.toml 的 tool.uv.extra-index-url[0]",
      "pyproject.toml 的 tool.uv.index[0].url",
      "pyproject.toml 的 tool.uv.pip.index-url",
      "pyproject.toml 的 tool.uv.sources.tool.git",
      "pyproject.toml 的 tool.poetry.source[0].url",
    ]);
    for (const secret of ["s3cret", "pw1", "pw2", "pw3", "pw4", "ghp_abcdef123456"])
      expect(JSON.stringify(findings)).not.toContain(secret);
  });

  it("Python: a bare username or a password that only references a variable is not a secret", async () => {
    const toml = [
      "[tool.uv]",
      'find-links = ["https://git@internal-host/wheels/", "https://deploy:${DEPLOY_TOKEN}@internal-host/more/"]',
      "[[tool.poetry.source]]",
      'name = "corp"',
      'url = "https://deploy@nexus.example.com/simple"',
    ].join("\n");
    expect(await check({ ".devguard.yaml": decl("python"), "pyproject.toml": toml })).toEqual([]);
  });

  it("Python: leaves a pyproject.toml that is not valid TOML to the Python settings check", async () => {
    expect(await check({ ".devguard.yaml": decl("python"), "pyproject.toml": "[project\n" })).toEqual([]);
  });

  it("Java: reports a password in .mvn/settings.xml written in the clear", async () => {
    const settings = (inner: string) =>
      `<settings><servers><server><id>corp</id>\n${inner}</server></servers></settings>`;
    const findings = await check({
      ".devguard.yaml": decl("java"),
      ".mvn/settings.xml": settings("<password>hunter2</password>"),
    });
    expect(findings.map((f) => [f.rule, f.file, f.line])).toEqual([["credentials/plaintext", ".mvn/settings.xml", 2]]);
    expect(JSON.stringify(findings)).not.toContain("hunter2");
  });

  it("Java: accepts property references, encrypted and empty passwords, and a private key path", async () => {
    for (const inner of [
      "<password>${env.PW}</password>",
      "<password>${nexus.password}</password>",
      "<password>{COQLCE6DU6GtcS5P=}</password>",
      "<password></password>",
      "<passphrase/>",
      "<privateKey>${user.home}/.ssh/id_rsa</privateKey>",
    ]) {
      const xml = `<settings><servers><server><id>corp</id>${inner}</server></servers></settings>`;
      expect(await check({ ".devguard.yaml": decl("java"), ".mvn/settings.xml": xml }), inner).toEqual([]);
    }
    expect(await check({ ".devguard.yaml": decl("java"), ".mvn/settings.xml": "<settings>" })).toEqual([]);
  });
});
