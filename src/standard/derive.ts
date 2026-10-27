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
}

/**
 * The standard `derivation` makes from `base`. A changed item keeps its label, kind, `pinnedAs` and `onPath`; only its
 * value is replaced. Naming an item the base's language does not have throws, unless it is an `everyLanguage` key
 * marked `optional` for that language, so a typo or a renamed item cannot silently leave a value unchanged.
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

function deriveLanguage(base: Standard, derivation: Derivation, language: Language): Record<string, ItemDef> {
  const items = base.languages[language];
  const requireItem = (key: string) => {
    if (!Object.hasOwn(items, key)) throw new Error(`${base.id} has no ${language} item ${key}`);
  };
  const optional = derivation.optional?.[language] ?? [];
  const shared = Object.entries(derivation.everyLanguage ?? {}).filter(
    ([key]) => !optional.includes(key) || Object.hasOwn(items, key),
  );
  const values = new Map([...shared, ...Object.entries(derivation.set?.[language] ?? {})]);
  const drop = derivation.drop?.[language] ?? [];
  [...values.keys(), ...drop].forEach(requireItem);

  return Object.fromEntries(
    Object.entries(items)
      .filter(([key]) => !drop.includes(key))
      .map(([key, item]) => {
        const value = values.get(key);
        return [key, value === undefined ? item : { ...item, value }];
      }),
  );
}
