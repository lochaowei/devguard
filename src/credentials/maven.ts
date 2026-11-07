import { descendants, parseXmlText } from "../xml/parse.ts";
import type { CredentialProblem } from "./types.ts";

const ENV_REFERENCE = /^\$\{env\.[A-Za-z_][A-Za-z0-9_]*\}$/;
const SECRET_ELEMENTS = new Set(["password", "passphrase", "privateKey"]);

/**
 * A Maven settings file in the repo (`.mvn/settings.xml`): passwords and passphrases are `${env.*}` references.
 * A file that does not parse is not reported here.
 */
export function mavenSettingsProblems(file: string, xml: string): CredentialProblem[] {
  const parsed = parseXmlText(xml);
  if (!parsed.ok) return [];
  return descendants(parsed.root)
    .filter((e) => SECRET_ELEMENTS.has(e.name) && !ENV_REFERENCE.test(e.text))
    .map((secret) => ({
      file,
      line: secret.line,
      message: `${file} 第 ${String(secret.line)} 行的 <${secret.name}> 直接寫入了帳密；帳密不得進 repo`,
      fix: `改為引用環境變數（例如 \${env.MAVEN_PASSWORD}），並更換已外洩的帳密`,
    }));
}
