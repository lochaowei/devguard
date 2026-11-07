import { descendants, parseXmlText } from "../xml/parse.ts";
import type { CredentialProblem } from "./types.ts";

/** The elements of a Maven settings file that hold a secret. `privateKey` is a path to a key file, not a secret. */
const SECRET_ELEMENTS = new Set(["password", "passphrase"]);

/**
 * A value that is not a secret written in the clear: empty, a property reference (`${env.PW}`, `${pw}`), or a password
 * Maven encrypted with the master password (`{…}`).
 */
const NOT_PLAIN = /^$|^\$\{[^}]+\}$|^\{[^}]*\}$/;

/** A Maven settings file in the repo (`.mvn/settings.xml`). A file that does not parse is not reported here. */
export function mavenSettingsProblems(file: string, xml: string): CredentialProblem[] {
  const parsed = parseXmlText(xml);
  if (!parsed.ok) return [];
  return descendants(parsed.root)
    .filter((e) => SECRET_ELEMENTS.has(e.name) && !NOT_PLAIN.test(e.text.trim()))
    .map((secret) => ({
      file,
      line: secret.line,
      message: `${file} 第 ${String(secret.line)} 行的 <${secret.name}> 直接寫入了帳密；帳密不得進 repo`,
      fix: `改為引用環境變數（例如 \${env.MAVEN_PASSWORD}），並更換已外洩的帳密`,
    }));
}
