import { join } from "node:path";
import { checkMirrors, type MirrorSettings } from "../mirrors/project.ts";
import type { CheckLayer } from "./types.ts";
import { readIfExists } from "../shared/fs.ts";

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** The resolved `mirrors.*` items the project-level check needs. */
export function mirrorSettings(global: Readonly<Record<string, { value: unknown }>>): MirrorSettings {
  return {
    pypi: text(global["mirrors.pypi"]?.value),
    npm: text(global["mirrors.npm"]?.value),
    maven: text(global["mirrors.maven"]?.value),
    auth: global["mirrors.auth"]?.value === "env" ? "env" : "none",
  };
}

/** Project-level mirror settings (SPEC §10.2, §10.3): uv, npm, Maven and Gradle point only at the internal mirrors. */
export const mirrorsLayer: CheckLayer = {
  id: "mirrors",
  fixable: true,
  async run({ cwd, resolution }) {
    if (!resolution?.standard) return { findings: [] };
    const findings = await checkMirrors(resolution.components, mirrorSettings(resolution.global), (file) =>
      readIfExists(join(cwd, file)),
    );
    return { findings };
  },
};
