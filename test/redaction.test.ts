import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Interaction } from "../src/fix/interaction.ts";
import { renderPlan } from "../src/fix/plan.ts";
import { runFix } from "../src/fix/run.ts";
import { runInstall } from "../src/hooks/install.ts";
import { redactSecrets } from "../src/report/redact.ts";
import { TODAY } from "./helpers.ts";
import { isolateGit } from "./git-isolation.ts";

// Real git runs here: keep it off any repo or config outside this file's temp directories.
isolateGit();

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>, git = false): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-redact-"));
  dirs.push(dir);
  if (git) execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

/** A non-interactive terminal without --yes: only previews. Collects stdout and stderr together. */
function previewOnly(): Interaction & { out: string } {
  const result = {
    out: "",
    yes: false,
    interactive: false,
    write: (text: string) => {
      result.out += text;
    },
    confirm: () => Promise.resolve(false),
  };
  return result;
}

const decl = (language: string, auth = false) =>
  `standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: ${language}\n${auth ? "mirrors:\n  auth: env\n" : ""}`;

const NPM = "https://nexus.example.internal/repository/npm-proxy/";
const SCOPE = "//nexus.example.internal/repository/npm-proxy/";

const SECRET_REPOS: [string, Record<string, string>, string[]][] = [
  [
    "npm _auth / _authToken / _password in .npmrc",
    {
      ".devguard.yaml": decl("typescript", true),
      ".npmrc": `registry=${NPM}\n${SCOPE}:_auth=SUPERSECRETVALUE123\n${SCOPE}:_authToken=TOKENSECRET456\n_password=PLAINPW789\n`,
    },
    ["SUPERSECRETVALUE123", "TOKENSECRET456", "PLAINPW789"],
  ],
  [
    "Maven <username> / <password> in .mvn/settings.xml",
    {
      ".devguard.yaml": decl("java"),
      "pom.xml": "<project></project>\n",
      ".mvn/settings.xml": `<?xml version="1.0" encoding="UTF-8"?>
<settings>
  <servers>
    <server>
      <id>nexus</id>
      <username>alice-the-user</username>
      <password>MAVENSECRET42</password>
    </server>
  </servers>
</settings>
`,
    },
    ["alice-the-user", "MAVENSECRET42"],
  ],
  [
    "a URL with user:password@ in pyproject.toml",
    {
      ".devguard.yaml": decl("python"),
      "pyproject.toml": `[project]
name = "app"
requires-python = ">=3.11"

[[tool.uv.index]]
name = "nexus"
url = "https://bob:PYSECRET99@nexus.example.internal/repository/other/simple"
default = true
`,
    },
    ["PYSECRET99", "bob:"],
  ],
];

describe("credentials never appear in a printed plan (SPEC §10.3)", () => {
  it.each(SECRET_REPOS)("fix preview: %s", async (_name, files, secrets) => {
    const dir = repo(files);
    const io = previewOnly();
    await runFix({ cwd: dir, today: TODAY, io });
    expect(io.out).not.toBe("");
    for (const secret of secrets) expect(io.out).not.toContain(secret);
  });

  it.each(SECRET_REPOS)("install preview: %s", async (_name, files, secrets) => {
    const dir = repo(files, true);
    const io = previewOnly();
    await runInstall({ cwd: dir, today: TODAY, io });
    expect(io.out).not.toBe("");
    for (const secret of secrets) expect(io.out).not.toContain(secret);
  });

  it("still shows that the credential line changes, with the value masked", async () => {
    const dir = repo(SECRET_REPOS[0]?.[1] ?? {});
    const io = previewOnly();
    await runFix({ cwd: dir, today: TODAY, io });
    expect(io.out).toContain(`-${SCOPE}:_auth=***`);
    expect(io.out).toContain(`+${SCOPE}:_auth=\${NEXUS_NPM_AUTH}`);
  });

  it("masks printed snippets too", () => {
    const text = renderPlan({
      writes: [],
      printed: [{ file: "../.m2/settings.xml", category: "user", lines: ["<password>hunter2</password>"] }],
    });
    expect(text).not.toContain("hunter2");
  });
});

describe("redactSecrets", () => {
  it.each([
    ["//host/path/:_auth=abc123", "//host/path/:_auth=***"],
    ["_authToken = abc123", "_authToken = ***"],
    ["<password>abc123</password>", "<password>***</password>"],
    ["      <username>alice</username>", "      <username>***</username>"],
    ["<passphrase>abc</passphrase>", "<passphrase>***</passphrase>"],
    ['url = "https://u:p@host/simple"', 'url = "https://***@host/simple"'],
    ["password: abc123", "password: ***"],
    ['token = "abc123"', 'token = "***"'],
    ["NEXUS_PASSWORD=abc123", "NEXUS_PASSWORD=***"],
  ])("%s", (line, masked) => {
    expect(redactSecrets(line)).toBe(masked);
  });

  it.each([
    "//host/path/:_auth=${NEXUS_NPM_AUTH}",
    "<password>${env.NEXUS_PASSWORD}</password>",
    "<username>${env.NEXUS_USERNAME}</username>",
    "registry=https://nexus.example.internal/repository/npm-proxy/",
    'authenticate = "always"',
    "password: ${NEXUS_PASSWORD}",
  ])("leaves %s alone", (line) => {
    expect(redactSecrets(line)).toBe(line);
  });
});
