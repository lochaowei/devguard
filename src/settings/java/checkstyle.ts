import type { Finding } from "../../report/finding.ts";
import { descendants, type XmlEl } from "../../xml/parse.ts";
import { finding, findConfig, FIX_GENERATE, isFinding, judgeNumber, readXmlConfig, type JavaTarget } from "./common.ts";

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

function checkIllegalImport(t: JavaTarget, file: string, module: XmlEl): Finding[] {
  if (property(module, "regexp")?.attrs.value === "true") {
    return [
      finding(
        t,
        "hint",
        "java/config-value-unreadable",
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
      "java/banned-api-not-enforced",
      `${file}：IllegalImport 沒有涵蓋禁用 API ${missing.join("、")}`,
      { file, line: module.line, fix: FIX_GENERATE },
    ),
  ];
}

function moduleMissing(t: JavaTarget, file: string, name: string, why: string): Finding {
  return finding(t, "error", "java/checkstyle-module-missing", `${file}：缺少 Checkstyle 的 ${name}（${why}）`, {
    file,
    fix: FIX_GENERATE,
  });
}

/** Checks the Checkstyle config of a Java component: CyclomaticComplexity per the declaration, IllegalImport per the banned APIs. */
export async function checkCheckstyle(t: JavaTarget): Promise<Finding[]> {
  const file = findConfig(t, CHECKSTYLE_FILES);
  if (!file) {
    return [
      finding(t, "error", "java/checkstyle-missing", `找不到 Checkstyle 設定（${CHECKSTYLE_FILES.join(" 或 ")}）`, {
        fix: FIX_GENERATE,
      }),
    ];
  }
  const root = await readXmlConfig(t, file);
  if (isFinding(root)) return [root];
  const findings: Finding[] = [];
  const cyclomatic = findModule(root, "CyclomaticComplexity");
  if (cyclomatic) {
    const raw = property(cyclomatic, "max")?.attrs.value ?? DEFAULT_CYCLOMATIC_MAX;
    findings.push(
      ...judgeNumber(t, "complexity.cyclomatic", raw, {
        file,
        line: (property(cyclomatic, "max") ?? cyclomatic).line,
        setting: "CyclomaticComplexity max",
      }),
    );
  } else {
    findings.push(moduleMissing(t, file, "CyclomaticComplexity", "complexity.cyclomatic"));
  }
  const illegalImport = findModule(root, "IllegalImport");
  if (illegalImport) findings.push(...checkIllegalImport(t, file, illegalImport));
  else findings.push(moduleMissing(t, file, "IllegalImport", "deps.bannedApis"));
  return findings;
}
