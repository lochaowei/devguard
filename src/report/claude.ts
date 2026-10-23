import { LEVEL_LABEL, LEVEL_ORDER, oneLine, type Finding } from "./finding.ts";
import { summaryLine } from "./render.ts";

export interface FeedbackLimits {
  /** Most findings listed; the rest are counted as 「還有 N 項」. */
  maxItems: number;
  /** The whole text stays strictly shorter than this many characters (UTF-16 code units). */
  maxChars: number;
  /** A single item longer than this is shortened with 「…」. */
  maxItemChars: number;
}

/** SPEC §7.3 / §11: at most 20 items, fewer than 4,000 characters. */
export const CLAUDE_FEEDBACK_LIMITS: FeedbackLimits = { maxItems: 20, maxChars: 4000, maxItemChars: 600 };

function itemLine(f: Finding, maxChars: number): string {
  const position =
    f.line === undefined ? "" : `:${String(f.line)}${f.column === undefined ? "" : `:${String(f.column)}`}`;
  const where = f.file === undefined ? "" : `${f.file}${position} `;
  const fix = f.fix === undefined ? "" : `（修正：${oneLine(f.fix)}）`;
  const line = `- ${LEVEL_LABEL[f.level]} ${where}${oneLine(f.message)} [${f.rule}]${fix}`;
  return line.length <= maxChars ? line : `${line.slice(0, maxChars - 1)}…`;
}

const more = (n: number): string => `還有 ${String(n)} 項`;

/**
 * Findings as feedback for Claude Code: a summary line, then the most severe findings first, cut to the limits
 * with 「還有 N 項」 for the rest. Used by `--format claude` and by the Claude hooks' `reason` (SPEC §7.3).
 */
export function claudeFeedback(findings: readonly Finding[], limits: FeedbackLimits = CLAUDE_FEEDBACK_LIMITS): string {
  const sorted = [...findings].sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
  const lines = [`devguard：${summaryLine(sorted)}`];
  // Room for the 「還有 N 項」 line, should anything be left out.
  const reserve = 1 + more(sorted.length).length;
  let length = lines[0]?.length ?? 0;
  let listed = 0;
  for (const f of sorted.slice(0, limits.maxItems)) {
    const line = itemLine(f, limits.maxItemChars);
    const rest = sorted.length - listed - 1;
    if (length + 1 + line.length + (rest > 0 ? reserve : 0) >= limits.maxChars) break;
    lines.push(line);
    length += 1 + line.length;
    listed += 1;
  }
  if (listed < sorted.length) lines.push(more(sorted.length - listed));
  return lines.join("\n");
}
