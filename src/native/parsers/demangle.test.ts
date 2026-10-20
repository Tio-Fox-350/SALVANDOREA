import { describe, expect, it } from "vitest";

import { parseDemangledSymbols, swiftDemangleArguments } from "./demangle.js";
import { swiftSymbolsSchema } from "../../contracts/native/nativeToolContracts.js";

describe("parseDemangledSymbols", () => {
  it("returns an empty array when given an empty input list", () => {
    expect(swiftSymbolsSchema.safeParse([]).success).toBe(true);
    expect(parseDemangledSymbols([], "").symbols).toEqual([]);
    expect(parseDemangledSymbols([], "\n").symbols).toEqual([]);
  });

  it("rejects demangler output when the input batch is empty", () => {
    expect(() => parseDemangledSymbols([], "unexpected\n")).toThrow(
      "swift-demangle emitted output for an empty input",
    );
  });

  it("parses demangled symbols successfully", () => {
    const inputs = ["$s4main4testyyF"];
    const output = "main.test() -> ()\n";
    expect(parseDemangledSymbols(inputs, output).symbols).toEqual([
      {
        input: "$s4main4testyyF",
        output: "main.test() -> ()",
        status: "demangled",
      },
    ]);
  });

  it("identifies unchanged non-Swift symbols", () => {
    const inputs = ["_printf"];
    const output = "_printf\n";
    expect(parseDemangledSymbols(inputs, output).symbols).toEqual([
      {
        input: "_printf",
        output: "_printf",
        status: "unchanged",
      },
    ]);
  });

  it("identifies invalid Swift symbols for every demangler mangling prefix", () => {
    const inputs = [
      "_T0Bogus",
      "$SBogus",
      "_$SBogus",
      "$sBogus",
      "_$sBogus",
      "@__swiftmacro_Bogus",
      "$eBogus",
      "_$eBogus",
      "_Tprintf",
    ];
    expect(
      parseDemangledSymbols(inputs, `${inputs.join("\n")}\n`).symbols.map(
        ({ status }) => status,
      ),
    ).toEqual([...Array<string>(8).fill("invalid"), "unchanged"]);
  });

  it("keeps the demangler's adjusted spelling of an undecoded name out of demangled", () => {
    const inputs = [
      "__T0Bogus",
      "__$sBogus",
      "___stack_chk_fail",
      "strlen",
      "Symbol",
      "entry",
      "__T04main3FooV",
      "s4main3FooV",
    ];
    const output = [
      "_T0Bogus",
      "_$sBogus",
      "__stack_chk_fail",
      "$strlen",
      "$Symbol",
      "$entry",
      "main.Foo",
      "main.Foo",
    ].join("\n");
    expect(parseDemangledSymbols(inputs, `${output}\n`).symbols).toEqual([
      { input: "__T0Bogus", output: "_T0Bogus", status: "invalid" },
      { input: "__$sBogus", output: "_$sBogus", status: "invalid" },
      {
        input: "___stack_chk_fail",
        output: "__stack_chk_fail",
        status: "unchanged",
      },
      { input: "strlen", output: "$strlen", status: "unchanged" },
      { input: "Symbol", output: "$Symbol", status: "unchanged" },
      { input: "entry", output: "$entry", status: "unchanged" },
      { input: "__T04main3FooV", output: "main.Foo", status: "demangled" },
      { input: "s4main3FooV", output: "main.Foo", status: "demangled" },
    ]);
  });

  it("parses mixed batches preserving ordering", () => {
    const inputs = ["$s4main4testyyF", "_printf", "$sInvalidMangle"];
    const output = "main.test() -> ()\n_printf\n$sInvalidMangle\n";
    expect(parseDemangledSymbols(inputs, output).symbols).toEqual([
      {
        input: "$s4main4testyyF",
        output: "main.test() -> ()",
        status: "demangled",
      },
      {
        input: "_printf",
        output: "_printf",
        status: "unchanged",
      },
      {
        input: "$sInvalidMangle",
        output: "$sInvalidMangle",
        status: "invalid",
      },
    ]);
  });

  it("reports `_`, which swift-demangle skips without a record, apart from the demangled batch", () => {
    const inputs = ["_", "$s4main3FooV", "_", "_Sa"];
    expect(swiftDemangleArguments(inputs)).toEqual(["$s4main3FooV", "_Sa"]);
    expect(parseDemangledSymbols(inputs, "main.Foo\n_Sa\n")).toEqual({
      symbols: [
        { input: "_", output: "_", status: "unchanged" },
        { input: "$s4main3FooV", output: "main.Foo", status: "demangled" },
        { input: "_", output: "_", status: "unchanged" },
        { input: "_Sa", output: "_Sa", status: "unchanged" },
      ],
      limitations: [expect.stringContaining("skips the symbol `_`")],
    });
    expect(swiftDemangleArguments(["_"])).toEqual([]);
    expect(parseDemangledSymbols(["_"], "")).toEqual({
      symbols: [{ input: "_", output: "_", status: "unchanged" }],
      limitations: [expect.stringContaining("skips the symbol `_`")],
    });
    expect(
      parseDemangledSymbols(["$s4main3FooV"], "main.Foo\n").limitations,
    ).toEqual([]);
  });

  it("rejects an omitted or unterminated record instead of reporting an empty decoding", () => {
    expect(() => parseDemangledSymbols(["$s4main3FooV"], "")).toThrow(
      "swift-demangle output count does not match input",
    );
    expect(() => parseDemangledSymbols(["$s4main3FooV"], "main.Foo")).toThrow(
      "swift-demangle output ended inside a record",
    );
  });

  it("throws TypeError when output count does not match input count", () => {
    expect(() =>
      parseDemangledSymbols(["sym1", "sym2"], "demangled1\n"),
    ).toThrow(TypeError);
    expect(() =>
      parseDemangledSymbols(["sym1"], "demangled1\ndemangled2\n"),
    ).toThrow("swift-demangle output count does not match input");
  });
});
