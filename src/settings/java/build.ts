import type { Finding } from "../../report/finding.ts";
import { upwards } from "../../repo/paths.ts";
import { finding, type JavaTarget } from "./common.ts";

export type BuildTool = "maven" | "gradle";

const WRAPPER: Record<BuildTool, { label: string; files: readonly string[]; fix: string }> = {
  maven: {
    label: "Maven",
    files: ["mvnw", "mvnw.cmd"],
    fix: "在元件目錄執行 mvn wrapper:wrapper，並提交 mvnw、mvnw.cmd 與 .mvn/wrapper/",
  },
  gradle: {
    label: "Gradle",
    files: ["gradlew", "gradlew.bat"],
    fix: "在元件目錄執行 gradle wrapper，並提交 gradlew、gradlew.bat 與 gradle/wrapper/",
  },
};

export const GRADLE_FILES = ["build.gradle", "build.gradle.kts"] as const;

/** Maven when the component has a pom.xml, Gradle when it has a build script, otherwise what the declaration says. */
export function buildToolOf(t: JavaTarget): BuildTool {
  const { dir } = t.component;
  if (t.files.has(`${dir}pom.xml`)) return "maven";
  if (GRADLE_FILES.some((f) => t.files.has(dir + f))) return "gradle";
  return t.component.effective["build.tool"]?.value === "gradle" ? "gradle" : "maven";
}

/** The build wrapper must be committed, in the component directory or one above it (multi-module builds). */
export function checkWrapper(t: JavaTarget): Finding[] {
  const wrapper = WRAPPER[buildToolOf(t)];
  const found = upwards(t.component.dir).some((d) => wrapper.files.some((f) => t.files.has(d + f)));
  if (found) return [];
  return [
    finding(
      t,
      "error",
      "java/wrapper-missing",
      `沒有提交 ${wrapper.label} wrapper（${wrapper.files.join(" / ")}），CLI 一律透過 wrapper 呼叫建置工具`,
      { fix: wrapper.fix },
    ),
  ];
}
