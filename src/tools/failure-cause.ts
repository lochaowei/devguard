import { toolErrorLines, toolOutputLines, type ToolResult } from "./runner.ts";

/** How many lines of a failed tool's output a finding message shows. */
const SHOWN = 5;

/** Picks the cause out of a tool's output lines, or undefined when the output is not in its tool's format. */
type CauseFinder = (lines: readonly string[]) => string[] | undefined;

/** Maven's closing advice after the cause, the same for every failure. */
const MAVEN_TRAILER = [
  /^To see the full stack trace of the errors/,
  /^Re-run Maven using the -X switch/,
  /^For more information about the errors and possible solutions/,
  /^\[Help \d+\]/,
  /^After correcting the problems, you can resume the build/,
  /^mvn .* -rf /,
  /^-> \[Help \d+\]$/,
];

/**
 * Maven 3.x (every release; the wrapper runs the project's own): each line starts with [INFO], [WARNING] or [ERROR],
 * and the cause is the [ERROR] lines before the closing advice in MAVEN_TRAILER.
 */
const mavenCause: CauseFinder = (lines) => {
  if (!lines.some((l) => /^\[(INFO|ERROR)\]/.test(l))) return undefined;
  const errors = lines
    .filter((l) => l.startsWith("[ERROR]"))
    .map((l) =>
      l
        .replace(/^\[ERROR\] ?/, "")
        .replace(/ -> \[Help \d+\]$/, "")
        .trimEnd(),
    )
    .filter((l) => l.trim() !== "" && !MAVEN_TRAILER.some((t) => t.test(l.trim())));
  return errors.length > 0 ? errors : undefined;
};

/** A heading of Gradle's failure report ("* Try:") or a rule between the failures of a --continue build. */
const GRADLE_SECTION_END = /^(\* \S|-{5,}$|={5,}$)/;

/**
 * Gradle (1.x through 8.x): the failure report says what failed under "* What went wrong:", once per failure when a
 * --continue build failed more than once.
 */
const gradleCause: CauseFinder = (lines) => {
  const cause: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (line.trim() === "* What went wrong:") inSection = true;
    else if (GRADLE_SECTION_END.test(line)) inSection = false;
    else if (inSection) cause.push(line);
  }
  return cause.length > 0 ? cause : undefined;
};

/** Build tools whose failure cause sits among lines of boilerplate (#97); #83 adds Go's `go: downloading` lines. */
const CAUSE_FINDERS: readonly CauseFinder[] = [gradleCause, mavenCause];

/**
 * What a failed tool said about why, in up to SHOWN lines: the cause a build tool printed among its boilerplate
 * (looked for in stdout and stderr alike: the JVM warns on stderr while Maven reports on stdout), otherwise the
 * first or last lines of `toolErrorLines`.
 */
export function failureCause(result: ToolResult, fallback: "first" | "last"): string[] {
  const lines = [...toolOutputLines(result.stdout), ...toolOutputLines(result.stderr)];
  for (const find of CAUSE_FINDERS) {
    const cause = find(lines);
    if (cause) return cause.slice(0, SHOWN);
  }
  const said = toolErrorLines(result);
  return fallback === "first" ? said.slice(0, SHOWN) : said.slice(-SHOWN);
}
