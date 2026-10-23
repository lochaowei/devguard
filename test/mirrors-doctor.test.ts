import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import { goMirrorsCheck } from "../src/environment/go-mirrors.ts";
import { mirrorCredentialsCheck } from "../src/environment/mirror-credentials.ts";
import { ENVIRONMENT_CHECKS, type EnvironmentCheck } from "../src/environment/registry.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import { createEnvironmentLayer } from "../src/layers/environment.ts";
import type { Command, Exec } from "../src/process/exec.ts";
import type { Finding } from "../src/report/finding.ts";
import { rules, TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-mirrors-doctor-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const decl = (language: string, mirrors = "") =>
  `standard: team@1.0.0\n${mirrors}components:\n  - path: ./\n    language: ${language}\n`;

type Env = Record<string, string | undefined>;

async function doctor(
  check: EnvironmentCheck,
  files: Record<string, string>,
  { exec = noExec, env = {} }: { exec?: Exec; env?: Env } = {},
): Promise<Finding[]> {
  const layer = createEnvironmentLayer({ checks: [check], exec, env });
  return (await runCheck({ cwd: repo(files), today: TODAY }, [declarationLayer, layer])).findings;
}

const noExec: Exec = () => Promise.reject(new Error("unexpected process"));

const PROXY = "https://nexus.example.internal/repository/go-proxy/";
const SUMDB = "sum.golang.org https://nexus.example.internal/repository/go-sumdb-proxy/";

/** A fake `go env -json GOPROXY GOSUMDB`; records the commands it was asked to run. */
function goEnv(values: Record<string, string>, calls: Command[] = []): Exec {
  return (command) => {
    calls.push(command);
    if (command.file !== "go") return Promise.reject(new Error(`unexpected ${command.file}`));
    return Promise.resolve({ code: 0, stdout: JSON.stringify(values), stderr: "" });
  };
}

describe("doctor: the user-level Go mirror settings (SPEC §10.2)", () => {
  it("passes when GOPROXY and GOSUMDB go through the mirrors, and only reads them", async () => {
    const calls: Command[] = [];
    const exec = goEnv({ GOPROXY: PROXY, GOSUMDB: SUMDB }, calls);
    expect(await doctor(goMirrorsCheck, { ".devguard.yaml": decl("go") }, { exec })).toEqual([]);
    expect(calls.map((c) => [c.file, ...c.args])).toEqual([["go", "env", "-json", "GOPROXY", "GOSUMDB"]]);
  });

  it("reports the default GOPROXY and prints the go env -w command, without changing anything", async () => {
    const exec = goEnv({ GOPROXY: "https://proxy.golang.org,direct", GOSUMDB: SUMDB });
    const findings = await doctor(goMirrorsCheck, { ".devguard.yaml": decl("go") }, { exec });
    expect(rules(findings)).toEqual(["error:mirrors/go-proxy"]);
    expect(findings[0]).toMatchObject({ layer: "environment", fix: `go env -w GOPROXY=${PROXY}` });
    expect(findings[0]?.message).toContain("https://proxy.golang.org,direct");
  });

  it("reports GOSUMDB=off as an error, and a GOSUMDB that does not go through the mirror", async () => {
    const off = await doctor(
      goMirrorsCheck,
      { ".devguard.yaml": decl("go") },
      { exec: goEnv({ GOPROXY: PROXY, GOSUMDB: "off" }) },
    );
    expect(rules(off)).toEqual(["error:mirrors/gosumdb-off"]);
    expect(off[0]?.fix).toBe(`go env -w GOSUMDB="${SUMDB}"`);

    const direct = await doctor(
      goMirrorsCheck,
      { ".devguard.yaml": decl("go") },
      { exec: goEnv({ GOPROXY: `${PROXY},off`, GOSUMDB: "sum.golang.org" }) },
    );
    expect(rules(direct)).toEqual(["error:mirrors/gosumdb"]);
  });

  it("does not print credentials embedded in GOPROXY", async () => {
    const exec = goEnv({ GOPROXY: "https://bob:pa55@proxy.example.com", GOSUMDB: SUMDB });
    const findings = await doctor(goMirrorsCheck, { ".devguard.yaml": decl("go") }, { exec });
    expect(JSON.stringify(findings)).not.toContain("pa55");
  });

  it("skips repos without a Go component, and a machine without go (the tool check reports it)", async () => {
    expect(await doctor(goMirrorsCheck, { ".devguard.yaml": decl("python") })).toEqual([]);
    const missing: Exec = () => Promise.reject(Object.assign(new Error("spawn go ENOENT"), { code: "ENOENT" }));
    expect(await doctor(goMirrorsCheck, { ".devguard.yaml": decl("go") }, { exec: missing })).toEqual([]);
    const failing: Exec = () => Promise.resolve({ code: 1, stdout: "", stderr: "boom" });
    expect(await doctor(goMirrorsCheck, { ".devguard.yaml": decl("go") }, { exec: failing })).toEqual([]);
  });
});

const AUTH = "mirrors:\n  auth: env\n";

describe("doctor: mirror credentials are present, never read (SPEC §10.3)", () => {
  it("checks nothing with mirrors.auth: none", async () => {
    expect(await doctor(mirrorCredentialsCheck, { ".devguard.yaml": decl("python") })).toEqual([]);
  });

  it("Python: reports the missing UV_INDEX_NEXUS_* variables with how to set them on Windows", async () => {
    const findings = await doctor(mirrorCredentialsCheck, { ".devguard.yaml": decl("python", AUTH) });
    expect(rules(findings)).toEqual(["error:mirrors/credentials-missing"]);
    expect(findings[0]?.layer).toBe("environment");
    expect(findings[0]?.message).toContain("UV_INDEX_NEXUS_USERNAME");
    expect(findings[0]?.message).toContain("UV_INDEX_NEXUS_PASSWORD");
    expect(findings[0]?.fix).toContain("setx UV_INDEX_NEXUS_USERNAME");

    const env = { UV_INDEX_NEXUS_USERNAME: "alice", UV_INDEX_NEXUS_PASSWORD: "top-secret-value" };
    expect(await doctor(mirrorCredentialsCheck, { ".devguard.yaml": decl("python", AUTH) }, { env })).toEqual([]);
  });

  it("never prints a credential's value", async () => {
    const env = { UV_INDEX_NEXUS_USERNAME: "alice-secret", NEXUS_USERNAME: "bob-secret" };
    const findings = await doctor(mirrorCredentialsCheck, { ".devguard.yaml": decl("python", AUTH) }, { env });
    expect(rules(findings)).toEqual(["error:mirrors/credentials-missing"]);
    expect(findings[0]?.message).toContain("UV_INDEX_NEXUS_PASSWORD");
    expect(findings[0]?.message).not.toContain("UV_INDEX_NEXUS_USERNAME");
    expect(JSON.stringify(findings)).not.toMatch(/alice-secret|bob-secret/);
  });

  it("TypeScript: checks the variables the .npmrc references (npm sends ${VAR} as-is when unset)", async () => {
    const npmrc = "registry=x\n//nexus.example.internal/repository/npm-proxy/:_authToken=${NEXUS_NPM_TOKEN}\n";
    const files = { ".devguard.yaml": decl("typescript", AUTH), ".npmrc": npmrc };
    const findings = await doctor(mirrorCredentialsCheck, files);
    expect(findings[0]?.message).toContain("NEXUS_NPM_TOKEN");
    expect(await doctor(mirrorCredentialsCheck, files, { env: { NEXUS_NPM_TOKEN: "t" } })).toEqual([]);
    const none = await doctor(mirrorCredentialsCheck, { ".devguard.yaml": decl("typescript", AUTH) });
    expect(none[0]?.message).toContain("NEXUS_NPM_AUTH");
  });

  it("Maven: NEXUS_USERNAME / NEXUS_PASSWORD; Gradle: the ORG_GRADLE_PROJECT_ properties or gradle.properties", async () => {
    const maven = await doctor(mirrorCredentialsCheck, {
      ".devguard.yaml": decl("java", AUTH),
      "pom.xml": "<project/>",
    });
    expect(maven[0]?.message).toContain("NEXUS_PASSWORD");

    const gradle = { ".devguard.yaml": decl("java", AUTH), "build.gradle": "" };
    const missing = await doctor(mirrorCredentialsCheck, gradle, { env: { USERPROFILE: repo({}) } });
    expect(missing[0]?.message).toContain("ORG_GRADLE_PROJECT_nexusPassword");
    const home = repo({ "gradle.properties": "nexusUsername=a\n" });
    expect(await doctor(mirrorCredentialsCheck, gradle, { env: { GRADLE_USER_HOME: home } })).toEqual([]);
  });

  it("Go: the netrc file NETRC names, otherwise %USERPROFILE%\\_netrc, exists", async () => {
    const files = { ".devguard.yaml": decl("go", AUTH) };
    // Go's default: %USERPROFILE%\_netrc on Windows, $HOME/.netrc elsewhere.
    const name = process.platform === "win32" ? "_netrc" : ".netrc";
    const home = (dir: string) => ({ USERPROFILE: dir, HOME: dir });
    const profile = repo({});
    const findings = await doctor(mirrorCredentialsCheck, files, { env: home(profile) });
    expect(rules(findings)).toEqual(["error:mirrors/netrc-missing"]);
    expect(findings[0]?.message).toContain(join(profile, name));

    const withNetrc = repo({ [name]: "machine nexus.example.internal login a password b\n" });
    expect(await doctor(mirrorCredentialsCheck, files, { env: home(withNetrc) })).toEqual([]);
    const named = join(withNetrc, name);
    expect(await doctor(mirrorCredentialsCheck, files, { env: { NETRC: named, ...home(profile) } })).toEqual([]);
    const gone = await doctor(mirrorCredentialsCheck, files, { env: { NETRC: join(profile, "nope") } });
    expect(gone[0]?.message).toContain("NETRC");
  });

  it("is registered with doctor", () => {
    expect(ENVIRONMENT_CHECKS).toContain(mirrorCredentialsCheck);
    expect(ENVIRONMENT_CHECKS).toContain(goMirrorsCheck);
  });
});
