import { describe, expect, it } from "vitest";

import {
  parseCliOutputArguments,
  validateCliOutputArguments,
} from "./cliOutput.js";

describe("parseCliOutputArguments token-limit and token-offset", () => {
  it("accepts a non-negative integer limit", () => {
    const result = parseCliOutputArguments(["--token-limit", "10"]);
    expect(result.tokenLimit).toBe(10);
    expect(result.parseError).toBe(false);
    expect(result.invalidTokenValue).toBeUndefined();
  });

  it("accepts zero as an empty window", () => {
    const result = parseCliOutputArguments(["--token-limit", "0"]);
    expect(result.tokenLimit).toBe(0);
    expect(result.parseError).toBe(false);
    expect(result.invalidTokenValue).toBeUndefined();
  });

  it("accepts a non-negative integer offset", () => {
    const result = parseCliOutputArguments(["--token-offset", "50"]);
    expect(result.tokenOffset).toBe(50);
    expect(result.parseError).toBe(false);
    expect(result.invalidTokenValue).toBeUndefined();
  });

  it("rejects a negative limit", () => {
    const result = parseCliOutputArguments(["--token-limit", "-5"]);
    expect(result.tokenLimit).toBeUndefined();
    expect(result.parseError).toBe(false);
    expect(result.invalidTokenValue).toBe("--token-limit");
  });

  it("rejects a negative offset", () => {
    const result = parseCliOutputArguments(["--token-offset", "-100"]);
    expect(result.tokenOffset).toBeUndefined();
    expect(result.parseError).toBe(false);
    expect(result.invalidTokenValue).toBe("--token-offset");
  });

  it("rejects a fractional limit", () => {
    const result = parseCliOutputArguments(["--token-limit", "2.5"]);
    expect(result.tokenLimit).toBeUndefined();
    expect(result.parseError).toBe(false);
    expect(result.invalidTokenValue).toBe("--token-limit");
  });

  it("rejects a fractional offset", () => {
    const result = parseCliOutputArguments(["--token-offset", "7.5"]);
    expect(result.tokenOffset).toBeUndefined();
    expect(result.parseError).toBe(false);
    expect(result.invalidTokenValue).toBe("--token-offset");
  });

  it("records the first invalid flag when both are invalid", () => {
    const result = parseCliOutputArguments([
      "--token-limit",
      "-5",
      "--token-offset",
      "2.5",
    ]);
    expect(result.invalidTokenValue).toBe("--token-limit");
    expect(result.tokenLimit).toBeUndefined();
    expect(result.tokenOffset).toBeUndefined();
  });

  it("still sets a valid offset when only the limit is invalid", () => {
    const result = parseCliOutputArguments([
      "--token-limit",
      "-5",
      "--token-offset",
      "10",
    ]);
    expect(result.invalidTokenValue).toBe("--token-limit");
    expect(result.tokenLimit).toBeUndefined();
    expect(result.tokenOffset).toBe(10);
  });

  it("treats non-numeric input as a parse error (not invalidTokenValue)", () => {
    const result = parseCliOutputArguments(["--token-limit", "abc"]);
    expect(result.parseError).toBe(true);
    expect(result.invalidTokenValue).toBeUndefined();
  });
});

describe("validateCliOutputArguments token-limit and token-offset", () => {
  it("returns ok for a valid non-negative integer limit", () => {
    expect(
      validateCliOutputArguments(["--format", "toon", "--token-limit", "10"]),
    ).toEqual({ ok: true });
  });

  it("returns INVALID_TOKEN_VALUE for a negative limit", () => {
    const result = validateCliOutputArguments([
      "--format",
      "toon",
      "--token-limit",
      "-5",
    ]);
    expect(result).toMatchObject({ ok: false, code: "INVALID_TOKEN_VALUE" });
    expect((result as { message: string }).message).toContain("--token-limit");
    expect((result as { message: string }).message).toContain(
      "non-negative integer",
    );
  });

  it("returns INVALID_TOKEN_VALUE for a negative offset", () => {
    const result = validateCliOutputArguments([
      "--format",
      "toon",
      "--token-offset",
      "-100",
    ]);
    expect(result).toMatchObject({ ok: false, code: "INVALID_TOKEN_VALUE" });
    expect((result as { message: string }).message).toContain("--token-offset");
  });

  it("returns INVALID_TOKEN_VALUE for a fractional limit", () => {
    const result = validateCliOutputArguments([
      "--format",
      "toon",
      "--token-limit",
      "2.5",
    ]);
    expect(result).toMatchObject({ ok: false, code: "INVALID_TOKEN_VALUE" });
  });

  it("returns INVALID_TOKEN_VALUE for a fractional offset", () => {
    const result = validateCliOutputArguments([
      "--format",
      "toon",
      "--token-offset",
      "7.5",
    ]);
    expect(result).toMatchObject({ ok: false, code: "INVALID_TOKEN_VALUE" });
  });

  it("INVALID_TOKEN_VALUE format follows the active output format", () => {
    const yaml = validateCliOutputArguments([
      "--format",
      "yaml",
      "--token-limit",
      "-1",
    ]);
    expect((yaml as { format: string }).format).toBe("yaml");

    const jsonl = validateCliOutputArguments([
      "--format",
      "jsonl",
      "--token-limit",
      "-1",
    ]);
    expect((jsonl as { format: string }).format).toBe("jsonl");

    const toon = validateCliOutputArguments([
      "--format",
      "toon",
      "--token-limit",
      "-1",
    ]);
    expect((toon as { format: string }).format).toBe("json");
  });

  it("INVALID_TOKEN_VALUE takes precedence over UNSUPPORTED_OUTPUT_COMBINATION", () => {
    const result = validateCliOutputArguments([
      "--format",
      "json",
      "--token-limit",
      "-5",
    ]);
    expect(result).toMatchObject({ ok: false, code: "INVALID_TOKEN_VALUE" });
  });
});
