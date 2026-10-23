import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import { javaSettingsLayer } from "../src/layers/settings-java.ts";
import type { Finding } from "../src/report/finding.ts";
import { rules, TODAY } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const JAVA_ROOT = "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: java\n";

const CYCLOMATIC = '<module name="CyclomaticComplexity"><property name="max" value="10"/></module>';
const ILLEGAL_IMPORT = '<module name="IllegalImport"/>';

const checkstyle = (modules = ILLEGAL_IMPORT + CYCLOMATIC) => `<?xml version="1.0"?>
<!DOCTYPE module PUBLIC "-//Checkstyle//DTD Checkstyle Configuration 1.3//EN" "https://checkstyle.org/dtds/configuration_1_3.dtd">
<module name="Checker">
  <module name="TreeWalker">
    ${modules}
  </module>
</module>
`;
const CHECKSTYLE = checkstyle();

const PMD = `<?xml version="1.0"?>
<ruleset name="team" xmlns="http://pmd.sourceforge.net/ruleset/2.0.0">
  <rule ref="category/java/bestpractices.xml"/>
  <rule ref="category/java/design.xml/CognitiveComplexity">
    <properties>
      <property name="reportLevel" value="15"/>
    </properties>
  </rule>
</ruleset>
`;

const pom = (properties = "<maven.compiler.release>17</maven.compiler.release>", extra = "") => `<?xml version="1.0"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  ${extra}
  <properties>${properties}</properties>
</project>
`;

/** A Maven project that passes every Java settings check. */
const GOOD: Record<string, string> = {
  "pom.xml": pom(),
  mvnw: "#!/bin/sh\n",
  "mvnw.cmd": "@echo off\n",
  "checkstyle.xml": CHECKSTYLE,
  "pmd-ruleset.xml": PMD,
};

function project(files: Record<string, string | undefined>, declaration = JAVA_ROOT): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-java-"));
  dirs.push(dir);
  writeFileSync(join(dir, ".devguard.yaml"), declaration);
  for (const [path, text] of Object.entries(files)) {
    if (text === undefined) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

async function check(files: Record<string, string | undefined>, declaration?: string): Promise<Finding[]> {
  const cwd = project(files, declaration);
  const listed = Object.keys(files).filter((f) => files[f] !== undefined);
  const r = await runCheck({ cwd, today: TODAY, listFiles: () => Promise.resolve(listed) }, [
    declarationLayer,
    javaSettingsLayer,
  ]);
  return r.findings;
}

describe("Java settings check", () => {
  it("is part of devguard check", async () => {
    const cwd = project({ ...GOOD, mvnw: undefined, "mvnw.cmd": undefined });
    const r = await runCheck({ cwd, today: TODAY, listFiles: () => Promise.resolve(Object.keys(GOOD).slice(3)) });
    expect(rules(r.findings)).toContain("error:settings/wrapper-missing");
  });

  it("leaves non-Java components and unresolved declarations alone", async () => {
    const go = "standard: team@1.0.0\ncomponents:\n  - {path: ./, language: go}\n";
    expect(await check({}, go)).toEqual([]);
    expect(rules(await check({}, "standard: team@9.9.9\ncomponents: []\n"))).toEqual(["error:standard/newer-than-cli"]);
  });

  it("passes a Maven project with wrapper, Checkstyle, PMD and a readable Java version", async () => {
    expect(await check(GOOD)).toEqual([]);
  });

  it("reports a missing Maven wrapper", async () => {
    const findings = await check({ ...GOOD, mvnw: undefined, "mvnw.cmd": undefined });
    expect(rules(findings)).toEqual(["error:settings/wrapper-missing"]);
    expect(findings[0]?.component).toBe("./ (Java)");
    expect(findings[0]?.fix).toContain("mvn wrapper:wrapper");
  });

  it("asks for the Gradle wrapper when the component builds with Gradle", async () => {
    const files = { ...GOOD, "pom.xml": undefined, mvnw: undefined, "mvnw.cmd": undefined, "build.gradle": "" };
    const findings = await check(files);
    expect(rules(findings).filter((r) => r.startsWith("error"))).toEqual(["error:settings/wrapper-missing"]);
    expect(findings.find((f) => f.rule === "settings/wrapper-missing")?.message).toContain("gradlew");
  });

  it("accepts a wrapper committed in a parent directory of the component", async () => {
    const decl = "standard: team@1.0.0\ncomponents:\n  - {path: services/api, language: java}\n";
    const files = {
      mvnw: "",
      "services/api/pom.xml": pom(),
      "services/api/checkstyle.xml": CHECKSTYLE,
      "services/api/pmd-ruleset.xml": PMD,
    };
    expect(await check(files, decl)).toEqual([]);
  });
});

describe("Checkstyle settings", () => {
  it("reports a missing CyclomaticComplexity module", async () => {
    const findings = await check({ ...GOOD, "checkstyle.xml": checkstyle(ILLEGAL_IMPORT) });
    expect(rules(findings)).toEqual(["error:settings/checkstyle-module-missing"]);
    expect(findings[0]?.message).toContain("CyclomaticComplexity");
    expect(findings[0]?.file).toBe("checkstyle.xml");
    expect(findings[0]?.fix).toContain("devguard fix");
  });

  it("reports a missing IllegalImport module", async () => {
    const findings = await check({ ...GOOD, "checkstyle.xml": checkstyle(CYCLOMATIC) });
    expect(rules(findings)).toEqual(["error:settings/checkstyle-module-missing"]);
    expect(findings[0]?.message).toContain("IllegalImport");
  });

  it("treats a module with severity ignore as missing", async () => {
    const off = '<module name="IllegalImport"><property name="severity" value="ignore"/></module>';
    expect(rules(await check({ ...GOOD, "checkstyle.xml": checkstyle(off + CYCLOMATIC) }))).toEqual([
      "error:settings/checkstyle-module-missing",
    ]);
  });

  it("reports a missing Checkstyle config", async () => {
    const findings = await check({ ...GOOD, "checkstyle.xml": undefined });
    expect(rules(findings)).toEqual(["error:settings/checkstyle-missing"]);
  });

  it("finds the config in Gradle's default location", async () => {
    const files = { ...GOOD, "checkstyle.xml": undefined, "config/checkstyle/checkstyle.xml": CHECKSTYLE };
    expect(await check(files)).toEqual([]);
  });

  it("reports malformed XML with its line", async () => {
    const findings = await check({
      ...GOOD,
      "checkstyle.xml": '<?xml version="1.0"?>\n<module name="Checker">\n<module>\n',
    });
    expect(rules(findings)).toEqual(["error:settings/config-unparseable"]);
    expect(findings[0]?.line).toBeGreaterThan(1);
  });

  it("errors when CyclomaticComplexity max is looser than declared", async () => {
    const decl = JAVA_ROOT + "    overrides: {complexity.cyclomatic: 8}\n";
    const findings = await check(GOOD, decl);
    expect(rules(findings)).toEqual(["error:settings/looser"]);
    expect(findings[0]?.message).toContain("10");
    expect(findings[0]?.message).toContain("8");
    expect(findings[0]?.line).toBe(5);
    expect(findings[0]?.fix).toContain("devguard fix");
  });

  it("hints when CyclomaticComplexity max is stricter than declared", async () => {
    const strict = '<module name="CyclomaticComplexityCheck"><property name="max" value="7"/></module>';
    const findings = await check({ ...GOOD, "checkstyle.xml": checkstyle(ILLEGAL_IMPORT + strict) });
    expect(rules(findings)).toEqual(["hint:settings/stricter"]);
    expect(findings[0]?.fix).toContain("complexity.cyclomatic");
  });

  it("uses Checkstyle's default max of 10 when none is set", async () => {
    const bare = checkstyle(ILLEGAL_IMPORT + '<module name="CyclomaticComplexity"/>');
    expect(await check({ ...GOOD, "checkstyle.xml": bare })).toEqual([]);
    const decl = JAVA_ROOT + "    overrides: {complexity.cyclomatic: 8}\n";
    expect(rules(await check({ ...GOOD, "checkstyle.xml": bare }, decl))).toEqual(["error:settings/looser"]);
  });

  it("hints instead of guessing when max is a property reference", async () => {
    const ref = '<module name="CyclomaticComplexity"><property name="max" value="${cc.max}"/></module>';
    expect(rules(await check({ ...GOOD, "checkstyle.xml": checkstyle(ILLEGAL_IMPORT + ref) }))).toEqual([
      "hint:settings/config-value-unreadable",
    ]);
  });

  it("errors when IllegalImport does not cover the banned APIs", async () => {
    const narrow = '<module name="IllegalImport"><property name="illegalPkgs" value="com.legacy"/></module>';
    const findings = await check({ ...GOOD, "checkstyle.xml": checkstyle(narrow + CYCLOMATIC) });
    expect(rules(findings)).toEqual(["error:settings/banned-api-not-enforced"]);
    expect(findings[0]?.message).toContain("sun.*");
  });

  it("checks added banned APIs against illegalPkgs and illegalClasses", async () => {
    const decl = JAVA_ROOT + '    overrides: {deps.bannedApis: ["sun.*", "javax.xml.bind.*", "java.util.Date"]}\n';
    const wide =
      '<module name="IllegalImport"><property name="illegalPkgs" value="sun, javax.xml.bind"/>' +
      '<property name="illegalClasses" value="java.util.Date"/></module>';
    expect(await check({ ...GOOD, "checkstyle.xml": checkstyle(wide + CYCLOMATIC) }, decl)).toEqual([]);
  });

  it("hints when IllegalImport uses regular expressions", async () => {
    const re = '<module name="IllegalImport"><property name="regexp" value="true"/></module>';
    expect(rules(await check({ ...GOOD, "checkstyle.xml": checkstyle(re + CYCLOMATIC) }))).toEqual([
      "hint:settings/config-value-unreadable",
    ]);
  });
});

describe("PMD settings", () => {
  const ruleset = (rules: string) =>
    `<?xml version="1.0"?>\n<ruleset name="team" xmlns="http://pmd.sourceforge.net/ruleset/2.0.0">\n${rules}\n</ruleset>\n`;
  const cognitive = (props = "") => `<rule ref="category/java/design.xml/CognitiveComplexity">${props}</rule>`;
  const level = (v: string) => `<properties><property name="reportLevel" value="${v}"/></properties>`;

  it("reports a missing CognitiveComplexity rule", async () => {
    const findings = await check({
      ...GOOD,
      "pmd-ruleset.xml": ruleset('<rule ref="category/java/bestpractices.xml"/>'),
    });
    expect(rules(findings)).toEqual(["error:settings/pmd-rule-missing"]);
    expect(findings[0]?.message).toContain("CognitiveComplexity");
    expect(findings[0]?.fix).toContain("devguard fix");
  });

  it("reports a missing PMD ruleset", async () => {
    expect(rules(await check({ ...GOOD, "pmd-ruleset.xml": undefined }))).toEqual(["error:settings/pmd-missing"]);
  });

  it("finds the ruleset in Gradle's default location", async () => {
    const files = { ...GOOD, "pmd-ruleset.xml": undefined, "config/pmd/ruleset.xml": PMD };
    expect(await check(files)).toEqual([]);
  });

  it("errors when reportLevel is looser than declared", async () => {
    const findings = await check({ ...GOOD, "pmd-ruleset.xml": ruleset(cognitive(level("25"))) });
    expect(rules(findings)).toEqual(["error:settings/looser"]);
    expect(findings[0]?.file).toBe("pmd-ruleset.xml");
  });

  it("judges reportLevel against the declared cognitive limit", async () => {
    const decl = JAVA_ROOT + "    overrides:\n      complexity.cognitive: 12\n";
    expect(rules(await check(GOOD, decl))).toEqual(["error:settings/looser"]);
    const strict = { ...GOOD, "pmd-ruleset.xml": ruleset(cognitive(level("10"))) };
    expect(rules(await check(strict, decl))).toEqual(["hint:settings/stricter"]);
  });

  it("accepts reportLevel written as a value element, and PMD's default of 15", async () => {
    const nested = '<properties><property name="reportLevel"><value>15</value></property></properties>';
    expect(await check({ ...GOOD, "pmd-ruleset.xml": ruleset(cognitive(nested)) })).toEqual([]);
    expect(await check({ ...GOOD, "pmd-ruleset.xml": ruleset(cognitive()) })).toEqual([]);
  });

  it("counts the whole design category unless CognitiveComplexity is excluded", async () => {
    const whole = '<rule ref="category/java/design.xml"/>';
    expect(await check({ ...GOOD, "pmd-ruleset.xml": ruleset(whole) })).toEqual([]);
    const excluded = '<rule ref="category/java/design.xml"><exclude name="CognitiveComplexity"/></rule>';
    expect(rules(await check({ ...GOOD, "pmd-ruleset.xml": ruleset(excluded) }))).toEqual([
      "error:settings/pmd-rule-missing",
    ]);
  });

  it("hints instead of guessing when reportLevel is not a number", async () => {
    expect(rules(await check({ ...GOOD, "pmd-ruleset.xml": ruleset(cognitive(level("${lvl}"))) }))).toEqual([
      "hint:settings/config-value-unreadable",
    ]);
  });

  it("reports a malformed ruleset", async () => {
    expect(rules(await check({ ...GOOD, "pmd-ruleset.xml": "<ruleset>" }))).toEqual([
      "error:settings/config-unparseable",
    ]);
  });
});

describe("Java version", () => {
  const release = (v: string) => `<maven.compiler.release>${v}</maven.compiler.release>`;
  const compilerPlugin = (v: string) =>
    `<build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId>` +
    `<configuration><release>${v}</release></configuration></plugin></plugins></build>`;

  it("errors when maven.compiler.release is below the standard", async () => {
    const findings = await check({ ...GOOD, "pom.xml": pom(release("11")) });
    expect(rules(findings)).toEqual(["error:settings/looser"]);
    expect(findings[0]?.message).toContain("11");
    expect(findings[0]?.message).toContain("17");
    expect(findings[0]?.file).toBe("pom.xml");
    expect(findings[0]?.line).toBe(5);
  });

  it("judges against the declared minimum", async () => {
    const decl = JAVA_ROOT + '    overrides:\n      java.minVersion: "21"\n';
    expect(rules(await check(GOOD, decl))).toEqual(["error:settings/looser"]);
    expect(await check({ ...GOOD, "pom.xml": pom(release("21")) }, decl)).toEqual([]);
    expect(await check({ ...GOOD, "pom.xml": pom(release("25")) }, decl)).toEqual([]);
  });

  it("reads the old 1.x form", async () => {
    expect(rules(await check({ ...GOOD, "pom.xml": pom(release("1.8")) }))).toEqual(["error:settings/looser"]);
  });

  it("reads release from the compiler plugin and resolves a property reference", async () => {
    expect(rules(await check({ ...GOOD, "pom.xml": pom("", compilerPlugin("11")) }))).toEqual([
      "error:settings/looser",
    ]);
    const viaProperty = pom("<java.version>11</java.version>", compilerPlugin("${java.version}"));
    expect(rules(await check({ ...GOOD, "pom.xml": viaProperty }))).toEqual(["error:settings/looser"]);
    const viaRelease = pom("<java.version>21</java.version>" + release("${java.version}"));
    expect(await check({ ...GOOD, "pom.xml": viaRelease })).toEqual([]);
  });

  it("only hints when the version may come from a parent POM or cannot be resolved", async () => {
    const parent = "<parent><groupId>g</groupId><artifactId>a</artifactId><version>1</version></parent>";
    const inherited = await check({ ...GOOD, "pom.xml": pom("", parent) });
    expect(rules(inherited)).toEqual(["hint:settings/version-unreadable"]);
    expect(inherited[0]?.message).toContain("parent");
    expect(rules(await check({ ...GOOD, "pom.xml": pom(release("${jdk}")) }))).toEqual([
      "hint:settings/version-unreadable",
    ]);
    expect(rules(await check({ ...GOOD, "pom.xml": pom("") }))).toEqual(["hint:settings/version-unreadable"]);
  });

  it("only hints when pom.xml cannot be parsed", async () => {
    expect(rules(await check({ ...GOOD, "pom.xml": "<project>" }))).toEqual(["hint:settings/version-unreadable"]);
  });

  it("only hints for Gradle build scripts, which are code", async () => {
    const files = { ...GOOD, "pom.xml": undefined, mvnw: undefined, "mvnw.cmd": undefined };
    const findings = await check({ ...files, "build.gradle.kts": "java { toolchain { } }", gradlew: "" });
    expect(rules(findings)).toEqual(["hint:settings/version-unreadable"]);
    expect(findings[0]?.message).toContain("build.gradle.kts");
  });

  it("hints when there is no build file at all", async () => {
    const findings = await check({ ...GOOD, "pom.xml": undefined });
    expect(rules(findings)).toEqual(["hint:settings/build-file-missing"]);
  });
});

describe("Lombok-generated code is left out of coverage (SPEC §6.4)", () => {
  const LOMBOK =
    "<dependencies><dependency><groupId>org.projectlombok</groupId>" +
    "<artifactId>lombok</artifactId></dependency></dependencies>";
  const withLombok = { ...GOOD, "pom.xml": pom(undefined, LOMBOK) };

  it("reports a Lombok build without lombok.addLombokGeneratedAnnotation = true, and fix adds the line", async () => {
    const findings = await check(withLombok);
    expect(rules(findings)).toEqual(["error:settings/lombok-generated-annotation"]);
    expect(findings[0]).toMatchObject({ file: "lombok.config" });
    expect(findings[0]?.fix).toMatch(/^devguard fix/);
    expect(findings[0]?.repairs).toEqual([
      { op: "line", file: "lombok.config", value: "lombok.addLombokGeneratedAnnotation = true" },
    ]);
    const off = await check({ ...withLombok, "lombok.config": "lombok.addLombokGeneratedAnnotation = false\n" });
    expect(rules(off)).toEqual(["error:settings/lombok-generated-annotation"]);
  });

  it("accepts the setting in the component's lombok.config or one above it; builds without Lombok need none", async () => {
    const config = "config.stopBubbling = true\nlombok.addLombokGeneratedAnnotation=true\n";
    expect(await check({ ...withLombok, "lombok.config": config })).toEqual([]);
    const nested = "standard: team@1.0.0\ncomponents:\n  - path: svc/\n    language: java\n";
    const files = Object.fromEntries(Object.entries(withLombok).map(([k, v]) => [`svc/${k}`, v]));
    expect(await check({ ...files, "lombok.config": config }, nested)).toEqual([]);
    expect(await check(GOOD)).toEqual([]);
  });
});
