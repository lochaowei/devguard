import type { Language } from "../standard/types.ts";
import type { CodeChecker } from "./types.ts";
import { goChecker } from "./go.ts";
import { typescriptChecker } from "./typescript.ts";

/** The code checker for each language; a language without one is not code-checked yet. */
export const CODE_CHECKERS: Readonly<Partial<Record<Language, CodeChecker>>> = {
  typescript: typescriptChecker,
  go: goChecker,
};
