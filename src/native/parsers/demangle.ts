import type { z } from "zod";

import { isSwiftMangledSymbolName } from "../../domain/swiftSymbolClassification.js";
import type { demangleSwiftSchema } from "../../domain/native/nativeInspection.js";

type DemangleSwift = z.infer<typeof demangleSwiftSchema>;
type DemangledSymbol = DemangleSwift["symbols"][number];

/**
 * swift-demangle removes one underscore from a name starting with `__` before
 * demangling, and prefixes `$` to an argument starting with S, s or e. A name
 * it cannot decode is printed in that adjusted spelling.
 */
const linkageName = (input: string): string =>
  input.startsWith("__") ? input.slice(1) : input;
const undecodedSpelling = (input: string): string =>
  /^[Sse]/u.test(input) ? `$${input}` : linkageName(input);

/**
 * Current swift-demangle skips an argument spelled exactly `_` (a likely shell
 * expansion of `_$s…`) with only a stderr warning, while older toolchains
 * print it unchanged. Never forwarding it keeps one output record per
 * forwarded argument on every toolchain.
 */
const SKIPPED_SYMBOL = "_";
const SKIPPED_LIMITATION =
  "swift-demangle skips the symbol `_` without output, so it was not passed to the demangler; it is reported unchanged because it is not a Swift mangling.";

/** Symbol arguments for `swift-demangle`; each yields one output record. */
export const swiftDemangleArguments = (inputs: readonly string[]): string[] =>
  inputs.filter((input) => input !== SKIPPED_SYMBOL);

/** Split LF-terminated records; empty output contains no record. */
const outputRecords = (output: string): string[] => {
  if (output === "") return [];
  if (!output.endsWith("\n"))
    throw new TypeError("swift-demangle output ended inside a record");
  return output.slice(0, -1).split("\n");
};

const decodedSymbol = (input: string, value: string): DemangledSymbol => {
  const decoded = value !== input && value !== undecodedSpelling(input);
  return {
    input,
    // Status describes decoding; retain the producer's exact spelling even
    // when it adjusted an identifier that it could not decode.
    output: value,
    status: decoded
      ? "demangled"
      : isSwiftMangledSymbolName(linkageName(input))
        ? "invalid"
        : "unchanged",
  };
};

/**
 * Preserve input ordering while parsing `swift-demangle --compact` output for
 * the arguments selected by `swiftDemangleArguments`. The demangler ends each
 * record with LF, so a carriage return belongs to the symbol text.
 */
export const parseDemangledSymbols = (
  inputs: readonly string[],
  output: string,
): Pick<DemangleSwift, "symbols" | "limitations"> => {
  const forwarded = swiftDemangleArguments(inputs);
  if (forwarded.length === 0 && output !== "" && output !== "\n")
    throw new TypeError("swift-demangle emitted output for an empty input");
  const records = forwarded.length === 0 ? [] : outputRecords(output);
  if (records.length !== forwarded.length)
    throw new TypeError("swift-demangle output count does not match input");
  let next = 0;
  const symbols = inputs.map<DemangledSymbol>((input) => {
    if (input === SKIPPED_SYMBOL)
      return { input, output: input, status: "unchanged" };
    const value = records[next++];
    if (value === undefined)
      throw new TypeError("swift-demangle omitted an output line");
    return decodedSymbol(input, value);
  });
  return {
    symbols,
    limitations: forwarded.length === inputs.length ? [] : [SKIPPED_LIMITATION],
  };
};
