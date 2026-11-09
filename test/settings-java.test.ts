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

const plugin = (artifactId: string, configuration = "") =>
  `<plugin><artifactId>${artifactId}</artifactId><configuration>${configuration}</configuration></plugin>`;
const SPOTLESS_PLUGIN = plugin("spotless-maven-plugin", "<java><palantirJavaFormat/></java>");
const CHECKSTYLE_PLUGIN = plugin("maven-checkstyle-plugin", "<configLocation>checkstyle.xml</configLocation>");
const PMD_PLUGIN = plugin("maven-pmd-plugin", "<rulesets><ruleset>pmd-ruleset.xml</ruleset></rulesets>");
/** Spotless, Checkstyle and PMD, pointing at the configs of GOOD. */
const PLUGINS = SPOTLESS_PLUGIN + CHECKSTYLE_PLUGIN + PMD_PLUGIN;

const pom = (
  properties = "<maven.compiler.release>17</maven.compiler.release>",
  extra = "",
  plugins = PLUGINS,
) => `<?xml version="1.0"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  ${extra}
  <properties>${properties}</properties>
  <build><plugins>${plugins}</plugins></build>
</project>
`;

/** A Gradle build script applying Spotless, Checkstyle and PMD, pointing at the configs of GOOD. */
const GRADLE_BUILD = `plugins {
    id 'java'
    id 'checkstyle'
    id 'pmd'
    id 'com.diffplug.spotless' version '7.0.0'
}
checkstyle { configFile = file('checkstyle.xml') }
pmd { ruleSetFiles = files('pmd-ruleset.xml') }
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
    const files = {
      ...GOOD,
      "pom.xml": undefined,
      mvnw: undefined,
      "mvnw.cmd": undefined,
      "build.gradle": GRADLE_BUILD,
    };
    const findings = await check(files);
    expect(rules(findings).filter((r) => r.startsWith("error"))).toEqual(["error:settings/wrapper-missing"]);
    expect(findings.find((f) => f.rule === "settings/wrapper-missing")?.message).toContain("gradlew");
  });

  describe("with both pom.xml and build.gradle (#96)", () => {
    // stleary/JSON-java: both build files, only the Gradle wrapper committed.
    const BOTH = {
      ...GOOD,
      mvnw: undefined,
      "mvnw.cmd": undefined,
      "build.gradle": GRADLE_BUILD,
      gradlew: "",
      "gradlew.bat": "",
    };
    const declare = (tool: string) => `${JAVA_ROOT}    overrides:\n      build.tool: ${tool}\n`;
    const wrapperMissing = (findings: Finding[]) => findings.filter((f) => f.rule === "settings/wrapper-missing");

    it("builds with Gradle when only the Gradle wrapper is committed", async () => {
      expect(wrapperMissing(await check(BOTH))).toEqual([]);
    });

    it("builds with Gradle when the declaration says so", async () => {
      expect(wrapperMissing(await check(BOTH, declare("gradle")))).toEqual([]);
    });

    it("asks for the Maven wrapper when the declaration says maven", async () => {
      const [missing, ...rest] = wrapperMissing(await check(BOTH, declare("maven")));
      expect(rest).toEqual([]);
      expect(missing?.message).toContain("Maven wrapper");
    });

    it("asks for the Gradle wrapper of a declared Gradle build that has a pom.xml and mvnw", async () => {
      const files = { ...GOOD, "build.gradle": GRADLE_BUILD };
      expect(wrapperMissing(await check(files, declare("gradle")))[0]?.message).toContain("Gradle wrapper");
    });
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
    const at = plugin("maven-checkstyle-plugin", "<configLocation>config/checkstyle/checkstyle.xml</configLocation>");
    const pomXml = pom(undefined, "", SPOTLESS_PLUGIN + at + PMD_PLUGIN);
    const files = {
      ...GOOD,
      "pom.xml": pomXml,
      "checkstyle.xml": undefined,
      "config/checkstyle/checkstyle.xml": CHECKSTYLE,
    };
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
    const at = plugin("maven-pmd-plugin", "<rulesets><ruleset>config/pmd/ruleset.xml</ruleset></rulesets>");
    const pomXml = pom(undefined, "", SPOTLESS_PLUGIN + CHECKSTYLE_PLUGIN + at);
    const files = { ...GOOD, "pom.xml": pomXml, "pmd-ruleset.xml": undefined, "config/pmd/ruleset.xml": PMD };
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

  it("falls back to java.version or maven.compiler.target/source when maven.compiler.release is absent", async () => {
    expect(await check({ ...GOOD, "pom.xml": pom("<java.version>21</java.version>") })).toEqual([]);
    expect(rules(await check({ ...GOOD, "pom.xml": pom("<java.version>11</java.version>") }))).toEqual([
      "error:settings/looser",
    ]);
    const targetPlugin =
      "<build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId>" +
      "<configuration><target>11</target></configuration></plugin></plugins></build>";
    expect(rules(await check({ ...GOOD, "pom.xml": pom("", targetPlugin) }))).toEqual(["error:settings/looser"]);
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
    const findings = await check({
      ...files,
      "build.gradle.kts": `${GRADLE_BUILD}java { toolchain { } }`,
      gradlew: "",
    });
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

/** The text of a finding's snippet repair. */
function snippetOf(f: Finding | undefined): string | undefined {
  const repair = f?.repairs?.[0];
  return repair?.op === "snippet" ? repair.text : undefined;
}

describe("build plugins (#98)", () => {
  const missing = (findings: Finding[]) => findings.filter((f) => f.rule === "settings/java-plugin-missing");

  it("reports each tool whose plugin the root pom lacks, with the snippet to add, in a multi-module build", async () => {
    // pf4j: a multi-module Maven build with Checkstyle only.
    const modules = "<packaging>pom</packaging><modules><module>core</module></modules>";
    const files = { ...GOOD, "pom.xml": pom(undefined, modules, CHECKSTYLE_PLUGIN), "core/pom.xml": pom() };
    const found = await check(files);
    expect(rules(found)).toEqual(["error:settings/java-plugin-missing", "error:settings/java-plugin-missing"]);
    const [spotless, pmd] = found;
    expect(spotless?.message).toContain("Spotless");
    expect(spotless).toMatchObject({ file: "pom.xml" });
    expect(spotless?.repairs).toHaveLength(1);
    expect(spotless?.repairs?.[0]).toMatchObject({ op: "snippet", file: "pom.xml" });
    expect(snippetOf(spotless)).toContain("<palantirJavaFormat/>");
    expect(spotless?.fix).toContain("不會自動修改");
    expect(pmd?.message).toContain("PMD");
    expect(snippetOf(pmd)).toContain("pmd-ruleset.xml</ruleset>");
    expect(missing(await check(GOOD))).toEqual([]);
  });

  const config = (findings: Finding[]) => findings.filter((f) => f.rule === "settings/java-plugin-config");
  const withPlugins = (plugins: string, properties?: string) => ({ ...GOOD, "pom.xml": pom(properties, "", plugins) });

  it("reports Maven Checkstyle and PMD plugins that do not point at devguard's configs", async () => {
    const found = await check(
      withPlugins(SPOTLESS_PLUGIN + plugin("maven-checkstyle-plugin") + plugin("maven-pmd-plugin")),
    );
    expect(rules(found)).toEqual(["error:settings/java-plugin-config", "error:settings/java-plugin-config"]);
    const [checkstyle, pmd] = found;
    expect(checkstyle?.message).toContain("checkstyle.xml");
    expect(checkstyle?.message).toContain("sun_checks.xml");
    expect(checkstyle?.repairs?.[0]).toMatchObject({ op: "snippet", file: "pom.xml" });
    expect(snippetOf(checkstyle)).toContain(
      "<configLocation>${maven.multiModuleProjectDirectory}/checkstyle.xml</configLocation>",
    );
    expect(pmd?.message).toContain("pmd-ruleset.xml");
    const wrong = plugin("maven-checkstyle-plugin", "<configLocation>google_checks.xml</configLocation>");
    expect(rules(await check(withPlugins(SPOTLESS_PLUGIN + wrong + PMD_PLUGIN)))).toEqual([
      "error:settings/java-plugin-config",
    ]);
  });

  it("accepts the config through basedir properties, the user property or pluginManagement", async () => {
    const at = (location: string) =>
      plugin("maven-checkstyle-plugin", `<configLocation>${location}</configLocation>`) + SPOTLESS_PLUGIN + PMD_PLUGIN;
    expect(config(await check(withPlugins(at("${project.basedir}/checkstyle.xml"))))).toEqual([]);
    expect(config(await check(withPlugins(at("${maven.multiModuleProjectDirectory}/checkstyle.xml"))))).toEqual([]);
    const property =
      "<maven.compiler.release>17</maven.compiler.release><checkstyle.config.location>checkstyle.xml</checkstyle.config.location>";
    const bare = plugin("maven-checkstyle-plugin") + SPOTLESS_PLUGIN + PMD_PLUGIN;
    expect(config(await check(withPlugins(bare, property)))).toEqual([]);
    const managed = `${SPOTLESS_PLUGIN}${plugin("maven-checkstyle-plugin")}${plugin("maven-pmd-plugin")}</plugins><pluginManagement><plugins>${CHECKSTYLE_PLUGIN}${PMD_PLUGIN}</plugins></pluginManagement><plugins>`;
    expect(config(await check(withPlugins(managed)))).toEqual([]);
    // A location devguard cannot resolve is left alone.
    expect(config(await check(withPlugins(at("${config.dir}/checkstyle.xml"))))).toEqual([]);
  });

  it("checks the location against the config devguard found", async () => {
    const files = { ...GOOD, "pmd-ruleset.xml": undefined, "config/pmd/ruleset.xml": PMD };
    expect(rules(await check(files))).toEqual(["error:settings/java-plugin-config"]);
  });

  describe("Gradle", () => {
    const gradle = (build: Record<string, string>) => ({
      ...GOOD,
      "pom.xml": undefined,
      mvnw: undefined,
      "mvnw.cmd": undefined,
      gradlew: "",
      "gradlew.bat": "",
      ...build,
    });
    const plugins = (findings: Finding[]) => findings.filter((f) => f.rule.startsWith("settings/java-plugin"));

    it("passes a build applying every plugin, pointed at devguard's configs", async () => {
      expect(plugins(await check(gradle({ "build.gradle": GRADLE_BUILD })))).toEqual([]);
    });

    it("reports PMD and Spotless missing from a build with Checkstyle only", async () => {
      // LMAX-Exchange/disruptor: the checkstyle plugin with its default config location.
      const build = "plugins {\n    id 'java'\n    id 'checkstyle'\n}\n";
      const files = gradle({
        "build.gradle": build,
        "config/checkstyle/checkstyle.xml": CHECKSTYLE,
      });
      const found = plugins(await check({ ...files, "checkstyle.xml": undefined }));
      expect(found.map((f) => [f.rule, f.message.includes("PMD") ? "PMD" : "Spotless"])).toEqual([
        ["settings/java-plugin-missing", "Spotless"],
        ["settings/java-plugin-missing", "PMD"],
      ]);
      expect(found[1]).toMatchObject({ file: "build.gradle" });
      expect(snippetOf(found[1])).toContain('ruleSetFiles = files("pmd-ruleset.xml")');
      expect(snippetOf(found[1])).toContain("ruleSets = []");
    });

    it("reports Checkstyle reading its default location while devguard's config is elsewhere", async () => {
      const build = 'plugins {\n    checkstyle\n    pmd\n    id("com.diffplug.spotless") version "7.0.0"\n}\n';
      const found = plugins(await check(gradle({ "build.gradle.kts": build })));
      expect(rules(found)).toEqual(["error:settings/java-plugin-config", "error:settings/java-plugin-config"]);
      expect(found[0]?.message).toContain("checkstyle.xml");
      expect(found[0]?.repairs?.[0]).toMatchObject({
        text: 'checkstyle {\n    configFile = file("checkstyle.xml")\n}',
      });
      expect(snippetOf(found[1])).toContain("ruleSets = listOf()");
    });

    it("reads a root-relative location and ignores commented-out plugins", async () => {
      const build = `${GRADLE_BUILD.replace("file('checkstyle.xml')", 'rootProject.file("checkstyle.xml")')}// id 'jacoco'\n`;
      expect(plugins(await check(gradle({ "build.gradle": build })))).toEqual([]);
      const commented = GRADLE_BUILD.replace("id 'pmd'", "// id 'pmd'");
      expect(rules(plugins(await check(gradle({ "build.gradle": commented }))))).toEqual([
        "error:settings/java-plugin-missing",
      ]);
    });

    it("keeps string literals that look like comments, and reads .set(…) and Groovy call forms", async () => {
      const glob = "spotless { java { target 'src/**/*.java' } }\n";
      const set = GRADLE_BUILD.replace("configFile = file('checkstyle.xml')", 'configFile.set(file("checkstyle.xml"))');
      const call = GRADLE_BUILD.replace("configFile = file('checkstyle.xml')", "configFile file('checkstyle.xml')");
      for (const build of [`${glob}${GRADLE_BUILD}${glob}`, set, call])
        expect(plugins(await check(gradle({ "build.gradle": build })))).toEqual([]);
    });

    it("does not count a version-catalog alias that only starts with the tool's name", async () => {
      const build = GRADLE_BUILD.replace("id 'pmd'", "alias(libs.plugins.pmdExtras)");
      expect(rules(plugins(await check(gradle({ "build.gradle": build }))))).toEqual([
        "error:settings/java-plugin-missing",
      ]);
      const alias = GRADLE_BUILD.replace("id 'pmd'", "alias(libs.plugins.pmd)");
      expect(plugins(await check(gradle({ "build.gradle": alias })))).toEqual([]);
    });

    it("reports nothing for plugins that may come from where devguard cannot read", async () => {
      const bare = "plugins {\n    id 'java'\n}\n";
      // Declared for the subprojects only, a convention plugin, or a script plugin.
      const applyFalse = "plugins {\n    id 'com.diffplug.spotless' version '7.0.0' apply false\n}\n";
      expect(missing(await check(gradle({ "build.gradle": applyFalse + bare })))).toHaveLength(2);
      expect(missing(await check(gradle({ "build.gradle": applyFalse + bare })))[0]?.message).not.toContain("Spotless");
      expect(missing(await check(gradle({ "build.gradle": bare, "buildSrc/build.gradle": "" })))).toEqual([]);
      const settings = "includeBuild('build-logic')\n";
      expect(missing(await check(gradle({ "build.gradle": bare, "settings.gradle": settings })))).toEqual([]);
      expect(missing(await check(gradle({ "build.gradle": `${bare}apply from: 'quality.gradle'\n` })))).toEqual([]);
    });
  });

  describe("Maven parents and profiles", () => {
    const PARENT = "<parent><groupId>g</groupId><artifactId>parent</artifactId><version>1</version></parent>";
    const decl = "standard: team@1.0.0\ncomponents:\n  - {path: svc, language: java}\n";
    const svc = (pomXml: string, root?: string) => ({
      mvnw: "",
      "svc/pom.xml": pomXml,
      "svc/checkstyle.xml": CHECKSTYLE,
      "svc/pmd-ruleset.xml": PMD,
      "pom.xml": root,
    });

    it("counts the plugins of a parent POM in the repo, not of an unrelated pom above", async () => {
      const parentPlugins = pom(
        undefined,
        "",
        SPOTLESS_PLUGIN + PMD_PLUGIN.replace("pmd-ruleset.xml", "svc/pmd-ruleset.xml"),
      );
      const child = pom(undefined, PARENT, CHECKSTYLE_PLUGIN);
      expect(missing(await check(svc(child, parentPlugins), decl))).toEqual([]);
      const unrelated = pom(undefined, "", CHECKSTYLE_PLUGIN);
      expect(rules(missing(await check(svc(unrelated, parentPlugins), decl)))).toHaveLength(2);
    });

    it("reports nothing for plugins that may come from a parent outside the repo or a profile", async () => {
      const external = PARENT.replace("</parent>", "<relativePath/></parent>");
      expect(missing(await check(svc(pom(undefined, external, CHECKSTYLE_PLUGIN)), decl))).toEqual([]);
      const profile = `<profiles><profile><id>q</id><build><plugins>${SPOTLESS_PLUGIN}${PMD_PLUGIN}</plugins></build></profile></profiles>`;
      expect(missing(await check(svc(pom(undefined, profile, CHECKSTYLE_PLUGIN)), decl))).toEqual([]);
    });
  });
});
