import { parse as parseToml } from "@decimalturn/toml-patch";

/** A parsed TOML table. */
export type Toml = Record<string, unknown>;

/** A parsed pyproject.toml, or undefined when it is not valid TOML. */
export function readToml(text: string): Toml | undefined {
  try {
    return parseToml(text) as Toml;
  } catch {
    return undefined;
  }
}
