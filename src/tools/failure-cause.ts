import { toolErrorLines, toolOutputLines, type ToolResult } from "./runner.ts";

/** How many lines of a failed tool's output a finding message shows. */
const SHOWN = 5;

/** Picks the cause out of a tool's output lines, or undefined when there is none in the tool's format. */
type CauseFinder = (lines: readonly string[]) => string[] | undefined;

/**
 * The advice Maven logs after the cause of every failure (MavenCli in 3.0 through 3.9, MavenInvoker in 4.0; 4.0
 * quotes the switches, as in "re-run Maven with the '-e' switch").
 */
const MAVEN_ADVICE = [
  /^To see the full stack trace of the errors/,
  /^Re-run Maven using the /,
  /^For more information about the errors and possible solutions/,
  /^\[Help \d+\]/,
  /^-> \[Help \d+\]$/,
  /^After correcting the problems, you can resume the build/,
  /^mvn \S+ -rf /,
];

const MAVEN_LEVEL = /^\[(DEBUG|INFO|WARNING|WARN|ERROR|FATAL)\]/;
const MAVEN_FAILURE = /^(\[(ERROR|FATAL)\] ?)+/;

/**
 * Maven 3.0 through 4.0 log every line with a level in brackets; the cause is the [ERROR] (or [FATAL]) lines with
 * the unbracketed lines that continue them (javac's `symbol:` and `location:`), less the closing MAVEN_ADVICE.
 */
const mavenCause: CauseFinder = (lines) => {
  const cause: string[] = [];
  let inFailure = false;
  for (const line of lines) {
    if (MAVEN_LEVEL.test(line)) inFailure = MAVEN_FAILURE.test(line);
    if (!inFailure) continue;
    const text = line
      .replace(MAVEN_FAILURE, "")
      .replace(/ -> \[Help \d+\]$/, "")
      .trimEnd();
    if (text.trim() !== "" && !MAVEN_ADVICE.some((a) => a.test(text.trim()))) cause.push(text);
  }
  return cause.length > 0 ? cause : undefined;
};

/** A heading of Gradle's failure report ("* Try:") or a rule between the failures of a --continue build. */
const GRADLE_SECTION_END = /^(\* \S|-{5,}$|={5,}$)/;

/**
 * Gradle 1.12 through 9.2 (BuildExceptionReporter): the report says what failed under "* What went wrong:", once per
 * failure, between "-----------" and "=====" rules, when a --continue build failed more than once.
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

/** By program, the tools whose failure cause sits among lines of boilerplate (#97). */
const CAUSE_FINDERS: Readonly<Record<string, CauseFinder>> = { mvnw: mavenCause, gradlew: gradleCause };

/**
 * What a failed tool said about why, in up to SHOWN lines. For a build tool (`tool` names the program first, as in
 * "mvnw test"), the cause it printed among its boilerplate, looked for in stdout and stderr alike: the JVM warns on
 * stderr while Maven reports on stdout. Otherwise, or when there is no cause in its format, the first or last lines
 * of `toolErrorLines`.
 */
export function failureCause(tool: string, result: ToolResult, fallback: "first" | "last"): string[] {
  const find = CAUSE_FINDERS[tool.split(" ")[0] ?? ""];
  const cause = find ? [result.stdout, result.stderr].flatMap((out) => find(toolOutputLines(out)) ?? []) : [];
  if (cause.length > 0) return cause.slice(0, SHOWN);
  const errorLines = toolErrorLines(result);
  return fallback === "first" ? errorLines.slice(0, SHOWN) : errorLines.slice(-SHOWN);
}
