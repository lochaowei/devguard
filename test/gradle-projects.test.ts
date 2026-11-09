import { describe, expect, it } from "vitest";
import { gradleApplied, gradleReportDirs, type ListDirs } from "../src/settings/java/gradle-projects.ts";

/** A repo of the given files; directories are derived from the paths. */
function repo(files: Record<string, string>) {
  const read = (p: string) => Promise.resolve(files[p]);
  const subdirs: ListDirs = (dir) => {
    const names = Object.keys(files)
      .filter((p) => p.startsWith(dir))
      .map((p) => p.slice(dir.length).split("/"))
      .filter((parts) => parts.length > 1)
      .map((parts) => parts[0] ?? "");
    return Promise.resolve([...new Set(names)]);
  };
  return { read, subdirs };
}

const dirsOf = (files: Record<string, string>, dir = "") => {
  const { read, subdirs } = repo(files);
  return gradleReportDirs(read, subdirs, dir);
};

describe("gradleReportDirs", () => {
  it("is the component alone without a settings script", async () => {
    expect(await dirsOf({ "build.gradle": "", "lib/build.gradle": "" })).toEqual([""]);
  });

  it("adds the projects a Groovy settings script includes", async () => {
    const files = {
      "settings.gradle": "rootProject.name = 'x'\ninclude ':a', ':b:c'\ninclude 'd'",
      "a/build.gradle": "",
      "b/c/build.gradle": "",
      "d/build.gradle.kts": "",
    };
    expect(await dirsOf(files)).toEqual(["", "a/", "b/c/", "d/"]);
  });

  it("reads a Kotlin include with several projects over lines, and ignores comments", async () => {
    const files = {
      "svc/settings.gradle.kts": '// include("ghost")\ninclude(":a",\n  ":b")',
      "svc/a/build.gradle.kts": "",
      "svc/b/build.gradle.kts": "",
    };
    expect(await dirsOf(files, "svc/")).toEqual(["svc/", "svc/a/", "svc/b/"]);
  });

  it("follows projectDir (java-jwt: include ':java-jwt', projectDir lib/)", async () => {
    const files = {
      "settings.gradle": "include ':java-jwt'\nproject(':java-jwt').projectDir = file('lib')\n",
      "lib/build.gradle": "",
    };
    expect(await dirsOf(files)).toEqual(["", "lib/"]);
  });

  it("follows a Kotlin projectDir given as File(settingsDir, ...)", async () => {
    const files = {
      "settings.gradle.kts": 'include(":x")\nproject(":x").projectDir = File(settingsDir, "modules/x")\n',
      "modules/x/build.gradle.kts": "",
    };
    expect(await dirsOf(files)).toEqual(["", "modules/x/"]);
  });

  it("leaves out an included project without a build script", async () => {
    expect(await dirsOf({ "settings.gradle": "include ':a', ':b'", "a/build.gradle": "" })).toEqual(["", "a/"]);
  });

  it("scans for build scripts when an include cannot be read", async () => {
    const files = {
      "settings.gradle": "include(*names)",
      "a/build.gradle": "",
      "b/c/build.gradle.kts": "",
      "build/tmp/build.gradle": "",
      ".gradle/x/build.gradle": "",
      "other/settings.gradle": "",
      "other/build.gradle": "",
      "other/inner/build.gradle": "",
      "docs/readme.md": "",
    };
    expect(await dirsOf(files)).toEqual(["", "a/", "b/c/"]);
  });

  it("scans when a projectDir cannot be read", async () => {
    const files = {
      "settings.gradle": "include ':a'\nproject(':a').projectDir = file(dirName)\n",
      "z/build.gradle": "",
    };
    expect(await dirsOf(files)).toEqual(["", "z/"]);
  });
});

describe("gradleApplied", () => {
  const read = (files: Record<string, string>) => (p: string) => Promise.resolve(files[p]);

  it("is yes when only a subproject applies the plugin", async () => {
    const files = { "build.gradle": "plugins { id 'java' }", "lib/build.gradle": "plugins { id 'jacoco' }" };
    expect(await gradleApplied(read(files), ["", "lib/"], "jacoco")).toBe("yes");
  });

  it("is no when none does, and unknown without a build file", async () => {
    const files = { "build.gradle": "plugins { id 'java' }", "lib/build.gradle": "plugins { id 'java' }" };
    expect(await gradleApplied(read(files), ["", "lib/"], "jacoco")).toBe("no");
    expect(await gradleApplied(read({}), [""], "jacoco")).toBe("unknown");
  });
});
