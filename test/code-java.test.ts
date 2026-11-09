import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { javaChecker } from "../src/code/java.ts";
import { CODE_CHECKERS } from "../src/code/registry.ts";
import type { CodeCategory, CodeTarget } from "../src/code/types.ts";
import { toSpawnSpec, type SpawnSpec } from "../src/process/exec.ts";
import {
  createToolRunner,
  ToolMissingError,
  type ToolRequest,
  type ToolResult,
  type ToolRunner,
} from "../src/tools/runner.ts";

const CWD = process.platform === "win32" ? "C:\\repo" : "/repo";

/** A sample report from test/fixtures/java, with @ROOT@ standing for the repo root. */
function sample(name: string): string {
  return readFileSync(new URL(`./fixtures/java/${name}`, import.meta.url), "utf8").replaceAll("@ROOT@", CWD);
}

type Reply = Partial<ToolResult>;

/** A build wrapper that answers each run by its first goal or task, and records every request. */
function fakeWrapper(replies: Record<string, Reply> = {}) {
  const calls: ToolRequest[] = [];
  const tools: ToolRunner = {
    run(req) {
      calls.push(req);
      const goal = req.args?.find((a) => !a.startsWith("-")) ?? "";
      return Promise.resolve({ code: 0, stdout: "", stderr: "", ...replies[goal] });
    },
  };
  return { tools, calls };
}

function target(over: Partial<CodeTarget> = {}): CodeTarget {
  return {
    component: "svc/ (Java)",
    dir: "svc/",
    language: "java",
    effective: {},
    categories: new Set<CodeCategory>(["lint", "format", "typecheck"]),
    ...over,
  };
}

function check(t: CodeTarget, tools: ToolRunner, texts: Record<string, string> = {}) {
  return javaChecker.check(t, { cwd: CWD, tools, readText: (p) => Promise.resolve(texts[p]) });
}

const only = (...c: CodeCategory[]) => new Set<CodeCategory>(c);

const mavenPlugin = (artifactId: string) => `<plugin><artifactId>${artifactId}</artifactId></plugin>`;
const ALL_PLUGINS = ["spotless-maven-plugin", "maven-checkstyle-plugin", "maven-pmd-plugin"];
/** A pom.xml applying Spotless, Checkstyle and PMD (or the given plugins). */
const pomXml = (inner = "", plugins = ALL_PLUGINS) =>
  `<project>${inner}<build><plugins>${plugins.map(mavenPlugin).join("")}</plugins></build></project>`;
const GRADLE_BUILD = "plugins {\n  id 'checkstyle'\n  id 'pmd'\n  id 'com.diffplug.spotless' version '7.0.0'\n}\n";
const MAVEN = { "svc/pom.xml": pomXml() };
const GRADLE = { "svc/build.gradle": GRADLE_BUILD };

describe("java checker: Maven multi-module lint", () => {
  it("reads each module's reports, not only the aggregator's", async () => {
    const { tools, calls } = fakeWrapper();
    const texts = {
      "svc/pom.xml": pomXml("<packaging>pom</packaging><modules><module>core</module><module>web</module></modules>"),
      "svc/core/pom.xml": pomXml(),
      "svc/web/pom.xml": pomXml("<packaging>pom</packaging><modules><module>api</module></modules>"),
      "svc/web/api/pom.xml": pomXml(),
      "svc/core/target/checkstyle-result.xml": sample("checkstyle-result.xml").replaceAll("svc", "svc/core"),
      "svc/core/target/pmd.xml": '<pmd version="7"/>',
      "svc/web/api/target/checkstyle-result.xml": '<checkstyle version="10"/>',
      "svc/web/api/target/pmd.xml": sample("pmd.xml").replaceAll("svc", "svc/web/api"),
    };
    const findings = await check(target({ categories: only("lint") }), tools, texts);
    expect(calls).toHaveLength(1);
    expect(findings.some((f) => f.rule === "code/tool-failed")).toBe(false);
    const files = [...new Set(findings.map((f) => f.file))];
    expect(files.every((f) => f?.startsWith("svc/core/") === true || f?.startsWith("svc/web/api/") === true)).toBe(
      true,
    );
    expect(files.some((f) => f?.startsWith("svc/core/") === true)).toBe(true);
    expect(files.some((f) => f?.startsWith("svc/web/api/") === true)).toBe(true);
  });

  it("compiles the reactor before the lint goals so modules can resolve their siblings (#102)", async () => {
    const { tools, calls } = fakeWrapper();
    const texts = {
      "svc/pom.xml": pomXml("<packaging>pom</packaging><modules><module>core</module></modules>"),
      "svc/core/pom.xml": pomXml(),
    };
    await check(target({ categories: only("lint", "format") }), tools, texts);
    expect(calls.map((c) => c.args?.filter((a) => !a.startsWith("-")))).toEqual([
      ["test-compile", "checkstyle:check", "pmd:check"],
      ["spotless:check"],
    ]);
  });

  it("compiles first whenever the pom lists modules, also when it is not only an aggregator", async () => {
    const { tools, calls } = fakeWrapper();
    const texts = { "svc/pom.xml": pomXml("<modules><module>core</module></modules>") };
    await check(target({ categories: only("lint") }), tools, texts);
    expect(calls[0]?.args?.filter((a) => !a.startsWith("-"))).toEqual([
      "test-compile",
      "checkstyle:check",
      "pmd:check",
    ]);
  });

  it("runs only the lint goals for a single-module build", async () => {
    const { tools, calls } = fakeWrapper();
    await check(target({ categories: only("lint") }), tools, MAVEN);
    expect(calls[0]?.args?.filter((a) => !a.startsWith("-"))).toEqual(["checkstyle:check", "pmd:check"]);
  });
});

describe("java checker: Maven lint", () => {
  it("runs Checkstyle and PMD through the wrapper and reports their violations with file and line", async () => {
    const { tools, calls } = fakeWrapper();
    const texts = {
      ...MAVEN,
      "svc/target/checkstyle-result.xml": sample("checkstyle-result.xml"),
      "svc/target/pmd.xml": sample("pmd.xml"),
    };
    const findings = await check(target({ categories: only("lint") }), tools, texts);
    expect(calls).toEqual([
      {
        language: "java",
        tool: "mvnw",
        dir: "svc/",
        args: [
          "-B",
          "-ntp",
          "checkstyle:check",
          "pmd:check",
          "-Dcheckstyle.failOnViolation=false",
          "-Dpmd.failOnViolation=false",
        ],
      },
    ]);
    expect(findings).toEqual([
      {
        level: "error",
        layer: "code",
        rule: "checkstyle/UnusedImports",
        message: "Unused import - java.util.List.",
        component: "svc/ (Java)",
        file: "svc/src/main/java/com/example/App.java",
        line: 3,
        fix: "依 Checkstyle 訊息手動修改",
        fixable: false,
      },
      expect.objectContaining({ level: "error", rule: "checkstyle/CyclomaticComplexity", line: 12 }),
      expect.objectContaining({ level: "hint", rule: "checkstyle/MissingJavadocMethod", line: 20 }),
      expect.objectContaining({
        level: "error",
        rule: "pmd/UnusedLocalVariable",
        message: "Avoid unused local variables such as 'x'.",
        file: "svc/src/main/java/com/example/App.java",
        line: 15,
        fix: "依 PMD 訊息手動修改",
        fixable: false,
      }),
      expect.objectContaining({
        level: "error",
        rule: "pmd/processing-error",
        message: "ParseException: Parse exception in file",
        file: "svc/src/main/java/com/example/Broken.java",
        fixable: false,
      }),
    ]);
  });
});

describe("java checker: Gradle lint", () => {
  const gradleRun = (...tasks: string[]) => ({
    language: "java",
    tool: "gradlew",
    dir: "svc/",
    args: [...tasks, "--continue", "--console=plain", "-q"],
  });

  it("runs the Checkstyle and PMD tasks through the Gradle wrapper and reads each report", async () => {
    const { tools, calls } = fakeWrapper({
      checkstyleMain: {
        code: 1,
        stderr: "Execution failed for task ':checkstyleMain'.\n> Checkstyle rule violations were found.",
      },
    });
    const texts = {
      ...GRADLE,
      "svc/build/reports/checkstyle/main.xml": sample("checkstyle-result.xml"),
      "svc/build/reports/pmd/main.xml": sample("pmd.xml"),
    };
    const findings = await check(target({ categories: only("lint") }), tools, texts);
    expect(calls).toEqual([gradleRun("checkstyleMain", "checkstyleTest"), gradleRun("pmdMain", "pmdTest")]);
    expect(findings.map((f) => `${f.rule}:${String(f.line)}`)).toEqual([
      "checkstyle/UnusedImports:3",
      "checkstyle/CyclomaticComplexity:12",
      "checkstyle/MissingJavadocMethod:20",
      "pmd/UnusedLocalVariable:15",
      "pmd/processing-error:undefined",
    ]);
  });

  it("runs Checkstyle and PMD apart, so one failing does not lose the other's findings (#98)", async () => {
    const { tools } = fakeWrapper({ pmdMain: { code: 1, stderr: "Could not resolve all files" } });
    const texts = { ...GRADLE, "svc/build/reports/checkstyle/main.xml": sample("checkstyle-result.xml") };
    const findings = await check(target({ categories: only("lint") }), tools, texts);
    expect(findings.map((f) => f.rule)).toEqual([
      "checkstyle/UnusedImports",
      "checkstyle/CyclomaticComplexity",
      "checkstyle/MissingJavadocMethod",
      "code/tool-failed",
    ]);
  });

  it("reports a failed Gradle build that is not about rule violations", async () => {
    const { tools } = fakeWrapper({ checkstyleMain: { code: 1, stderr: "Could not resolve all files" } });
    const texts = { ...GRADLE, "svc/build/reports/checkstyle/main.xml": sample("checkstyle-result.xml") };
    const findings = await check(target({ categories: only("lint") }), tools, texts);
    expect(findings).toEqual([
      expect.objectContaining({
        rule: "code/tool-failed",
        message: "gradlew 執行失敗（exit 1）：Could not resolve all files",
      }),
    ]);
  });
});

describe("java checker: Spotless", () => {
  it("runs spotless:check through the Maven wrapper and reports each unformatted file at its first changed line", async () => {
    const { tools, calls } = fakeWrapper({ "spotless:check": { code: 1, stdout: sample("spotless-maven.txt") } });
    const findings = await check(target({ categories: only("format") }), tools, MAVEN);
    expect(calls).toEqual([{ language: "java", tool: "mvnw", dir: "svc/", args: ["-B", "-ntp", "spotless:check"] }]);
    expect(findings).toEqual([
      {
        level: "error",
        layer: "code",
        rule: "spotless/format",
        message: "格式不符合 Spotless",
        component: "svc/ (Java)",
        file: "svc/src/main/java/com/example/App.java",
        line: 7,
        fix: "devguard fix --code svc/src/main/java/com/example/App.java",
        fixable: true,
      },
      expect.objectContaining({ rule: "spotless/format", file: "svc/src/test/java/com/example/AppTest.java", line: 1 }),
    ]);
  });

  it("runs spotlessCheck through the Gradle wrapper", async () => {
    const { tools, calls } = fakeWrapper({ spotlessCheck: { code: 1, stderr: sample("spotless-gradle.txt") } });
    const findings = await check(target({ categories: only("format") }), tools, GRADLE);
    expect(calls[0]?.args).toEqual(["spotlessCheck", "--console=plain", "-q"]);
    expect(findings).toEqual([
      expect.objectContaining({ rule: "spotless/format", file: "svc/src/main/java/com/example/App.java", line: 3 }),
    ]);
  });

  it("points at line 1 when Spotless cut the diff off", async () => {
    const stdout = [
      "[ERROR] Failed to execute goal ...: The following files had format violations:",
      "[ERROR]     src\\main\\java\\Big.java",
      "[ERROR]         ... (2000 more lines that didn't fit)",
      "[ERROR] Run 'mvnw spotless:apply' to fix these violations.",
    ].join("\n");
    const { tools } = fakeWrapper({ "spotless:check": { code: 1, stdout } });
    expect(await check(target({ categories: only("format") }), tools, MAVEN)).toEqual([
      expect.objectContaining({ file: "svc/src/main/java/Big.java", line: 1 }),
    ]);
  });

  it("reports nothing when the code is formatted, and a tool failure when Spotless fails for another reason", async () => {
    const clean = fakeWrapper();
    expect(await check(target({ categories: only("format") }), clean.tools, MAVEN)).toEqual([]);
    const broken = fakeWrapper({
      "spotless:check": { code: 1, stdout: "[ERROR] No plugin found for prefix 'spotless'" },
    });
    expect(await check(target({ categories: only("format") }), broken.tools, MAVEN)).toEqual([
      expect.objectContaining({ rule: "code/tool-failed" }),
    ]);
  });
});

describe("java checker: scope", () => {
  it("keeps only the findings for the requested files, relative to the component", async () => {
    const { tools } = fakeWrapper({ "spotless:check": { code: 1, stdout: sample("spotless-maven.txt") } });
    const texts = {
      ...MAVEN,
      "svc/target/checkstyle-result.xml": sample("checkstyle-result.xml"),
      "svc/target/pmd.xml": sample("pmd.xml"),
    };
    const findings = await check(target({ files: ["src/test/java/com/example/AppTest.java"] }), tools, texts);
    expect(findings.map((f) => f.rule)).toEqual(["spotless/format"]);
    expect(findings[0]?.file).toBe("svc/src/test/java/com/example/AppTest.java");
  });

  it("runs nothing for type checks, which the build's compile step covers", async () => {
    const { tools, calls } = fakeWrapper();
    expect(await check(target({ categories: only("typecheck") }), tools, MAVEN)).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("java checker: wrapper", () => {
  const texts = { "svc/pom.xml": pomXml() };
  const readText = (p: string) => Promise.resolve(texts[p as keyof typeof texts]);

  it("runs mvnw.cmd through cmd.exe and never a global mvn", async () => {
    const commands: SpawnSpec[] = [];
    const tools = createToolRunner({
      cwd: "C:\\repo",
      platform: "win32",
      exists: (p) => p === "C:\\repo\\svc\\mvnw.cmd",
      exec: (c) => {
        commands.push(toSpawnSpec(c));
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    });
    await javaChecker.check(target({ categories: only("format") }), { cwd: "C:\\repo", tools, readText });
    expect(commands).toEqual([
      expect.objectContaining({
        file: "cmd.exe",
        args: ["/d", "/s", "/c", '""C:\\repo\\svc\\mvnw.cmd" "-B" "-ntp" "spotless:check""'],
        cwd: "C:\\repo\\svc",
      }),
    ]);
  });

  it("fails with ToolMissingError when the component has no wrapper", async () => {
    const tools = createToolRunner({
      cwd: "C:\\repo",
      platform: "win32",
      exists: () => false,
      pathEnv: "C:\\maven\\bin",
    });
    await expect(
      javaChecker.check(target({ categories: only("lint") }), { cwd: "C:\\repo", tools, readText }),
    ).rejects.toBeInstanceOf(ToolMissingError);
  });

  it("is the registered code checker for Java", () => {
    expect(CODE_CHECKERS.java).toBe(javaChecker);
  });
});

describe("java checker: build tool with both pom.xml and build.gradle (#96)", () => {
  // stleary/JSON-java: both build files, only the Gradle wrapper committed.
  const BOTH = { "svc/pom.xml": pomXml(), "svc/build.gradle": GRADLE_BUILD, "svc/gradlew": "", "svc/gradlew.bat": "" };
  const declared = (tool: string): Partial<CodeTarget> => ({
    effective: { "build.tool": tool },
    overrides: new Set(["build.tool"]),
  });
  const wrappers = async (over: Partial<CodeTarget>, texts: Record<string, string>) => {
    const { tools, calls } = fakeWrapper();
    await check(target({ categories: only("lint", "format"), ...over }), tools, texts);
    const steps = await javaChecker.fixSteps(target(over), {
      cwd: CWD,
      tools,
      readText: (p) => Promise.resolve(texts[p]),
    });
    return [...calls.map((c) => c.tool), ...steps.map((s) => s.tool)];
  };

  it("runs Gradle when only the Gradle wrapper is committed", async () => {
    expect(await wrappers({}, BOTH)).toEqual(["gradlew", "gradlew", "gradlew", "gradlew"]);
  });

  it("runs the declared build tool over the build files", async () => {
    expect(await wrappers(declared("gradle"), MAVEN)).toEqual(["gradlew", "gradlew", "gradlew", "gradlew"]);
    expect(await wrappers(declared("maven"), BOTH)).toEqual(["mvnw", "mvnw", "mvnw"]);
  });

  it("ignores the standard's default build.tool, which the declaration does not set", async () => {
    expect(await wrappers({ effective: { "build.tool": "maven" } }, BOTH)).toEqual([
      "gradlew",
      "gradlew",
      "gradlew",
      "gradlew",
    ]);
  });
});

describe("java checker: build failures", () => {
  it("reports a failed Maven run instead of reading reports left over from an earlier build", async () => {
    const { tools } = fakeWrapper({ "checkstyle:check": { code: 1, stdout: "[ERROR] Non-resolvable parent POM" } });
    const texts = { ...MAVEN, "svc/target/checkstyle-result.xml": sample("checkstyle-result.xml") };
    const findings = await check(target({ categories: only("lint") }), tools, texts);
    expect(findings).toEqual([
      expect.objectContaining({
        rule: "code/tool-failed",
        message: "mvnw 執行失敗（exit 1）：Non-resolvable parent POM",
      }),
    ]);
  });

  it("reports a missing or unreadable report as a tool failure", async () => {
    const { tools } = fakeWrapper();
    const texts = { ...MAVEN, "svc/target/pmd.xml": "<pmd>" };
    const findings = await check(target({ categories: only("lint") }), tools, texts);
    expect(findings).toEqual([
      expect.objectContaining({
        rule: "code/tool-failed",
        message: "找不到 Checkstyle 報告 svc/target/checkstyle-result.xml",
      }),
      expect.objectContaining({
        rule: "code/tool-failed",
        message: expect.stringMatching(/^PMD 報告 svc\/target\/pmd.xml 無法解析/) as string,
      }),
    ]);
  });
});

describe("java checker: tools whose plugin the build lacks are not run (#98)", () => {
  it("runs only Checkstyle for a Maven build without Spotless and PMD", async () => {
    const { tools, calls } = fakeWrapper();
    const texts: Record<string, string> = {
      "svc/pom.xml": pomXml("", ["maven-checkstyle-plugin"]),
      "svc/target/checkstyle-result.xml": '<checkstyle version="10"/>',
    };
    const t = target({ categories: only("lint", "format") });
    expect(await check(t, tools, texts)).toEqual([]);
    expect(calls.map((c) => c.args?.filter((a) => !a.startsWith("-")))).toEqual([["checkstyle:check"]]);
    expect(await javaChecker.fixSteps(t, { cwd: CWD, tools, readText: (p) => Promise.resolve(texts[p]) })).toEqual([]);
  });

  it("runs nothing for a Maven build with none of the plugins", async () => {
    const { tools, calls } = fakeWrapper();
    expect(await check(target(), tools, { "svc/pom.xml": pomXml("", []) })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("runs only the Checkstyle tasks for a Gradle build without PMD and Spotless", async () => {
    const { tools, calls } = fakeWrapper();
    const texts = {
      "svc/build.gradle": "plugins {\n  id 'java'\n  id 'checkstyle'\n}\n",
      "svc/build/reports/checkstyle/main.xml": sample("checkstyle-result.xml"),
    };
    const findings = await check(target({ categories: only("lint", "format") }), tools, texts);
    expect(calls.map((c) => c.args?.[0])).toEqual(["checkstyleMain"]);
    expect(findings).toHaveLength(3);
  });
});

describe("java checker: tools whose plugin may come from elsewhere still run (#98)", () => {
  it("runs every tool for a pom whose parent is outside the repo", async () => {
    const { tools, calls } = fakeWrapper();
    const parent = "<parent><groupId>g</groupId><artifactId>p</artifactId><version>1</version><relativePath/></parent>";
    await check(target({ categories: only("lint", "format") }), tools, { "svc/pom.xml": pomXml(parent, []) });
    expect(calls.map((c) => c.args?.filter((a) => !a.startsWith("-")))).toEqual([
      ["checkstyle:check", "pmd:check"],
      ["spotless:check"],
    ]);
  });

  it("runs Spotless declared `apply false` in a root build, for its subprojects", async () => {
    const { tools, calls } = fakeWrapper();
    const build = "plugins {\n  id 'com.diffplug.spotless' version '7.0.0' apply false\n}\n";
    await check(target({ categories: only("format") }), tools, { "svc/build.gradle": build });
    expect(calls.map((c) => c.args?.[0])).toEqual(["spotlessCheck"]);
  });
});
