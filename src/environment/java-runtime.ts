import type { Finding } from "../report/finding.ts";
import type { EnvironmentCheck, EnvironmentContext } from "./types.ts";

/**
 * The oldest JDK the Java tools in the standards run on (Checkstyle 10, Spotless, palantir-java-format). Not a standard
 * item: `java.minVersion` is the version the code targets, this is the JDK that runs the tools (SPEC §6.5).
 */
const MIN_RUNTIME = 11;

/** The major version in `java -version` output: `1.8.0_392` → 8, `17.0.10` → 17, `21` → 21. */
function javaMajor(output: string): number | undefined {
  const match = /version "(\d+)(?:\.(\d+))?/.exec(output);
  if (!match?.[1]) return undefined;
  const first = Number(match[1]);
  return first === 1 && match[2] ? Number(match[2]) : first;
}

/** `java -version` (printed to stderr); undefined when java cannot be found or fails. */
async function javaVersion(ctx: EnvironmentContext): Promise<string | undefined> {
  try {
    const r = await ctx.exec({ file: "java", args: ["-version"], cwd: ctx.cwd });
    return r.code === 0 ? `${r.stderr}\n${r.stdout}` : undefined;
  } catch {
    return undefined; // java is not installed: check reports the tools failing
  }
}

/** For repos with a Java component, the `java` on PATH can run the Java tools (SPEC §6.5). Only a hint. */
export const javaRuntimeCheck: EnvironmentCheck = {
  id: "java-runtime",
  async run(ctx) {
    if (!ctx.resolution?.components.some((c) => c.language === "java")) return [];
    const output = await javaVersion(ctx);
    const major = output === undefined ? undefined : javaMajor(output);
    if (major === undefined || major >= MIN_RUNTIME) return [];
    const finding: Finding = {
      level: "hint",
      layer: "environment",
      rule: "environment/java-runtime",
      message: `java 是 JDK ${String(major)}：Java 工具需要 JDK ${String(MIN_RUNTIME)} 以上才能執行（程式碼仍可以 Java 8 為目標）`,
      fix: `安裝或切換到 JDK ${String(MIN_RUNTIME)} 以上（例如 JDK 17），程式碼的目標版本維持 java.minVersion`,
    };
    return [finding];
  },
};
