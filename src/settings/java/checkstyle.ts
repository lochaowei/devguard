import type { Finding } from "../../report/finding.ts";
import { descendants, type XmlEl } from "../../xml/parse.ts";
import {
  finding,
  findConfig,
  generated,
  isFinding,
  judgeNumber,
  readXmlConfig,
  snippet,
  type JavaTarget,
  type OwnConfig,
} from "./common.ts";
import { checkstyleModule, type CheckstyleModule } from "./generate.ts";

/** Where the Checkstyle config is looked for, relative to the component (Maven-style, then Gradle's default). */
export const CHECKSTYLE_FILES = ["checkstyle.xml", "config/checkstyle/checkstyle.xml"] as const;

/** Checkstyle's own default for CyclomaticComplexity `max`. */
const DEFAULT_CYCLOMATIC_MAX = "10";
/** Checkstyle's own default for IllegalImport `illegalPkgs`. */
const DEFAULT_ILLEGAL_PKGS = "sun";

/** "CyclomaticComplexity", "CyclomaticComplexityCheck" and the fully qualified class name all name the same module. */
const moduleName = (name: string): string => name.slice(name.lastIndexOf(".") + 1).replace(/Check$/, "");

function property(module: XmlEl, name: string): XmlEl | undefined {
  return module.children.find((c) => c.name === "property" && c.attrs.name === name);
}

/** The enabled module named `name`, if any: a module with severity "ignore" does not run. */
function findModule(root: XmlEl, name: string): XmlEl | undefined {
  return [root, ...descendants(root, "module")].find(
    (m) => moduleName(m.attrs.name ?? "") === name && property(m, "severity")?.attrs.value !== "ignore",
  );
}

/** What a finding about `name` in a Checkstyle config devguard did not generate prints: the module to add or replace. */
function own(t: JavaTarget, text: string, name: CheckstyleModule, present: boolean): OwnConfig {
  const where = present ? `把 TreeWalker 底下的 ${name} 換成：` : "加在 TreeWalker 底下：";
  return { text, missing: snippet(where, checkstyleModule(t, name)) };
}

function checkIllegalImport(t: JavaTarget, file: string, text: string, module: XmlEl): Finding[] {
  if (property(module, "regexp")?.attrs.value === "true") {
    return [
      finding(
        t,
        "hint",
        "settings/config-value-unreadable",
        `${file}：IllegalImport 使用 regexp，無法確認是否涵蓋禁用 API`,
        {
          file,
          line: module.line,
        },
      ),
    ];
  }
  const split = (s: string) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x !== "");
  const pkgs = split(property(module, "illegalPkgs")?.attrs.value ?? DEFAULT_ILLEGAL_PKGS);
  const classes = split(property(module, "illegalClasses")?.attrs.value ?? "");
  const banned = t.component.effective["deps.bannedApis"]?.value;
  const apis = Array.isArray(banned) ? banned.filter((x): x is string => typeof x === "string") : [];
  const missing = apis.filter((api) =>
    api.endsWith(".*") ? !pkgs.includes(api.slice(0, -2)) : !classes.includes(api) && !pkgs.includes(api),
  );
  if (missing.length === 0) return [];
  return [
    finding(
      t,
      "error",
      "settings/banned-api-not-enforced",
      `${file}：IllegalImport 沒有涵蓋禁用 API ${missing.join("、")}`,
      { file, line: module.line, ...generated(t, file, own(t, text, "IllegalImport", true)) },
    ),
  ];
}

function moduleMissing(t: JavaTarget, file: string, text: string, name: CheckstyleModule, why: string): Finding {
  return finding(t, "error", "settings/checkstyle-module-missing", `${file}：缺少 Checkstyle 的 ${name}（${why}）`, {
    file,
    ...generated(t, file, own(t, text, name, false)),
  });
}

/** Checks the Checkstyle config of a Java component: CyclomaticComplexity per the declaration, IllegalImport per the banned APIs. */
export async function checkCheckstyle(t: JavaTarget): Promise<Finding[]> {
  const file = findConfig(t, CHECKSTYLE_FILES);
  if (!file) {
    return [
      finding(t, "error", "settings/checkstyle-missing", `找不到 Checkstyle 設定（${CHECKSTYLE_FILES.join(" 或 ")}）`, {
        ...generated(t, t.component.dir + CHECKSTYLE_FILES[0]),
      }),
    ];
  }
  const config = await readXmlConfig(t, file);
  if (isFinding(config)) return [config];
  const { root, text } = config;
  const findings: Finding[] = [];
  const cyclomatic = findModule(root, "CyclomaticComplexity");
  if (cyclomatic) {
    const raw = property(cyclomatic, "max")?.attrs.value ?? DEFAULT_CYCLOMATIC_MAX;
    findings.push(
      ...judgeNumber(t, "complexity.cyclomatic", raw, {
        file,
        line: (property(cyclomatic, "max") ?? cyclomatic).line,
        setting: "CyclomaticComplexity max",
        own: own(t, text, "CyclomaticComplexity", true),
      }),
    );
  } else {
    findings.push(moduleMissing(t, file, text, "CyclomaticComplexity", "complexity.cyclomatic"));
  }
  const illegalImport = findModule(root, "IllegalImport");
  if (illegalImport) findings.push(...checkIllegalImport(t, file, text, illegalImport));
  else findings.push(moduleMissing(t, file, text, "IllegalImport", "deps.bannedApis"));
  return findings;
}
