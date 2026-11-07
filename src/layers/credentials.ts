import { join } from "node:path";
import { checkCredentials } from "../credentials/check.ts";
import type { CheckLayer } from "./types.ts";
import { readIfExists } from "../shared/fs.ts";

/** Credentials written into the components' project files (`.npmrc`, pyproject.toml, `.mvn/settings.xml`). */
export const credentialsLayer: CheckLayer = {
  id: "credentials",
  async run({ cwd, resolution }) {
    if (!resolution?.standard) return { findings: [] };
    return { findings: await checkCredentials(resolution.components, (file) => readIfExists(join(cwd, file))) };
  },
};
