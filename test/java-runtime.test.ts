import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHECK_LAYERS, runCheck } from "../src/check.ts";
import { javaRuntimeCheck } from "../src/environment/java-runtime.ts";
import { ENVIRONMENT_CHECKS } from "../src/environment/registry.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import { createEnvironmentLayer } from "../src/layers/environment.ts";
import type { Command, Exec } from "../src/process/exec.ts";
import type { Finding } from "../src/report/finding.ts";
import { exitCodeFor } from "../src/report/render.ts";
import { rules, TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const decl = (language: string) => `standard: legacy@1.0.0\ncomponents:\n  - path: ./\n    language: ${language}\n`;

async function doctor(language: string, exec: Exec): Promise<Finding[]> {
  const dir = mkdtempSync(join(tmpdir(), "devguard-java-runtime-"));
  dirs.push(dir);
  writeFileSync(join(dir, ".devguard.yaml"), decl(language));
  const layer = createEnvironmentLayer({ checks: [javaRuntimeCheck], exec, env: {} });
  return (await runCheck({ cwd: dir, today: TODAY }, [declarationLayer, layer])).findings;
}

/** A fake `java -version`, which prints to stderr; records the commands it was asked to run. */
function javaVersion(stderr: string, calls: Command[] = []): Exec {
  return (command) => {
    calls.push(command);
    if (command.file !== "java") return Promise.reject(new Error(`unexpected ${command.file}`));
    return Promise.resolve({ code: 0, stdout: "", stderr });
  };
}

const JDK8 = 'java version "1.8.0_392"\nJava(TM) SE Runtime Environment (build 1.8.0_392-b08)\n';
const jdk = (version: string) => `openjdk version "${version}" 2024-01-16\nOpenJDK Runtime Environment\n`;

describe("doctor: the JDK that runs the Java tools (SPEC §6.5)", () => {
  it("hints when java -version reports JDK 8: the tools need JDK 11, the code can still target Java 8", async () => {
    const calls: Command[] = [];
    const findings = await doctor("java", javaVersion(JDK8, calls));
    expect(rules(findings)).toEqual(["hint:environment/java-runtime"]);
    expect(findings[0]?.layer).toBe("environment");
    expect(findings[0]?.message).toContain("JDK 11");
    expect(findings[0]?.message).toContain("Java 8");
    expect(findings[0]?.fix).toContain("JDK 17");
    expect(calls.map((c) => [c.file, ...c.args])).toEqual([["java", "-version"]]);
    expect(exitCodeFor(findings, true)).toBe(0);
  });

  it("passes on JDK 11, 17 and 21", async () => {
    for (const version of ["11.0.22", "17.0.10", "21"]) {
      expect(await doctor("java", javaVersion(jdk(version)))).toEqual([]);
    }
  });

  it("skips repos without a Java component, and a machine without java (check reports the tool failures)", async () => {
    const noExec: Exec = () => Promise.reject(new Error("unexpected process"));
    expect(await doctor("python", noExec)).toEqual([]);
    const missing: Exec = () => Promise.reject(Object.assign(new Error("spawn java ENOENT"), { code: "ENOENT" }));
    expect(await doctor("java", missing)).toEqual([]);
  });

  it("only doctor runs it", () => {
    expect(ENVIRONMENT_CHECKS).toContain(javaRuntimeCheck);
    expect(CHECK_LAYERS.map((l) => l.id)).not.toContain("environment");
  });
});
