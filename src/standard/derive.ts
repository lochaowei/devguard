import { LANGUAGES, type ItemDef, type ItemValue, type Language, type Standard } from "./types.ts";

type PerLanguage<T> = Partial<Record<Language, T>>;

/** How a standard differs from the one it is derived from. Every item not named here is the base's, unchanged. */
export interface Derivation {
  id: string;
  upgradesTo?: string;
  /** New values set the same way in every language. */
  everyLanguage?: Readonly<Record<string, ItemValue>>;
  /** The `everyLanguage` keys a language may lack (Python has no `complexity.cognitive`); it skips them. */
  optional?: PerLanguage<readonly string[]>;
  /** New values per language, applied after `everyLanguage`. */
  set?: PerLanguage<Readonly<Record<string, ItemValue>>>;
  /** Items a language no longer has. */
  drop?: PerLanguage<readonly string[]>;
  /** Alternatives added to a `choice` item's `allowed`, e.g. a new type checker. */
  allow?: PerLanguage<Readonly<Record<string, readonly string[]>>>;
  /** Items the base's language does not have yet, appended after its own. */
  add?: PerLanguage<Readonly<Record<string, ItemDef>>>;
}

/**
 * The standard `derivation` makes from `base`. A changed item keeps its label, kind, `pinnedAs` and `onPath`; only its
 * value (or for `allow`, its `allowed`) changes. Naming an item the base's language does not have throws, unless it is
 * an `everyLanguage` key marked `optional` for that language, so a typo or a renamed item cannot silently leave a value
 * unchanged; adding one it already has throws too.
 */
export function deriveStandard(base: Standard, derivation: Derivation): Standard {
  const languages = Object.fromEntries(
    LANGUAGES.map((language) => [language, deriveLanguage(base, derivation, language)]),
  ) as Record<Language, Record<string, ItemDef>>;
  return {
    id: derivation.id,
    ...(derivation.upgradesTo === undefined ? {} : { upgradesTo: derivation.upgradesTo }),
    global: base.global,
    languages,
  };
}

/** The new values `derivation` gives the language's items: `everyLanguage` (less the optional ones it lacks), then `set`. */
function newValues(items: Readonly<Record<string, ItemDef>>, derivation: Derivation, language: Language) {
  const optional = derivation.optional?.[language] ?? [];
  const shared = Object.entries(derivation.everyLanguage ?? {}).filter(
    ([key]) => !optional.includes(key) || Object.hasOwn(items, key),
  );
  return new Map([...shared, ...Object.entries(derivation.set?.[language] ?? {})]);
}

/** `item` with its new value and its added `allowed` alternatives, if any. */
function changedItem(item: ItemDef, value: ItemValue | undefined, more: readonly string[] | undefined): ItemDef {
  return {
    ...item,
    ...(value === undefined ? {} : { value }),
    ...(more === undefined ? {} : { allowed: [...(item.allowed ?? []), ...more] }),
  };
}

function deriveLanguage(base: Standard, derivation: Derivation, language: Language): Record<string, ItemDef> {
  const items = base.languages[language];
  const requireItem = (key: string) => {
    if (!Object.hasOwn(items, key)) throw new Error(`${base.id} has no ${language} item ${key}`);
  };
  const values = newValues(items, derivation, language);
  const drop = derivation.drop?.[language] ?? [];
  const allow = derivation.allow?.[language] ?? {};
  const added = derivation.add?.[language] ?? {};
  [...values.keys(), ...drop, ...Object.keys(allow)].forEach(requireItem);
  for (const key of Object.keys(added)) {
    if (Object.hasOwn(items, key)) throw new Error(`${base.id} already has ${language} item ${key}`);
  }

  const changed = (key: string, item: ItemDef) => changedItem(item, values.get(key), allow[key]);
  return {
    ...Object.fromEntries(
      Object.entries(items)
        .filter(([key]) => !drop.includes(key))
        .map(([key, item]) => [key, changed(key, item)]),
    ),
    ...added,
  };
}
