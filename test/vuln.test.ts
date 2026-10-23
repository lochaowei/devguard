import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECK_LAYERS, checkTestsAndCoverage, runCheck } from "../src/check.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import type { CheckScope } from "../src/layers/types.ts";
import { vulnLayer } from "../src/layers/vuln.ts";
import { DEPENDENCY_CHECK_VERSION } from "../src/vuln/java.ts";
import type { PackageRequest, ToolRequest, ToolResult, ToolRunner } from "../src/tools/runner.ts";
import { rules, TODAY } from "./helpers.ts";
import { argValue, declare, fakeTools, ok, project } from "./tests-helpers.ts";

/** `devguard check` with the declaration and vulnerability-scan layers only. */
function scan(
  declaration: string,
  answer: (req: ToolRequest) => ToolResult,
  files: string[],
  scope: CheckScope = { full: true },
) {
  const { tools, calls } = fakeTools(answer);
  const result = runCheck(
    { cwd: project(declaration), today: TODAY, tools, listFiles: () => Promise.resolve(files), scope },
    [declarationLayer, vulnLayer],
  );
  return { result, calls };
}

const vulnRules = async (p: ReturnType<typeof scan>) =>
  rules((await p.result).findings.filter((f) => f.layer === "code"));

/** govulncheck -json: a stream of pretty-printed JSON messages, one vulnerability called, one only imported. */
const GOVULNCHECK = `{
  "config": {
    "protocol_version": "v1.0.0",
    "scanner_name": "govulncheck",
    "db": "https://nexus.example.internal/repository/go-vulndb-proxy/",
    "scan_level": "symbol"
  }
}
{
  "progress": {
    "message": "Scanning your code and 12 packages across 3 dependent modules for known vulnerabilities..."
  }
}
{
  "osv": {
    "id": "GO-2024-2611",
    "aliases": ["CVE-2024-24786", "GHSA-8r3f-844c-mc37"],
    "summary": "Infinite loop in JSON unmarshaling in google.golang.org/protobuf"
  }
}
{
  "osv": {
    "id": "GO-2023-1840",
    "aliases": ["CVE-2023-29403"],
    "summary": "Unsafe behavior in setuid/setgid binaries in runtime"
  }
}
{
  "finding": {
    "osv": "GO-2024-2611",
    "fixed_version": "v1.33.0",
    "trace": [
      { "module": "google.golang.org/protobuf", "version": "v1.32.0", "package": "google.golang.org/protobuf/encoding/protojson", "function": "Unmarshal" },
      { "module": "example.com/app", "package": "example.com/app/cmd", "function": "main", "position": { "filename": "cmd/main.go", "line": 12 } }
    ]
  }
}
{
  "finding": {
    "osv": "GO-2023-1840",
    "fixed_version": "v1.20.5",
    "trace": [{ "module": "stdlib", "version": "v1.20.4", "package": "runtime" }]
  }
}
`;

describe("vulnerability scan", () => {
  it("does not run while deps.vulnScan is off (the default)", async () => {
    const p = scan(declare("svc/", "go"), () => ok(GOVULNCHECK), ["svc/main.go"]);
    expect(await vulnRules(p)).toEqual([]);
    expect(p.calls).toEqual([]);
  });

  it("runs only with --full (pre-push, check --full, CI)", async () => {
    const p = scan(declare("svc/", "go", "{deps.vulnScan: true}"), () => ok(GOVULNCHECK), ["svc/main.go"], {
      full: false,
    });
    await p.result;
    expect(p.calls).toEqual([]);
  });

  it("Go: runs govulncheck -json against mirrors.govulndb and reports called vulnerabilities", async () => {
    const p = scan(declare("svc/", "go", "{deps.vulnScan: true}"), () => ok(GOVULNCHECK), ["svc/main.go"]);
    const { findings } = await p.result;
    expect(p.calls).toEqual([
      {
        language: "go",
        tool: "govulncheck",
        dir: "svc/",
        args: ["-json", "-db", "https://nexus.example.internal/repository/go-vulndb-proxy/", "./..."],
      },
    ]);
    const vulns = findings.filter((f) => f.rule.startsWith("vuln/"));
    expect(rules(vulns)).toEqual(["error:vuln/found"]);
    expect(vulns[0]?.message).toContain("GO-2024-2611");
    expect(vulns[0]?.message).toContain("google.golang.org/protobuf@v1.32.0");
    expect(vulns[0]?.fix).toContain("v1.33.0");
    expect(vulns[0]?.component).toBe("svc/ (Go)");
  });

  it("skips vulnerabilities in deps.ignoredVulns, by id or alias, while reason and until hold", async () => {
    const ignore = (until: string) =>
      `{deps.vulnScan: true, deps.ignoredVulns: [{id: CVE-2024-24786, reason: 只在測試工具使用, until: ${until}}]}`;
    const kept = scan(declare("svc/", "go", ignore("2026-12-31")), () => ok(GOVULNCHECK), ["svc/main.go"]);
    expect(rules((await kept.result).findings)).toEqual(["deviation:declaration/deviation"]);
    const expired = scan(declare("svc/", "go", ignore("2026-10-01")), () => ok(GOVULNCHECK), ["svc/main.go"]);
    expect(rules((await expired.result).findings)).toEqual(["error:declaration/deviation-expired", "error:vuln/found"]);
  });

  it("an ignored vulnerability without until ignores nothing", async () => {
    const decl = declare("svc/", "go", "{deps.vulnScan: true, deps.ignoredVulns: [{id: GO-2024-2611, reason: x}]}");
    const p = scan(decl, () => ok(GOVULNCHECK), ["svc/main.go"]);
    expect(rules((await p.result).findings)).toEqual([
      "error:declaration/ignored-vuln-without-until",
      "error:vuln/found",
    ]);
  });

  it("reports a scanner that fails or prints no JSON", async () => {
    const p = scan(declare("svc/", "go", "{deps.vulnScan: true}"), () => ok("", 1, "go: no module"), ["svc/main.go"]);
    const [f] = (await p.result).findings;
    expect(f?.rule).toBe("vuln/tool-failed");
    expect(f?.message).toContain("go: no module");
  });

  it("is part of check --full and of the pre-push run (tests, coverage and vulnerability scan)", async () => {
    expect(CHECK_LAYERS).toContain(vulnLayer);
    const { tools, calls } = fakeTools((req) => (req.tool === "govulncheck" ? ok(GOVULNCHECK) : ok()));
    const cwd = project(declare("svc/", "go", "{deps.vulnScan: true}"));
    const { findings } = await checkTestsAndCoverage({
      cwd,
      today: TODAY,
      tools,
      listFiles: () => Promise.resolve(["svc/main.go"]),
    });
    expect(calls.map((c) => c.tool)).toContain("govulncheck");
    expect(rules(findings)).toContain("error:vuln/found");
  });

  it("reports a missing mirror instead of falling back to a public source", async () => {
    const decl = `${declare("svc/", "go", "{deps.vulnScan: true}")}mirrors: {govulndb: ""}\n`;
    const p = scan(decl, () => ok(GOVULNCHECK), ["svc/main.go"]);
    expect(rules((await p.result).findings)).toEqual(["error:vuln/no-mirror"]);
    expect(p.calls).toEqual([]);
  });
});

/** `npm audit --json` (auditReportVersion 2): a high and a moderate advisory, and a package affected only through another. */
const NPM_AUDIT = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    lodash: {
      name: "lodash",
      severity: "high",
      isDirect: true,
      via: [
        {
          source: 1094499,
          name: "lodash",
          dependency: "lodash",
          title: "Prototype Pollution in lodash",
          url: "https://github.com/advisories/GHSA-p6mc-m468-83gw",
          severity: "high",
          range: "<4.17.19",
        },
      ],
      range: "<4.17.19",
      fixAvailable: { name: "lodash", version: "4.17.21", isSemVerMajor: false },
    },
    "postcss-x": { name: "postcss-x", severity: "moderate", isDirect: false, via: ["postcss"], fixAvailable: true },
    postcss: {
      name: "postcss",
      severity: "moderate",
      isDirect: false,
      via: [
        {
          source: 1094544,
          name: "postcss",
          dependency: "postcss",
          title: "PostCSS line return parsing error",
          url: "https://github.com/advisories/GHSA-7fh5-64p2-3v2j",
          severity: "moderate",
          range: "<8.4.31",
        },
      ],
      fixAvailable: true,
    },
  },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 2, high: 1, critical: 0, total: 3 } },
});

/** A fake runner whose `manage` (package-manager commands through the mirror) answers with `answer`. */
function fakeManager(answer: () => ToolResult) {
  const calls: PackageRequest[] = [];
  const tools: ToolRunner = {
    run: () => Promise.reject(new Error("unexpected run")),
    manage(req) {
      calls.push(req);
      return Promise.resolve(answer());
    },
  };
  return { tools, calls };
}

function scanWith(
  declaration: string,
  tools: ToolRunner,
  files: string[],
  contents: Readonly<Record<string, string>> = {},
) {
  const listFiles = () => Promise.resolve(files);
  const cwd = project(declaration, contents);
  return runCheck({ cwd, today: TODAY, tools, listFiles, scope: { full: true } }, [declarationLayer, vulnLayer]);
}

describe("vulnerability scan: TypeScript", () => {
  const WEB = declare("web/", "typescript", "{deps.vulnScan: true}");

  it("runs npm audit --json through mirrors.npm and judges advisories against deps.vulnFailOn (high)", async () => {
    const { tools, calls } = fakeManager(() => ok(NPM_AUDIT, 1));
    const { findings } = await scanWith(WEB, tools, ["web/a.ts"]);
    expect(calls).toEqual([
      {
        language: "typescript",
        dir: "web/",
        args: ["audit", "--json"],
        mirror: "https://nexus.example.internal/repository/npm-proxy/",
      },
    ]);
    expect(rules(findings)).toEqual(["error:vuln/found", "hint:vuln/below-threshold"]);
    expect(findings[0]?.message).toContain("GHSA-p6mc-m468-83gw");
    expect(findings[0]?.message).toContain("lodash");
    expect(findings[0]?.fix).toContain("4.17.21");
    expect(findings[1]?.message).toContain("GHSA-7fh5-64p2-3v2j");
  });

  it("filters ignoredVulns by GHSA, and a stricter vulnFailOn fails the moderate one too", async () => {
    const decl = declare(
      "web/",
      "typescript",
      "{deps.vulnScan: true, deps.vulnFailOn: moderate, deps.ignoredVulns: [{id: GHSA-p6mc-m468-83gw, reason: 未使用受影響的函式, until: 2026-12-31}]}",
    );
    const { tools } = fakeManager(() => ok(NPM_AUDIT, 1));
    const { findings } = await scanWith(decl, tools, ["web/a.ts"]);
    expect(rules(findings)).toEqual(["deviation:declaration/deviation", "error:vuln/found"]);
    expect(findings[1]?.message).toContain("postcss");
  });

  it("gives a hint, not an error, when the mirror's bulk audit endpoint is unavailable", async () => {
    const error = { error: { code: "E404", summary: "Not Found - POST .../-/npm/v1/security/advisories/bulk" } };
    const { tools } = fakeManager(() => ok(JSON.stringify(error), 1));
    const { findings } = await scanWith(WEB, tools, ["web/a.ts"]);
    expect(rules(findings)).toEqual(["hint:vuln/source-unavailable"]);
    expect(findings[0]?.message).toContain("E404");
  });

  it("reports npm audit output that is not JSON as a failed scan", async () => {
    const { tools } = fakeManager(() => ok("", 1, "npm ERR! something"));
    expect(rules((await scanWith(WEB, tools, ["web/a.ts"])).findings)).toEqual(["error:vuln/tool-failed"]);
  });

  it("does not scan pnpm or yarn components yet, and says so", async () => {
    const decl = declare("web/", "typescript", "{deps.vulnScan: true, deps.manager: pnpm}");
    const { tools, calls } = fakeManager(() => ok(NPM_AUDIT, 1));
    expect(rules((await scanWith(decl, tools, ["web/a.ts"])).findings)).toEqual(["hint:vuln/unsupported"]);
    expect(calls).toEqual([]);
  });
});

/** `pip-audit -f json`: one vulnerable dependency and one skipped. */
const PIP_AUDIT = JSON.stringify({
  dependencies: [
    {
      name: "jinja2",
      version: "3.1.2",
      vulns: [
        {
          id: "GHSA-h5c8-rqwp-cp95",
          fix_versions: ["3.1.3"],
          aliases: ["CVE-2024-22195"],
          description: "Jinja vulnerable to HTML attribute injection",
        },
      ],
    },
    { name: "requests", version: "2.32.3", vulns: [] },
    { name: "mypkg", skip_reason: "Dependency not found on PyPI" },
  ],
  fixes: [],
});

/** A runner whose `manage` (uv export) writes the requirements file and whose `run` answers pip-audit. */
function fakePython(pipAudit: () => ToolResult, exportCode = 0) {
  const calls: (ToolRequest | PackageRequest)[] = [];
  const tools: ToolRunner = {
    run(req) {
      calls.push(req);
      return Promise.resolve(pipAudit());
    },
    manage(req) {
      calls.push(req);
      const out = req.args[req.args.indexOf("-o") + 1] ?? "";
      if (exportCode === 0) writeFileSync(out, "jinja2==3.1.2 \\\n    --hash=sha256:abc\n");
      return Promise.resolve(ok("", exportCode, exportCode === 0 ? "" : "error: lockfile out of date"));
    },
  };
  return { tools, calls };
}

/** Dependency-Check's JSON report: CVSS 9.8, CVSS 5.3 and a v2-only score of 7.5. */
const DEPENDENCY_CHECK = JSON.stringify({
  reportSchema: "1.1",
  dependencies: [
    { fileName: "slf4j-api-2.0.9.jar", packages: [{ id: "pkg:maven/org.slf4j/slf4j-api@2.0.9" }] },
    {
      fileName: "log4j-core-2.14.1.jar",
      packages: [{ id: "pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1" }],
      vulnerabilities: [
        {
          source: "NVD",
          name: "CVE-2021-44228",
          severity: "CRITICAL",
          cvssv3: { baseScore: 10.0, baseSeverity: "CRITICAL" },
          description: "Apache Log4j2 JNDI features do not protect against attacker controlled LDAP\nmore",
        },
        {
          source: "NVD",
          name: "CVE-2021-44832",
          severity: "MEDIUM",
          cvssv3: { baseScore: 6.6, baseSeverity: "MEDIUM" },
          description: "Apache Log4j2 JDBC Appender RCE",
        },
      ],
    },
    {
      fileName: "commons-text-1.9.jar",
      packages: [{ id: "pkg:maven/org.apache.commons/commons-text@1.9" }],
      vulnerabilities: [{ source: "NVD", name: "CVE-2022-42889", cvssv2: { score: 7.5 }, description: "Text4Shell" }],
    },
  ],
});

/** A wrapper run that writes `report` where `-Dodc.outputDirectory` points, and keeps the suppression file text. */
function fakeMaven(report: string | undefined, code = 0) {
  const calls: ToolRequest[] = [];
  const suppressions: string[] = [];
  const tools: ToolRunner = {
    run(req) {
      calls.push(req);
      const dir = argValue(req, "-Dodc.outputDirectory");
      suppressions.push(readFileSync(argValue(req, "-DsuppressionFile"), "utf8"));
      if (report !== undefined) writeFileSync(join(dir, "dependency-check-report.json"), report);
      return Promise.resolve(ok("[INFO] BUILD", code));
    },
  };
  return { tools, calls, suppressions };
}

describe("vulnerability scan: Java", () => {
  const SVC = declare(
    "svc/",
    "java",
    "{deps.vulnScan: true, deps.ignoredVulns: [{id: CVE-2022-42889, reason: 未使用 StringSubstitutor, until: 2026-12-31}]}",
  );

  it("runs Dependency-Check against the internal NVD mirror, with ignoredVulns as a suppression file", async () => {
    const { tools, calls, suppressions } = fakeMaven(DEPENDENCY_CHECK);
    const { findings } = await scanWith(SVC, tools, ["svc/pom.xml", "svc/src/A.java"]);
    const [req] = calls;
    expect(req?.language).toBe("java");
    expect(req?.dir).toBe("svc/");
    expect(req?.args).toContain(`org.owasp:dependency-check-maven:${DEPENDENCY_CHECK_VERSION}:check`);
    expect(argValue(req as ToolRequest, "-DnvdDatafeedUrl")).toBe(
      "https://nexus.example.internal/repository/nvd-mirror/nvdcve-{0}.json.gz",
    );
    for (const off of ["ossindexAnalyzerEnabled", "nodeAuditAnalyzerEnabled", "knownExploitedEnabled"]) {
      expect(argValue(req as ToolRequest, `-D${off}`)).toBe("false");
    }
    expect(argValue(req as ToolRequest, "-Dformat")).toBe("JSON");
    expect(suppressions[0]).toContain('<suppress until="2026-12-31Z">');
    expect(suppressions[0]).toContain("<notes>未使用 StringSubstitutor</notes>");
    expect(suppressions[0]).toContain("<cve>CVE-2022-42889</cve>");
    // CVSS 10 fails at the default threshold (high = CVSS 7); CVSS 6.6 is below it; the suppressed one is gone.
    expect(rules(findings.filter((f) => f.layer === "code"))).toEqual([
      "error:vuln/found",
      "hint:vuln/below-threshold",
    ]);
    expect(findings.find((f) => f.rule === "vuln/found")?.message).toContain("log4j-core-2.14.1.jar");
  });

  it("stays offline and runs a pinned plugin: the bundled version, or the one the pom pins (SPEC §5.2, §5.3)", async () => {
    const { tools, calls } = fakeMaven(DEPENDENCY_CHECK);
    await scanWith(SVC, tools, ["svc/pom.xml", "svc/src/A.java"]);
    const goal = (calls[0]?.args ?? []).find((a) => a.startsWith("org.owasp:"));
    expect(goal).toBe(`org.owasp:dependency-check-maven:${DEPENDENCY_CHECK_VERSION}:check`);
    expect(argValue(calls[0] as ToolRequest, "-DcentralAnalyzerEnabled")).toBe("false");

    const pinned = fakeMaven(DEPENDENCY_CHECK);
    const pom =
      "<project><build><plugins><plugin><groupId>org.owasp</groupId><artifactId>dependency-check-maven</artifactId>" +
      "<version>11.0.1</version></plugin></plugins></build></project>";
    await scanWith(SVC, pinned.tools, ["svc/pom.xml", "svc/src/A.java"], { "svc/pom.xml": pom });
    expect(pinned.calls[0]?.args).toContain("org.owasp:dependency-check-maven:11.0.1:check");
  });

  it("judges a v2-only CVSS score when the vulnerability is not ignored", async () => {
    const { tools } = fakeMaven(DEPENDENCY_CHECK);
    const { findings } = await scanWith(declare("svc/", "java", "{deps.vulnScan: true}"), tools, ["svc/src/A.java"]);
    expect(rules(findings)).toEqual(["error:vuln/found", "hint:vuln/below-threshold", "error:vuln/found"]);
  });

  it("reports a build that fails or writes no report", async () => {
    const failed = fakeMaven(undefined, 1);
    expect(rules((await scanWith(SVC, failed.tools, ["svc/src/A.java"])).findings)).toContain("error:vuln/tool-failed");
    const silent = fakeMaven(undefined, 0);
    expect(rules((await scanWith(SVC, silent.tools, ["svc/src/A.java"])).findings)).toContain("error:vuln/tool-failed");
  });

  it("does not scan Gradle components yet, and says so", async () => {
    const decl = declare("svc/", "java", "{deps.vulnScan: true, build.tool: gradle}");
    const { tools, calls } = fakeMaven(DEPENDENCY_CHECK);
    expect(rules((await scanWith(decl, tools, ["svc/src/A.java"])).findings)).toEqual(["hint:vuln/unsupported"]);
    expect(calls).toEqual([]);
  });
});

describe("vulnerability scan: Python", () => {
  const API = declare(
    "api/",
    "python",
    "{deps.vulnScan: true, deps.ignoredVulns: [{id: PYSEC-2099-1, reason: 不受影響, until: 2026-12-31}]}",
  );

  it("exports the locked requirements with uv, then runs pip-audit against the internal OSV endpoint, not pypi.org", async () => {
    const { tools, calls } = fakePython(() => ok(PIP_AUDIT, 1));
    const { findings } = await scanWith(API, tools, ["api/app.py"]);
    const [exported, audit] = calls as [PackageRequest, ToolRequest];
    expect(exported.args.slice(0, 5)).toEqual([
      "export",
      "--frozen",
      "--no-emit-project",
      "--format",
      "requirements.txt",
    ]);
    expect(exported.mirror).toBe("https://nexus.example.internal/repository/pypi-proxy/simple");
    const requirements = exported.args[exported.args.indexOf("-o") + 1];
    expect(audit).toEqual({
      language: "python",
      tool: "pip-audit",
      dir: "api/",
      args: [
        "-r",
        requirements,
        "--disable-pip",
        "-s",
        "osv",
        "--osv-url",
        "https://osv.example.internal/v1/query",
        "-f",
        "json",
        "--ignore-vuln",
        "PYSEC-2099-1",
      ],
    });
    expect(audit.args?.join(" ")).not.toContain("pypi.org");
    expect(rules(findings.filter((f) => f.layer === "code"))).toEqual(["error:vuln/found"]);
    expect(findings.find((f) => f.rule === "vuln/found")?.message).toContain("jinja2@3.1.2");
  });

  it("reports a failed uv export without running pip-audit", async () => {
    const { tools, calls } = fakePython(() => ok(PIP_AUDIT, 1), 2);
    const { findings } = await scanWith(API, tools, ["api/app.py"]);
    expect(rules(findings.filter((f) => f.layer === "code"))).toEqual(["error:vuln/tool-failed"]);
    expect(calls).toHaveLength(1);
  });

  it("reports pip-audit output that is not JSON as a failed scan", async () => {
    const { tools } = fakePython(() => ok("", 2, "pip-audit: error"));
    const { findings } = await scanWith(API, tools, ["api/app.py"]);
    expect(rules(findings.filter((f) => f.layer === "code"))).toEqual(["error:vuln/tool-failed"]);
  });

  it("does not scan Poetry components yet, and says so", async () => {
    const decl = declare("api/", "python", "{deps.vulnScan: true, deps.manager: poetry}");
    const { tools, calls } = fakePython(() => ok(PIP_AUDIT, 1));
    expect(rules((await scanWith(decl, tools, ["api/app.py"])).findings)).toEqual(["hint:vuln/unsupported"]);
    expect(calls).toEqual([]);
  });
});
