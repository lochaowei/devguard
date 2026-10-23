import { compareToDefault } from "../../declaration/compare.ts";
import type { Finding } from "../../report/finding.ts";
import { child, descendants, parseXmlText, type XmlEl } from "../../xml/parse.ts";
import { GRADLE_FILES } from "./build.ts";
import { finding, findConfig, type JavaTarget } from "./common.ts";

const KEY = "java.minVersion";

interface Found {
  raw: string;
  line: number;
}

/** `<properties>` of the POM as name → element. */
function properties(project: XmlEl): Map<string, XmlEl> {
  return new Map((child(project, "properties")?.children ?? []).map((p) => [p.name, p]));
}

/** `maven.compiler.release`, or `<release>` in maven-compiler-plugin's configuration. */
function findRelease(project: XmlEl, props: Map<string, XmlEl>): Found | undefined {
  const prop = props.get("maven.compiler.release");
  if (prop) return { raw: prop.text, line: prop.line };
  const build = child(project, "build");
  const plugin = (build ? descendants(build, "plugin") : []).find(
    (p) => child(p, "artifactId")?.text === "maven-compiler-plugin",
  );
  const release = plugin && child(child(plugin, "configuration") ?? plugin, "release");
  return release && { raw: release.text, line: release.line };
}

/** Resolves `${name}` references against the POM's own properties; anything else from outside stays unresolved. */
function resolve(raw: string, props: Map<string, XmlEl>): string | undefined {
  let value = raw;
  for (let depth = 0; depth < 5; depth++) {
    const ref = /^\$\{([^}]+)\}$/.exec(value);
    if (!ref) return value;
    const next = props.get(ref[1] ?? "");
    if (!next) return undefined;
    value = next.text;
  }
  return undefined;
}

/** "1.8" is Java 8. */
const normalize = (v: string): string => v.replace(/^1\.(\d+)$/, "$1");

function unreadable(t: JavaTarget, file: string, why: string, line?: number): Finding {
  const want = String(t.component.effective[KEY]?.value);
  return finding(t, "hint", "java/version-unreadable", `${file}：${why}，請自行確認 Java 版本不低於 ${want}`, {
    file,
    line,
  });
}

function checkPom(t: JavaTarget, file: string, text: string): Finding[] {
  const parsed = parseXmlText(text);
  if (!parsed.ok) return [unreadable(t, file, "無法解析 pom.xml", parsed.line)];
  const project = parsed.root;
  const props = properties(project);
  const found = findRelease(project, props);
  if (!found) {
    const why = child(project, "parent")
      ? "沒有設定 maven.compiler.release，可能繼承自 parent POM"
      : "沒有設定 maven.compiler.release";
    return [unreadable(t, file, why)];
  }
  const value = resolve(found.raw, props);
  const item = t.defs[KEY];
  const declared = t.component.effective[KEY]?.value;
  if (value === undefined || !item) {
    return [unreadable(t, file, `無法解析 Java 版本「${found.raw}」`, found.line)];
  }
  const version = normalize(value);
  const status = compareToDefault({ ...item, value: declared as string }, version);
  if (status === "invalid") return [unreadable(t, file, `無法判讀 Java 版本「${value}」`, found.line)];
  if (status !== "looser") return [];
  return [
    finding(t, "error", "java/version-too-low", `${file}：Java 版本 ${version} 低於標準的 ${String(declared)}`, {
      file,
      line: found.line,
      fix: `把 ${file} 的 maven.compiler.release 改為 ${String(declared)} 以上（建置檔不會自動修改；devguard fix 會印出片段）`,
      repairs: [{ op: "snippet", file, text: `<maven.compiler.release>${String(declared)}</maven.compiler.release>` }],
    }),
  ];
}

/**
 * The Java version a component compiles for, where it can be read reliably: `maven.compiler.release` in pom.xml.
 * Gradle build scripts are code, so they only get a hint.
 */
export async function checkJavaVersion(t: JavaTarget): Promise<Finding[]> {
  const pom = findConfig(t, ["pom.xml"]);
  if (pom) return checkPom(t, pom, await t.read(pom));
  const gradle = findConfig(t, GRADLE_FILES);
  if (gradle) return [unreadable(t, gradle, "Gradle 建置檔是程式碼，無法可靠讀取 toolchain 版本")];
  return [
    finding(t, "hint", "java/build-file-missing", "找不到 pom.xml 或 build.gradle，無法讀取 Java 版本", {
      fix: "以 Maven 或 Gradle 建置，並提交 wrapper",
    }),
  ];
}
