import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import { runDoctor } from "../src/doctor.ts";
import { createStandardUpgradeCheck } from "../src/environment/standard-upgrade.ts";
import { declarationLayer } from "../src/layers/declaration.ts";
import { javaSettingsLayer } from "../src/layers/settings-java.ts";
import { toolVersionsLayer } from "../src/layers/tool-versions.ts";
import { runStandardUpgrade } from "../src/standard/upgrade-run.ts";
import type { ToolRunner } from "../src/tools/runner.ts";
import { rules, TODAY } from "./helpers.ts";

// team@1.1.0 as this CLI bundles it (#39): no bundled-standard injection, so these go through the real registry.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "devguard-team110-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");

/** A TypeScript project on team@1.0.0 that widened the sonarjs range with a reason. */
const TS_ON_1_0_0 =
  "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: typescript\n    overrides:\n" +
  '      tools.eslint-plugin-sonarjs:\n        value: ">=3,<5"\n        reason: "peer dependency"\n';

const noTools: ToolRunner = {
  run: () => Promise.reject(new Error("no tools in this test")),
  manage: () => Promise.reject(new Error("no package commands expected")),
};

async function upgrade(dir: string, apply = false) {
  let out = "";
  const write = (t: string) => (out += t);
  const code = await runStandardUpgrade({ cwd: dir, today: TODAY, apply, tools: noTools, write });
  return { code, out };
}

describe("team@1.1.0 is the newest bundled standard (#39)", () => {
  it("doctor suggests upgrading team@1.0.0 to team@1.1.0", async () => {
    const dir = repo({ ".devguard.yaml": "standard: team@1.0.0\ncomponents: []\n" });
    const { findings } = await runDoctor({ cwd: dir, today: TODAY, checks: [createStandardUpgradeCheck()] });
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: "standard/upgrade-available", fix: "devguard standard upgrade team@1.1.0" }),
    );
  });

  it("standard upgrade previews dropping eslint-plugin-sonarjs and the override it makes pointless", async () => {
    const dir = repo({ ".devguard.yaml": TS_ON_1_0_0 });
    const { code, out } = await upgrade(dir);
    expect(code).toBe(1);
    expect(out).toContain("team@1.0.0 → team@1.1.0");
    expect(out).toContain('TypeScript｜eslint-plugin-sonarjs 版本範圍：">=3,<4"（移除）');
    expect(out).toContain("tools.eslint-plugin-sonarjs（新標準已移除這個項目）");
    expect(read(dir, ".devguard.yaml")).toBe(TS_ON_1_0_0);
  });

  it("standard upgrade --apply moves the declaration to team@1.1.0 and drops the sonarjs override", async () => {
    const dir = repo({ ".devguard.yaml": TS_ON_1_0_0 });
    expect((await upgrade(dir, true)).code).toBe(0);
    const decl = read(dir, ".devguard.yaml");
    expect(decl).toContain("standard: team@1.1.0");
    expect(decl).not.toContain("eslint-plugin-sonarjs");
  });
});

// #36: team@1.1.0 widens tool ranges and language minimums, never below what upstream still supports (2026-10-27).

const checkTools = (files: Record<string, string>) =>
  runCheck({ cwd: repo(files), today: TODAY, tools: noTools }, [declarationLayer, toolVersionsLayer]);

const component = (standard: string, language: string) =>
  `standard: ${standard}\ncomponents:\n  - {path: ./, language: ${language}}\n`;

const uvLock = (packages: Record<string, string>) =>
  "version = 1\n" +
  Object.entries(packages)
    .map(([name, version]) => `\n[[package]]\nname = "${name}"\nversion = "${version}"\n`)
    .join("");

describe("team@1.1.0 widens Python tool ranges (#36)", () => {
  it("accepts newer ruff and pyright lines that team@1.0.0 rejects", async () => {
    const lock = uvLock({ ruff: "0.18.0", pyright: "1.2.0" });
    const on = async (standard: string) =>
      rules((await checkTools({ ".devguard.yaml": component(standard, "python"), "uv.lock": lock })).findings);
    expect(await on("team@1.0.0")).toEqual(["error:tool-version/out-of-range", "error:tool-version/out-of-range"]);
    expect(await on("team@1.1.0")).toEqual([]);
  });

  it("still rejects ruff and pytest lines upstream no longer maintains", async () => {
    const lock = uvLock({ ruff: "0.8.0", pytest: "7.4.4" });
    const { findings } = await checkTools({ ".devguard.yaml": component("team@1.1.0", "python"), "uv.lock": lock });
    expect(findings.map((f) => f.message)).toEqual([
      expect.stringContaining("ruff"),
      expect.stringContaining("pytest"),
    ]);
  });
});

const packageLock = (packages: Record<string, string>) =>
  JSON.stringify({
    packages: Object.fromEntries(
      Object.entries(packages).map(([name, version]) => [`node_modules/${name}`, { version }]),
    ),
  });

describe("team@1.1.0 widens TypeScript tool ranges (#36)", () => {
  it("accepts vitest 4.1, which still gets security backports", async () => {
    const lock = packageLock({ vitest: "4.1.12" });
    const on = async (standard: string) =>
      rules(
        (await checkTools({ ".devguard.yaml": component(standard, "typescript"), "package-lock.json": lock })).findings,
      );
    expect(await on("team@1.0.0")).toEqual(["error:tool-version/out-of-range"]);
    expect(await on("team@1.1.0")).toEqual([]);
  });

  it("still rejects vitest 4.0 and the end-of-life ESLint 9", async () => {
    const lock = packageLock({ vitest: "4.0.18", eslint: "9.39.5" });
    const { findings } = await checkTools({
      ".devguard.yaml": component("team@1.1.0", "typescript"),
      "package-lock.json": lock,
    });
    expect(findings.map((f) => f.message).sort()).toEqual([
      expect.stringContaining("eslint"),
      expect.stringContaining("vitest"),
    ]);
  });
});

describe("team@1.1.0 admits the current Java tool releases (#36)", () => {
  const files = (standard: string) => ({
    ".devguard.yaml": `standard: ${standard}\ncomponents:\n  - {path: mvn/, language: java}\n  - {path: gradle/, language: java}\n`,
    "mvn/pom.xml":
      "<project><build><plugins><plugin><artifactId>spotless-maven-plugin</artifactId><version>3.10.4</version>" +
      "</plugin></plugins></build></project>",
    "gradle/build.gradle.kts":
      'plugins {\n    checkstyle\n    id("com.diffplug.spotless") version "8.10.4"\n}\n' +
      'checkstyle {\n    toolVersion = "14.3.0"\n}\n',
  });

  it("accepts spotless 3 (Maven) / 8 (Gradle) and Checkstyle 14, which team@1.0.0 rejects", async () => {
    const on = async (standard: string) => (await checkTools(files(standard))).findings.map((f) => [f.rule, f.file]);
    expect(await on("team@1.0.0")).toEqual([
      ["tool-version/out-of-range", "mvn/pom.xml"],
      ["tool-version/out-of-range", "gradle/build.gradle.kts"],
      ["tool-version/out-of-range", "gradle/build.gradle.kts"],
    ]);
    expect(await on("team@1.1.0")).toEqual([]);
  });
});

describe("team@1.1.0 keeps java.minVersion 17; Java 8 projects use legacy@1.0.0 (#36)", () => {
  const releaseFindings = async (standard: string, release: string) => {
    const { findings } = await runCheck(
      {
        cwd: repo({
          ".devguard.yaml": component(standard, "java"),
          "pom.xml": `<project><properties><maven.compiler.release>${release}</maven.compiler.release></properties></project>`,
        }),
        today: TODAY,
        tools: noTools,
      },
      [declarationLayer, javaSettingsLayer],
    );
    return findings.filter((f) => f.message.includes("maven.compiler.release")).map((f) => `${f.level}:${f.rule}`);
  };

  it("rejects a project compiled for Java 8 and accepts Java 17", async () => {
    expect(await releaseFindings("team@1.1.0", "1.8")).toEqual(["error:settings/looser"]);
    expect(await releaseFindings("team@1.1.0", "8")).toEqual(["error:settings/looser"]);
    expect(await releaseFindings("team@1.1.0", "17")).toEqual([]);
  });

  it("legacy@1.0.0 accepts the same Java 8 project", async () => {
    expect(await releaseFindings("legacy@1.0.0", "1.8")).toEqual([]);
  });
});

describe("standard upgrade to team@1.1.0 shows the widened items (#36)", () => {
  /** A Java project on team@1.0.0 that lowered java.minVersion and widened Checkstyle with reasons. */
  const JAVA_ON_1_0_0 =
    "standard: team@1.0.0\ncomponents:\n  - path: ./\n    language: java\n    overrides:\n" +
    '      java.minVersion:\n        value: "8"\n        reason: "legacy customers"\n' +
    '      tools.checkstyle:\n        value: ">=10.21,<15"\n        reason: "Checkstyle 14"\n';

  it("previews the new ranges and the overrides they make pointless, but not java.minVersion", async () => {
    const dir = repo({ ".devguard.yaml": JAVA_ON_1_0_0 });
    const { out } = await upgrade(dir);
    expect(out).not.toContain("Java 最低版本");
    expect(out).not.toContain("java.minVersion（與新預設相同）");
    expect(out).toContain('Java｜checkstyle 版本範圍：">=10.21,<11" → ">=10.21,<15"');
    expect(out).toContain('Java｜spotless-maven-plugin 版本範圍：">=2.44,<3" → ">=2.44,<4"');
    expect(out).toContain("tools.checkstyle（與新預設相同）");
  });

  it("--apply drops the Checkstyle override and keeps the java.minVersion deviation", async () => {
    const dir = repo({ ".devguard.yaml": JAVA_ON_1_0_0 });
    expect((await upgrade(dir, true)).code).toBe(0);
    expect(read(dir, ".devguard.yaml")).toBe(
      "standard: team@1.1.0\ncomponents:\n  - path: ./\n    language: java\n    overrides:\n" +
        '      java.minVersion:\n        value: "8"\n        reason: "legacy customers"\n',
    );
  });
});
