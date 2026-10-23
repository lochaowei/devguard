import type { Finding } from "../../report/finding.ts";
import { fixText } from "../../fix/category.ts";
import type { Repair } from "../../fix/repair.ts";
import { upwards } from "../../repo/paths.ts";
import { GRADLE_FILES } from "./build.ts";
import { finding, type JavaTarget } from "./common.ts";

const SETTING = "lombok.addLombokGeneratedAnnotation";
const LINE = `${SETTING} = true`;

/** The build uses Lombok: the dependency (Maven) or the plugin / dependency (Gradle). */
async function usesLombok(t: JavaTarget): Promise<boolean> {
  for (const name of ["pom.xml", ...GRADLE_FILES]) {
    const path = t.component.dir + name;
    if (
      t.files.has(path) &&
      /org\.projectlombok|io\.freefair\.lombok|<artifactId>lombok<\/artifactId>/.test(await t.read(path))
    )
      return true;
  }
  return false;
}

/** The setting's value in a lombok.config; the last statement wins, as in Lombok itself. */
function settingIn(config: string): string | undefined {
  let value: string | undefined;
  for (const line of config.split(/\r?\n/)) {
    const m = new RegExp(`^\\s*${SETTING.replace(/\./g, "\\.")}\\s*=\\s*(\\S+)`).exec(line);
    if (m) value = m[1];
  }
  return value;
}

/**
 * §6.4: JaCoCo leaves Lombok-generated code out only when Lombok marks it `@Generated`, which needs
 * `lombok.addLombokGeneratedAnnotation = true` in a lombok.config of the component's directory or one above it
 * (Lombok reads them upwards; the nearest setting wins).
 */
export async function checkLombok(t: JavaTarget): Promise<Finding[]> {
  if (!(await usesLombok(t))) return [];
  for (const dir of upwards(t.component.dir)) {
    const path = `${dir}lombok.config`;
    if (!t.files.has(path)) continue;
    const value = settingIn(await t.read(path));
    if (value === "true") return [];
    if (value !== undefined) break;
  }
  const file = `${t.component.dir}lombok.config`;
  const repairs: Repair[] = [{ op: "line", file, value: LINE }];
  const message = `專案使用 Lombok，但 lombok.config 沒有 ${LINE}：Lombok 產生的程式碼會計入覆蓋率`;
  return [
    finding(t, "error", "settings/lombok-generated-annotation", message, {
      file,
      fix: fixText(`在 ${file} 加上 ${LINE}`, repairs),
      repairs,
    }),
  ];
}
