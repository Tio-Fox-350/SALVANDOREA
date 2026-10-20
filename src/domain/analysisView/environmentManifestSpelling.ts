import {
  compareUnicodeCodePoints as compare,
  compositeKey,
} from "../unicodeCodePointOrder.js";

/** Fewest characters of a fixed-length identifier family whose members need not carry a digit. */
const FIXED_LENGTH_MINIMUM = 8;

/** The distinct classes of a text's characters: digits, lower case, upper case and each other character. */
const characterClasses = (text: string): string =>
  [
    ...new Set(
      text
        .replaceAll(/\d/gu, "0")
        .replaceAll(/[a-z]/gu, "a")
        .replaceAll(/[A-Z]/gu, "A"),
    ),
  ]
    .sort(compare)
    .join("");

const shapeOf = (length: number, classes: string): string =>
  compositeKey([length, classes]);

/** How a set of observed identifiers is spelled, summarised once so each candidate is checked without rescanning them. */
export interface SpellingSummary {
  /** Each observed value's length and character classes. */
  readonly shapes: ReadonlySet<string>;
  /** The one length of eight or more every observed value has, with the classes they use together. */
  readonly family:
    | { readonly length: number; readonly classes: ReadonlySet<string> }
    | undefined;
}

export const spellingSummary = (
  observed: Iterable<string>,
): SpellingSummary => {
  const shapes = new Set<string>();
  const lengths = new Set<number>();
  const classes = new Set<string>();
  for (const value of observed) {
    const kinds = characterClasses(value);
    shapes.add(shapeOf(value.length, kinds));
    lengths.add(value.length);
    for (const kind of kinds) classes.add(kind);
  }
  const [length] = lengths;
  return {
    shapes,
    family:
      lengths.size === 1 && length! >= FIXED_LENGTH_MINIMUM
        ? { length: length!, classes }
        : undefined,
  };
};

/** Spelled like an observed identifier: a digit-bearing value with the length and character classes of one, or a member of their fixed-length family. */
export const spelledLikeObserved = (
  value: string,
  observed: SpellingSummary,
): boolean => {
  const classes = characterClasses(value);
  const { family } = observed;
  if (
    family !== undefined &&
    value.length === family.length &&
    [...classes].every((kind) => family.classes.has(kind))
  )
    return true;
  return (
    /\d/u.test(value) && observed.shapes.has(shapeOf(value.length, classes))
  );
};
