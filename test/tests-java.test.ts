import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolResult } from "../src/tools/runner.ts";
import { rules } from "./helpers.ts";
import { checkTests, declare, fakeTools, ok, project } from "./tests-helpers.ts";

/** A JaCoCo XML report: a package counter (ignored) and the BUNDLE counters, direct children of <report>. */
function jacocoXml(line: [missed: number, covered: number], branch: [missed: number, covered: number]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd">
<report name="app">
  <sessioninfo id="s" start="1" dump="2"/>
  <package name="com/example">
    <counter type="LINE" missed="0" covered="1"/>
  </package>
  <counter type="INSTRUCTION" missed="1" covered="99"/>
  <counter type="BRANCH" missed="${String(branch[0])}" covered="${String(branch[1])}"/>
  <counter type="LINE" missed="${String(line[0])}" covered="${String(line[1])}"/>
  <counter type="METHOD" missed="0" covered="10"/>
</report>
`;
}

const MAVEN_REPORT = "core/target/site/jacoco/jacoco.xml";
const GRADLE_REPORT = "core/build/reports/jacoco/test/jacocoTestReport.xml";

/** The build wrapper answers with `result` after writing `xml` (when given) to `report` under the project. */
function javaTools(
  cwd: () => string,
  report: string,
  xml: string | undefined,
  result: ToolResult = ok("BUILD SUCCESS"),
) {
  return fakeTools(() => {
    if (xml !== undefined) {
      const path = join(cwd(), report);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, xml);
    }
    return result;
  });
}

const CORE = declare("core/", "java");

function setup(files: Record<string, string>, declaration = CORE) {
  const dir = project(declaration, files);
  return { dir, check: (tools: ReturnType<typeof javaTools>["tools"]) => checkTests(dir, tools, ["core/src/A.java"]) };
}

const MAVEN = { "core/pom.xml": "<project/>" };
const GRADLE = { "core/build.gradle": "plugins { id 'java'; id 'jacoco' }" };

const SUREFIRE_FAILED = `[INFO] Results:
[INFO]
[ERROR] Failures:
[ERROR]   CalcTest.add:12 expected: <3> but was: <2>
[ERROR] Errors:
[ERROR]   CalcTest.div:20 » Arithmetic / by zero
[INFO]
[ERROR] Tests run: 4, Failures: 1, Errors: 1, Skipped: 0
[INFO]
[WARNING] There are test failures.
[INFO] BUILD SUCCESS
`;

describe("Java tests", () => {
  it("runs the Maven wrapper with test failures ignored, then judges JaCoCo LINE and BRANCH", async () => {
    const { dir, check } = setup(MAVEN);
    const { tools, calls } = javaTools(() => dir, MAVEN_REPORT, jacocoXml([10, 90], [5, 15]));
    const r = await check(tools);
    expect(calls.map((c) => `${c.dir}:${(c.args ?? []).join(" ")}`)).toEqual([
      "core/:-B -Dmaven.test.failure.ignore=true test jacoco:report",
    ]);
    expect(rules(r.findings)).toEqual(["error:coverage/branches"]);
    expect(r.findings[0]?.message).toBe("分支覆蓋率 75%（15/20）低於門檻 80%");
  });

  it("applies the declared threshold to both counters", async () => {
    const declaration = declare("core/", "java", '{coverage.lines: {value: 70, reason: "legacy", until: 2099-01-01}}');
    const { dir, check } = setup(MAVEN, declaration);
    const r = await check(javaTools(() => dir, MAVEN_REPORT, jacocoXml([25, 75], [31, 69])).tools);
    expect(rules(r.findings)).toEqual(["deviation:declaration/deviation", "error:coverage/branches"]);
  });

  it("reports failing Maven tests by name, apart from coverage", async () => {
    const { dir, check } = setup(MAVEN);
    const r = await check(javaTools(() => dir, MAVEN_REPORT, jacocoXml([30, 70], [0, 0]), ok(SUREFIRE_FAILED)).tools);
    expect(rules(r.findings)).toEqual(["error:test/failed", "error:coverage/lines"]);
    expect(r.findings[0]?.message).toBe("測試失敗：CalcTest.add:12、CalcTest.div:20");
  });

  it("does not judge a stale report left by an earlier build", async () => {
    const { dir, check } = setup({ ...MAVEN, [MAVEN_REPORT]: jacocoXml([0, 100], [0, 10]) });
    const r = await check(javaTools(() => dir, MAVEN_REPORT, undefined).tools);
    expect(rules(r.findings)).toEqual(["error:coverage/no-report"]);
    expect(r.findings[0]?.fix).toContain("jacoco-maven-plugin");
  });

  it("reports a failed Maven build as a tool failure", async () => {
    const { dir, check } = setup(MAVEN);
    const failed = ok("[ERROR] COMPILATION ERROR :\n[INFO] BUILD FAILURE", 1);
    const r = await check(javaTools(() => dir, MAVEN_REPORT, undefined, failed).tools);
    expect(rules(r.findings)).toEqual(["error:test/tool-failed"]);
  });

  it("runs the Gradle wrapper for a Gradle build", async () => {
    const { dir, check } = setup(GRADLE);
    const { tools, calls } = javaTools(() => dir, GRADLE_REPORT, jacocoXml([10, 90], [1, 9]));
    expect((await check(tools)).findings).toEqual([]);
    expect(calls.map((c) => (c.args ?? []).join(" "))).toEqual(["test jacocoTestReport --continue"]);
  });

  it("reports failing Gradle tests by name", async () => {
    const { dir, check } = setup(GRADLE);
    const out =
      "> Task :test\n\nCalcTest > add() FAILED\n    org.opentest4j.AssertionFailedError\n\n4 tests completed, 1 failed\n";
    const r = await check(javaTools(() => dir, GRADLE_REPORT, jacocoXml([0, 10], [0, 2]), ok(out, 1)).tools);
    expect(rules(r.findings)).toEqual(["error:test/failed"]);
    expect(r.findings[0]?.message).toBe("測試失敗：CalcTest > add()");
  });

  it("uses the declared build tool when there is no build file", async () => {
    const { dir, check } = setup({}, declare("core/", "java", "{build.tool: gradle}"));
    const { tools, calls } = javaTools(() => dir, GRADLE_REPORT, jacocoXml([0, 10], [0, 2]));
    await check(tools);
    expect(calls[0]?.args?.[0]).toBe("test");
  });

  it("reports a report it cannot read", async () => {
    const { dir, check } = setup(MAVEN);
    const r = await check(javaTools(() => dir, MAVEN_REPORT, "<report").tools);
    expect(rules(r.findings)).toEqual(["error:coverage/no-report"]);
  });
});
