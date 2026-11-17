import { fixText } from "../../fix/category.ts";
import type { Repair } from "../../fix/repair.ts";
import type { Finding } from "../../report/finding.ts";
import { globSource } from "../../shared/glob.ts";
import { descendants, type XmlEl } from "../../xml/parse.ts";
import { componentBuildTool } from "./build.ts";
import { finding, findConfig, type JavaTarget } from "./common.ts";
import { PMD_FILES } from "./pmd.ts";
import { pomPlugins, readBuildPlugins } from "./plugins.ts";

const RAT = "apache-rat-plugin";

/**
 * Exclude elements inside the plugin's `<configuration>`: `<excludes><exclude>` (every release up to 0.18) and
 * `<inputExcludes><inputExclude>` (0.17 and 0.18). Checked by running `mvn apache-rat-plugin:check` on 0.16.1, 0.17
 * and 0.18 with an unlicensed file excluded each way (#218, fixtures `test/fixtures/maven/rat-*-pom.xml`): 0.16.1
 * only honoured `<excludes>`; 0.17 and 0.18 honoured both. Releases after 0.18 were not run.
 */
const EXCLUDES = new Set(["excludes", "exclude", "inputExcludes", "inputExclude"]);
/** Settings that exclude files from somewhere devguard does not read (a file, a standard collection, SCM ignores). */
const UNREADABLE =
  /^(excludeFile|inputExcludeFile|inputExcludeStds?|inputExcludeParsedScms?|parseSCMIgnoresAsExcludes)$/;

/** An Ant-style path pattern as a regular expression: a leading `./` is dropped, and a trailing `/` means `/**`. */
function antRegex(pattern: string): RegExp {
  const path = pattern.replace(/\\/g, "/").replace(/^\.?\//, "");
  return new RegExp(`^${globSource(path.endsWith("/") ? `${path}**` : path)}$`);
}

/** The exclude patterns of the RAT plugin declarations; undefined when some come from where devguard cannot read. */
function excludePatterns(plugins: readonly { element: XmlEl }[]): string[] | undefined {
  const patterns: string[] = [];
  for (const { element } of plugins) {
    for (const config of descendants(element, "configuration")) {
      for (const el of config.children) {
        if (UNREADABLE.test(el.name)) return undefined;
        if (!EXCLUDES.has(el.name)) continue;
        patterns.push(el.text, ...el.children.map((c) => c.text));
      }
    }
  }
  const found = patterns.map((p) => p.trim()).filter((p) => p !== "");
  return found.some((p) => /^[%!]|\$/.test(p)) ? undefined : found;
}

/** Whether the declared plugin version is below 0.17, the first that reads `<inputExcludes>`. */
function declaresBeforeInputExcludes(plugins: readonly { element: XmlEl }[]): boolean {
  const version = plugins.flatMap((p) => p.element.children.filter((c) => c.name === "version")).at(0)?.text;
  const match = /^0\.(\d+)/.exec(version ?? "");
  return match !== null && Number(match[1]) < 17;
}

/** The files devguard puts in the component, as paths from the component's directory (where RAT scans). */
function devguardFiles(t: JavaTarget): string[] {
  const dir = t.component.dir;
  const pmd = findConfig(t, PMD_FILES) ?? dir + PMD_FILES[0];
  const own = pmd.startsWith(dir) ? [pmd.slice(dir.length)] : [];
  return [...(dir === "" ? [".devguard.yaml"] : []), ...own];
}

/**
 * A Maven component whose pom declares apache-rat-plugin must exclude the files devguard adds (`.devguard.yaml`,
 * the PMD ruleset): they carry no licence header, so RAT fails `mvn test` before the tests run (#218). Only the poms
 * devguard reads count; a plugin from a parent outside the repo is not reported. Build files are only printed a
 * snippet (SPEC §9.2).
 */
export async function checkRatExcludes(t: JavaTarget): Promise<Finding[]> {
  if ((await componentBuildTool(t.component, (p) => t.files.has(p))) !== "maven") return [];
  const read = async (p: string) => (t.files.has(p) ? t.read(p) : undefined);
  const plugins = await readBuildPlugins(read, t.component.dir, "maven");
  const declared = plugins?.files.flatMap(pomPlugins).filter((p) => p.artifactId === RAT) ?? [];
  const first = declared[0];
  if (!first) return [];
  const patterns = excludePatterns(declared);
  if (patterns === undefined) return [];
  const regexes = patterns.map(antRegex);
  const uncovered = devguardFiles(t).filter((f) => !regexes.some((r) => r.test(f)));
  if (uncovered.length === 0) return [];
  const [outer, inner] = declaresBeforeInputExcludes(declared)
    ? ["excludes", "exclude"]
    : ["inputExcludes", "inputExclude"];
  const text = [
    `在 ${RAT} 的 <configuration> 加上：`,
    `<${outer}>`,
    ...uncovered.map((f) => `  <${inner}>${f}</${inner}>`),
    `</${outer}>`,
  ].join("\n");
  const file = first.pom.path;
  const repairs: Repair[] = [{ op: "snippet", file, text }];
  const message = `${file}：${RAT} 沒有排除 devguard 產生的檔案（${uncovered.join("、")}），這些檔案沒有授權標頭，RAT 檢查會讓 mvn test 在執行測試前失敗`;
  return [
    finding(t, "error", "settings/rat-excludes", message, {
      file,
      fix: fixText(`在 ${file} 加入片段`, repairs),
      repairs,
    }),
  ];
}
