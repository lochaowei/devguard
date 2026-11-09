import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toolFailed } from "../src/code/support.ts";
import type { CodeTarget } from "../src/code/types.ts";
import { testToolFailed } from "../src/testing/coverage.ts";
import type { TestTarget } from "../src/testing/types.ts";

// #97: Maven prints the cause of a failed build as [ERROR] lines between [INFO]/[WARNING] lines and a fixed trailer;
// Gradle under "* What went wrong:". The tool-failed messages must show that cause, not the lines around it.

const codeTarget: CodeTarget = {
  component: "./ (Java)",
  dir: "",
  language: "java",
  effective: {},
  categories: new Set(["format"]),
};
const testTarget: TestTarget = {
  component: "./ (Java)",
  dir: "",
  language: "java",
  effective: {},
  threshold: 0,
  deviation: false,
};

/**
 * Build output under test/fixtures/<tool>/. No JDK was at hand, so these are assembled from the output #97 quotes
 * (pf4j/pf4j, LMAX-Exchange/disruptor) and the closing text Maven's MavenCli and Gradle's BuildExceptionReporter log;
 * replace them with captured output when one is.
 */
const sample = (path: string) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8");

/** pf4j/pf4j without Spotless or JaCoCo in its pom.xml (#97). */
const mavenNoPlugin = (prefix: string) =>
  sample("maven/no-plugin-for-prefix.txt").replaceAll("'spotless'", `'${prefix}'`);
const NO_PLUGIN = (prefix: string) =>
  `No plugin found for prefix '${prefix}' in the current project and in the plugin groups [org.apache.maven.plugins, org.codehaus.mojo] available from the repositories [local (@HOME@/.m2/repository), central (https://repo.maven.apache.org/maven2)]`;

describe("tool-failed messages show the cause of a failed Maven build (#97)", () => {
  it("code/tool-failed shows the [ERROR] cause, not the [INFO] and [WARNING] lines before it", () => {
    const finding = toolFailed(codeTarget, "mvnw", { code: 1, stdout: mavenNoPlugin("spotless"), stderr: "" });
    expect(finding.message).toBe(`mvnw 執行失敗（exit 1）：${NO_PLUGIN("spotless")}`);
  });

  it("test/tool-failed shows the [ERROR] cause, not Maven's closing help lines", () => {
    const finding = testToolFailed(testTarget, "mvnw test", { code: 1, stdout: mavenNoPlugin("jacoco"), stderr: "" });
    expect(finding.message).toBe(`mvnw test 執行失敗（exit 1）：${NO_PLUGIN("jacoco")}`);
    expect(finding.message).not.toContain("Re-run Maven");
    expect(finding.message).not.toContain("[Help 1]");
  });

  it("finds the cause in stdout when the JVM wrote warnings to stderr", () => {
    const stderr = "WARNING: A terminally deprecated method in sun.misc.Unsafe has been called\n";
    const finding = toolFailed(codeTarget, "mvnw", { code: 1, stdout: mavenNoPlugin("spotless"), stderr });
    expect(finding.message).toBe(`mvnw 執行失敗（exit 1）：${NO_PLUGIN("spotless")}`);
  });

  it("keeps the first five lines of a longer cause", () => {
    const errors = ["COMPILATION ERROR :", "A.java:[3,8] one", "A.java:[4,8] two", "A.java:[5,8] three", "4 errors"];
    const stdout = ["[INFO] Scanning for projects...", ...errors.map((e) => `[ERROR] ${e}`), "[ERROR] -> [Help 1]"];
    const finding = toolFailed(codeTarget, "mvnw", {
      code: 1,
      stdout: [...stdout, "[ERROR] six"].join("\n"),
      stderr: "",
    });
    expect(finding.message).toBe(`mvnw 執行失敗（exit 1）：${errors.join("\n")}`);
  });
});

describe("tool-failed messages show what went wrong in a failed Gradle build (#97)", () => {
  it("test/tool-failed shows the What went wrong section, not the closing BUILD FAILED", () => {
    // LMAX-Exchange/disruptor without the jacoco plugin.
    const stderr = sample("gradle/task-not-found.txt");
    const finding = testToolFailed(testTarget, "gradlew test", { code: 1, stdout: "> Task :compileJava\n", stderr });
    expect(finding.message).toBe(
      "gradlew test 執行失敗（exit 1）：Task 'jacocoTestReport' not found in root project 'disruptor'.",
    );
  });

  it("code/tool-failed shows each failure of a --continue build", () => {
    const finding = toolFailed(codeTarget, "gradlew", {
      code: 1,
      stdout: "",
      stderr: sample("gradle/two-failures.txt"),
    });
    expect(finding.message).toBe(
      [
        "gradlew 執行失敗（exit 1）：Execution failed for task ':compileJava'.",
        "> Compilation failed; see the compiler error output for details.",
        "Execution failed for task ':pmdMain'.",
        "> 3 PMD rule violations were found.",
      ].join("\n"),
    );
  });
});

describe("tool-failed messages of a Maven build that failed in other ways (#97)", () => {
  it("keeps the unbracketed lines that continue an [ERROR] line, and a [FATAL] one", () => {
    const stdout = [
      "[INFO] Scanning for projects...",
      "[ERROR] [ERROR] Some problems were encountered while processing the POMs:",
      "[FATAL] Non-resolvable parent POM for com.example:app:1.0",
      "[ERROR] /src/A.java:[3,8] cannot find symbol",
      "  symbol:   class Foo",
      "[INFO] 1 error",
      "  not part of the cause",
    ].join("\n");
    expect(toolFailed(codeTarget, "mvnw", { code: 1, stdout, stderr: "" }).message).toBe(
      [
        "mvnw 執行失敗（exit 1）：Some problems were encountered while processing the POMs:",
        "Non-resolvable parent POM for com.example:app:1.0",
        "/src/A.java:[3,8] cannot find symbol",
        "  symbol:   class Foo",
      ].join("\n"),
    );
  });

  it("drops Maven 4's closing advice, which quotes the switches", () => {
    const stdout = [
      "[ERROR] The build failed",
      "[ERROR] To see the full stack trace of the errors, re-run Maven with the '-e' switch",
      "[ERROR] Re-run Maven using the '-X' switch to enable verbose output",
      "[ERROR] mvn [args] -rf :core",
    ].join("\n");
    expect(toolFailed(codeTarget, "mvnw", { code: 1, stdout, stderr: "" }).message).toBe(
      "mvnw 執行失敗（exit 1）：The build failed",
    );
  });
});

describe("tool-failed messages of other tools (#97)", () => {
  it("keep the first lines (code) and last lines (tests) of what the tool said", () => {
    const stderr = "one\ntwo\nthree\nfour\nfive\nsix\n";
    expect(toolFailed(codeTarget, "ruff", { code: 2, stdout: "", stderr }).message).toBe(
      "ruff 執行失敗（exit 2）：one\ntwo\nthree\nfour\nfive",
    );
    expect(testToolFailed(testTarget, "pytest", { code: 4, stdout: "", stderr }).message).toBe(
      "pytest 執行失敗（exit 4）：two\nthree\nfour\nfive\nsix",
    );
  });

  it("are not read as Maven's when they print [ERROR] lines", () => {
    const stderr = "Traceback (most recent call last):\n[ERROR] app failed\nValueError: bad\n";
    expect(testToolFailed(testTarget, "pytest", { code: 4, stdout: "", stderr }).message).toBe(
      "pytest 執行失敗（exit 4）：Traceback (most recent call last):\n[ERROR] app failed\nValueError: bad",
    );
  });

  it("fall back to those lines when Maven printed no [ERROR] cause", () => {
    const stdout = "[INFO] Scanning for projects...\n[INFO] BUILD FAILURE\n[ERROR] \n";
    expect(toolFailed(codeTarget, "mvnw", { code: 1, stdout, stderr: "" }).message).toBe(
      "mvnw 執行失敗（exit 1）：[INFO] Scanning for projects...\n[INFO] BUILD FAILURE\n[ERROR]",
    );
  });
});
