import type { Language } from "../standard/types.ts";
import { goScanner } from "./go.ts";
import { javaScanner } from "./java.ts";
import { pythonScanner } from "./python.ts";
import { typescriptScanner } from "./typescript.ts";
import type { VulnScanner } from "./types.ts";

/** The vulnerability scanner for each language; a language without one is not scanned. */
export const VULN_SCANNERS: Readonly<Partial<Record<Language, VulnScanner>>> = {
  python: pythonScanner,
  go: goScanner,
  typescript: typescriptScanner,
  java: javaScanner,
};
