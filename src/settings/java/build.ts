import type { ResolvedComponent } from "../../declaration/resolve.ts";
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

/** Files that make a directory a Gradle build: a build script, or the settings script of a multi-project build. */
const GRADLE_BUILD_FILES = [...GRADLE_FILES, "settings.gradle", "settings.gradle.kts"];

/** Whether a repo-relative file exists. */
export type HasFile = (repoPath: string) => boolean | Promise<boolean>;

export interface InferredBuildTool {
  tool: BuildTool;
  /** Both build files and no single wrapper to tell them apart: maven was picked by default. */
  ambiguous: boolean;
}

async function anyExists(paths: readonly string[], has: HasFile): Promise<boolean> {
  for (const p of paths) if (await has(p)) return true;
  return false;
}

/** Whether the component's `tool` wrapper is there, in its directory or one above it (multi-module builds). */
function hasWrapper(dir: string, tool: BuildTool, has: HasFile): Promise<boolean> {
  return anyExists(
    upwards(dir).flatMap((d) => WRAPPER[tool].files.map((f) => d + f)),
    has,
  );
}

/**
 * The build tool a Java component's files point to: the only kind of build file it has, or with both a pom.xml and a
 * Gradle build, the only kind of wrapper committed; maven otherwise (#96).
 */
export async function inferBuildTool(dir: string, has: HasFile): Promise<InferredBuildTool> {
  const maven = await has(`${dir}pom.xml`);
  const gradle = await anyExists(
    GRADLE_BUILD_FILES.map((f) => dir + f),
    has,
  );
  if (!maven || !gradle) return { tool: gradle ? "gradle" : "maven", ambiguous: false };
  const mvnw = await hasWrapper(dir, "maven", has);
  const gradlew = await hasWrapper(dir, "gradle", has);
  if (mvnw !== gradlew) return { tool: gradlew ? "gradle" : "maven", ambiguous: false };
  return { tool: "maven", ambiguous: true };
}

/**
 * The one answer to which build tool a Java component uses, for the settings, code and test checks alike (#96): the
 * `build.tool` the declaration sets (pass undefined when it only holds the standard's default), else `inferBuildTool`.
 */
export async function javaBuildTool(dir: string, declared: unknown, has: HasFile): Promise<BuildTool> {
  if (declared === "maven" || declared === "gradle") return declared;
  return (await inferBuildTool(dir, has)).tool;
}

/** `javaBuildTool` of a resolved component. */
export function componentBuildTool(c: ResolvedComponent, has: HasFile): Promise<BuildTool> {
  const item = c.effective["build.tool"];
  return javaBuildTool(c.dir, item?.source === "override" ? item.value : undefined, has);
}

/** A code or test target: its effective values, with the keys the declaration sets itself in `overrides`. */
interface Target {
  dir: string;
  effective: Readonly<Record<string, unknown>>;
  overrides?: ReadonlySet<string>;
}

/** `javaBuildTool` of a code or test target, whose files are read from the working tree. */
export function targetBuildTool(
  t: Target,
  read: (repoPath: string) => Promise<string | undefined>,
): Promise<BuildTool> {
  const declared = t.overrides?.has("build.tool") === true ? t.effective["build.tool"] : undefined;
  return javaBuildTool(t.dir, declared, async (p) => (await read(p)) !== undefined);
}

/** The build wrapper must be committed, in the component directory or one above it (multi-module builds). */
export async function checkWrapper(t: JavaTarget): Promise<Finding[]> {
  const tool = await componentBuildTool(t.component, (p) => t.files.has(p));
  if (await hasWrapper(t.component.dir, tool, (p) => t.files.has(p))) return [];
  const wrapper = WRAPPER[tool];
  return [
    finding(
      t,
      "error",
      "settings/wrapper-missing",
      `沒有提交 ${wrapper.label} wrapper（${wrapper.files.join(" / ")}），CLI 一律透過 wrapper 呼叫建置工具`,
      { fix: wrapper.fix },
    ),
  ];
}
