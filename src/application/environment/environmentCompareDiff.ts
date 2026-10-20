import type { JsonObject } from "../../domain/analysisView/environmentStateRules.js";
import {
  isUuid,
  readClock,
  type ClockFormat,
} from "../../domain/analysisView/environmentStateWriteValues.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import {
  pairElements,
  translateValue,
  type IdMap,
} from "./environmentCompareIds.js";

export const DIFFERENCE_CATEGORIES = [
  "status",
  "missing-field",
  "extra-field",
  "value",
  "length",
  "order",
  "clock-format",
  "refused",
  "not-served",
  "no-tool",
  "unmapped-id",
] as const;
export type DifferenceCategory = (typeof DIFFERENCE_CATEGORIES)[number];

/** One way an environment answer differs from the live one: where, and both values cut short. */
export interface Difference {
  readonly category: DifferenceCategory;
  readonly pointer: string;
  readonly live?: string;
  readonly env?: string;
}

/** Values the comparison treated as equal although they differ: mapped ids, clocks of one format, generated values. */
export interface Normalised {
  ids: number;
  clocks: number;
  generated: number;
  /** Live bodies over the replay limit, compared by status only. */
  large_bodies: number;
}

/** At most this many differences are kept per step. */
export const STEP_DIFFERENCE_LIMIT = 20;
const VALUE_CHARS = 120;
const TIME_FIELD = /(at|time|date|timestamp|created|updated|modified)$/iu;

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const shown = (value: JsonValue | undefined): string => {
  const text = value === undefined ? "<absent>" : JSON.stringify(value);
  return text.length > VALUE_CHARS ? `${text.slice(0, VALUE_CHARS)}…` : text;
};

const escapePointer = (key: string): string =>
  key.replaceAll("~", "~0").replaceAll("/", "~1");

const formatKey = (format: ClockFormat): string =>
  format.kind === "epoch"
    ? `epoch-${format.unit}`
    : `iso${format.separator}${String(format.fraction)}${format.zone === "" ? "" : format.zone === "Z" ? "Z" : "offset"}`;

/** The format of a clock value: an ISO-8601 string, or an epoch number under a time-named field or as an array item. */
const clockFormat = (
  value: JsonValue,
  key: string | undefined,
): string | undefined => {
  if (typeof value === "number" && key !== undefined && !TIME_FIELD.test(key))
    return undefined;
  const clock = readClock(value);
  return clock === undefined ? undefined : formatKey(clock.format);
};

const characterClasses = (text: string): string =>
  [
    ...new Set(
      text
        .replaceAll(/\d/gu, "0")
        .replaceAll(/[a-z]/gu, "a")
        .replaceAll(/[A-Z]/gu, "A"),
    ),
  ]
    .sort()
    .join("");

/** Two values each side generated on its own: both UUIDs, or one length of eight or more with the same character classes and a digit. */
const generatedPair = (live: string, env: string): boolean =>
  (isUuid(live) && isUuid(env)) ||
  (live.length === env.length &&
    live.length >= 8 &&
    /\d/u.test(live) &&
    /\d/u.test(env) &&
    characterClasses(live) === characterClasses(env));

class Differ {
  readonly differences: Difference[] = [];
  readonly normalised: Normalised = {
    ids: 0,
    clocks: 0,
    generated: 0,
    large_bodies: 0,
  };

  constructor(readonly map: IdMap) {}

  add(difference: Difference): void {
    this.differences.push(difference);
  }

  scalar(live: JsonValue, env: JsonValue, pointer: string, key?: string): void {
    if (live === env) return;
    if (
      (typeof live === "string" || typeof live === "number") &&
      (typeof env === "string" || typeof env === "number")
    ) {
      if (this.map.pairs(live, env)) {
        this.normalised.ids += 1;
        return;
      }
      const liveClock = clockFormat(live, key);
      const envClock = clockFormat(env, key);
      if (liveClock !== undefined && envClock !== undefined) {
        if (liveClock === envClock) this.normalised.clocks += 1;
        else
          this.add({
            category: "clock-format",
            pointer,
            live: shown(live),
            env: shown(env),
          });
        return;
      }
      if (
        typeof live === "string" &&
        typeof env === "string" &&
        !this.map.hasLive(live) &&
        !this.map.hasEnv(env) &&
        generatedPair(live, env)
      ) {
        this.normalised.generated += 1;
        return;
      }
    }
    this.add({
      category: "value",
      pointer,
      live: shown(live),
      env: shown(env),
    });
  }

  array(live: JsonValue[], env: JsonValue[], pointer: string): void {
    if (this.sameItems(live, env, pointer)) return;
    const pairs = pairElements(live, env);
    if (live.length !== env.length || pairs.length !== live.length)
      this.add({
        category: "length",
        pointer,
        live: `${String(live.length)} items`,
        env: `${String(env.length)} items (${String(pairs.length)} paired)`,
      });
    const envOrder = pairs.map(([, right]) => right);
    if (
      envOrder.some((right, index) => index > 0 && right < envOrder[index - 1]!)
    )
      this.add({ category: "order", pointer });
    for (const [left, right] of pairs)
      this.value(live[left]!, env[right]!, `${pointer}/${String(left)}`);
  }

  /** Arrays of scalars holding the same items in another order differ only in order, as sets an application returns unordered do. */
  sameItems(live: JsonValue[], env: JsonValue[], pointer: string): boolean {
    const scalar = (item: JsonValue): boolean =>
      item === null || typeof item !== "object";
    if (live.length !== env.length || !live.every(scalar) || !env.every(scalar))
      return false;
    // Live ids compare in the environment's terms, as scalar values do.
    const mapped = live.map((item) => translateValue(item, this.map));
    const key = (items: JsonValue[]): string =>
      JSON.stringify(items.map((item) => JSON.stringify(item)).sort());
    if (key(mapped) !== key(env)) return false;
    this.normalised.ids += mapped.filter(
      (item, index) => item !== live[index],
    ).length;
    if (JSON.stringify(mapped) !== JSON.stringify(env))
      this.add({ category: "order", pointer });
    return true;
  }

  object(live: JsonObject, env: JsonObject, pointer: string): void {
    // An object keyed by ids compares each member under the environment's key.
    const envKey = (key: string): string => {
      const mapped = this.map.env(key);
      return mapped !== undefined && Object.hasOwn(env, String(mapped))
        ? String(mapped)
        : key;
    };
    const matched = new Set<string>();
    for (const [key, value] of Object.entries(live)) {
      const child = `${pointer}/${escapePointer(key)}`;
      const other = envKey(key);
      if (!Object.hasOwn(env, other))
        this.add({
          category: "missing-field",
          pointer: child,
          live: shown(value),
        });
      else {
        matched.add(other);
        this.value(value, env[other]!, child, key);
      }
    }
    for (const [key, value] of Object.entries(env))
      if (!matched.has(key))
        this.add({
          category: "extra-field",
          pointer: `${pointer}/${escapePointer(key)}`,
          env: shown(value),
        });
  }

  value(live: JsonValue, env: JsonValue, pointer: string, key?: string): void {
    if (Array.isArray(live) && Array.isArray(env))
      this.array(live, env, pointer);
    else if (isObject(live) && isObject(env)) this.object(live, env, pointer);
    else if (
      Array.isArray(live) ||
      Array.isArray(env) ||
      isObject(live) ||
      isObject(env)
    )
      this.add({
        category: "value",
        pointer,
        live: shown(live),
        env: shown(env),
      });
    else this.scalar(live, env, pointer, key);
  }
}

/** One answer: its status, and its JSON body, its text, or null without one. */
export interface Answer {
  readonly status: number | null;
  readonly body: JsonValue;
  /** Set when the body was over the replay limit, so only a prefix is known. */
  readonly cut?: boolean;
}

/** Compare a live answer with the environment's after normalisation. */
export const compareAnswers = (
  live: Answer,
  env: Answer,
  map: IdMap,
): { readonly differences: Difference[]; readonly normalised: Normalised } => {
  const differ = new Differ(map);
  if (live.status !== env.status)
    differ.add({
      category: "status",
      pointer: "",
      live: String(live.status),
      env: String(env.status),
    });
  if (live.cut === true) differ.normalised.large_bodies += 1;
  else differ.value(live.body, env.body, "");
  return { differences: differ.differences, normalised: differ.normalised };
};
