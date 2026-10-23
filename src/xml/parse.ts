import { parseXml, XmlElement, XmlError } from "@rgrove/parse-xml";
import { lineAt } from "../shared/guards.ts";

/** A plain XML element: name, attributes, child elements, its own text, and the 1-based line it starts on. */
export interface XmlEl {
  name: string;
  attrs: Readonly<Record<string, string>>;
  children: XmlEl[];
  text: string;
  line: number;
}

export type XmlParse = { ok: true; root: XmlEl } | { ok: false; line: number; message: string };

function convert(el: XmlElement, source: string): XmlEl {
  return {
    name: el.name,
    attrs: el.attributes,
    children: el.children.filter((c) => c instanceof XmlElement).map((c) => convert(c, source)),
    text: el.text.trim(),
    line: lineAt(source, el.start),
  };
}

/**
 * Parses an XML file into plain elements. External DTDs are never fetched, and unknown entities are left as-is,
 * so tool configs such as Checkstyle's (with a DOCTYPE) parse offline.
 */
export function parseXmlText(text: string): XmlParse {
  try {
    const doc = parseXml(text, { includeOffsets: true, ignoreUndefinedEntities: true });
    // A well-formed document always has a root element; parseXml throws otherwise.
    return { ok: true, root: convert(doc.root as XmlElement, text) };
  } catch (e) {
    if (!(e instanceof XmlError)) throw e;
    return { ok: false, line: e.line, message: e.message.split("\n")[0] ?? e.message };
  }
}

/** Every element below `el` (depth first, document order), optionally only those named `name`. */
export function descendants(el: XmlEl, name?: string): XmlEl[] {
  return el.children.flatMap((c) => [...(name === undefined || c.name === name ? [c] : []), ...descendants(c, name)]);
}

/** The first child element named `name`. */
export function child(el: XmlEl, name: string): XmlEl | undefined {
  return el.children.find((c) => c.name === name);
}
