import { parse as parseToml } from "@decimalturn/toml-patch";

/** A parsed TOML table. */
export type Toml = Record<string, unknown>;

/** A pyproject.toml: `{}` when absent (fix creates it), undefined when it is not valid TOML. */
export function readToml(text: string | undefined): Toml | undefined {
  try {
    return text === undefined ? {} : (parseToml(text) as Toml);
  } catch {
    return undefined;
  }
}

/** A string value, or "" when the key is absent or not a string. */
export const stringOf = (value: unknown): string => (typeof value === "string" ? value : "");
