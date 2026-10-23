import { isFixable, LEVEL_LABEL, LEVEL_ORDER, type Finding, type Level } from "./finding.ts";

export interface ReportInput {
  standard?: string;
  components: { name: string; dir: string; language: string }[];
  findings: Finding[];
}

const REPO_WIDE = "（整體）";

function count(findings: Finding[], level: Level): number {
  return findings.filter((f) => f.level === level).length;
}

export function summaryLine(findings: Finding[]): string {
  if (findings.length === 0) return "通過：沒有錯誤、偏離或提示";
  return LEVEL_ORDER.map((l) => `${String(count(findings, l))} 個${LEVEL_LABEL[l]}`).join("、");
}

function renderFinding(f: Finding): string[] {
  const where = f.file ? ` ${f.file}${f.line ? `:${String(f.line)}` : ""}` : "";
  const lines = [`  ${LEVEL_LABEL[f.level]}  ${f.message}  [${f.rule}]${where}`];
  const how = isFixable(f) ? "可用 fix 修正" : "需手動修正";
  lines.push(`        ${how}${f.fix ? `：${f.fix}` : ""}`);
  return lines;
}

function renderGroup(findings: Finding[], verbose: boolean): string[] {
  return LEVEL_ORDER.flatMap((level) => {
    const items = findings.filter((f) => f.level === level);
    if (level === "hint" && !verbose && items.length > 0) {
      return [`  提示  共 ${String(items.length)} 項（加上 --verbose 顯示）`];
    }
    return items.flatMap(renderFinding);
  });
}

/** Human-readable report: grouped by component, then by level; hints collapsed unless verbose (SPEC §11). */
export function renderText(input: ReportInput, verbose = false): string {
  const groups = new Map<string, Finding[]>();
  for (const f of input.findings) {
    const key = f.component ?? REPO_WIDE;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const out: string[] = [];
  if (input.standard) out.push(`標準：${input.standard}`);
  for (const [group, findings] of groups) out.push("", group, ...renderGroup(findings, verbose));
  out.push("", summaryLine(input.findings));
  return out.join("\n") + "\n";
}

/** A finding as reported: without the internal repairs. */
function publicFinding(f: Finding): Omit<Finding, "repairs"> {
  const out: Partial<Finding> = { ...f };
  delete out.repairs;
  return out as Omit<Finding, "repairs">;
}

export function renderJson(input: ReportInput): string {
  return (
    JSON.stringify(
      {
        standard: input.standard ?? null,
        components: input.components.map((c) => ({ path: c.dir === "" ? "./" : c.dir, language: c.language })),
        findings: input.findings.map((f) => ({ ...publicFinding(f), fixable: isFixable(f) })),
      },
      null,
      2,
    ) + "\n"
  );
}

/** The report without hints: what `doctor --quiet` prints (errors and deviations). */
export function problemsOnly(input: ReportInput): ReportInput {
  return { ...input, findings: input.findings.filter((f) => f.level !== "hint") };
}

/** 0 = pass (deviations and hints allowed), 1 = errors, or deviations with --strict. 2 is reserved for CLI failures. */
export function exitCodeFor(findings: Finding[], strict: boolean): 0 | 1 {
  if (findings.some((f) => f.level === "error")) return 1;
  if (strict && findings.some((f) => f.level === "deviation")) return 1;
  return 0;
}
