import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.ts";
import { createNpmAuditCheck, type BulkProbe } from "../src/environment/npm-audit.ts";
import { rules, TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(declaration: string): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-audit-"));
  dirs.push(dir);
  writeFileSync(join(dir, ".devguard.yaml"), declaration);
  return dir;
}

const decl = (overrides: string, auth = "") =>
  `standard: team@1.0.0\ncomponents:\n  - path: web/\n    language: typescript\n    overrides: ${overrides}\n${auth}`;

/** A probe that never touches the network: answers with `status` and records what was asked. */
function fakeProbe(status: number | Error) {
  const asked: { url: string; authorization?: string }[] = [];
  const probe: BulkProbe = (url, authorization) => {
    asked.push({ url, ...(authorization === undefined ? {} : { authorization }) });
    return status instanceof Error ? Promise.reject(status) : Promise.resolve(status);
  };
  return { probe, asked };
}

async function doctor(declaration: string, probe: BulkProbe, env: Record<string, string> = {}) {
  const checks = [createNpmAuditCheck({ probe })];
  return (await runDoctor({ cwd: project(declaration), today: TODAY, checks, env })).findings.filter(
    (f) => f.layer === "environment",
  );
}

describe("doctor: npm audit's bulk endpoint on the npm mirror (SPEC §5.3)", () => {
  it("probes the mirror's bulk endpoint when a TypeScript component scans for vulnerabilities", async () => {
    const { probe, asked } = fakeProbe(200);
    expect(await doctor(decl("{deps.vulnScan: true}"), probe)).toEqual([]);
    expect(asked).toEqual([
      { url: "https://nexus.example.internal/repository/npm-proxy/-/npm/v1/security/advisories/bulk" },
    ]);
  });

  it("gives a hint, not an error, when the endpoint is unavailable or unreachable", async () => {
    for (const answer of [404, 403, new Error("ECONNREFUSED")]) {
      const findings = await doctor(decl("{deps.vulnScan: true}"), fakeProbe(answer).probe);
      expect(rules(findings)).toEqual(["hint:environment/npm-audit-unavailable"]);
      expect(findings[0]?.message).toContain("Repository Firewall");
    }
  });

  it("sends the npm credentials variable when the mirror needs them, never printing it", async () => {
    const { probe, asked } = fakeProbe(401);
    const findings = await doctor(decl("{deps.vulnScan: true}", "mirrors:\n  auth: env\n"), probe, {
      NEXUS_NPM_AUTH: "c2VjcmV0OnNlY3JldA==",
    });
    expect(asked[0]?.authorization).toBe("Basic c2VjcmV0OnNlY3JldA==");
    expect(JSON.stringify(findings)).not.toContain("c2VjcmV0OnNlY3JldA==");
  });

  it("does not probe when no TypeScript component turns the scan on", async () => {
    const { probe, asked } = fakeProbe(500);
    expect(await doctor(decl("{}"), probe)).toEqual([]);
    expect(asked).toEqual([]);
  });
});
