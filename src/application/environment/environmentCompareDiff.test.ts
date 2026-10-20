import { describe, expect, it } from "vitest";

import { compareAnswers } from "./environmentCompareDiff.js";
import { IdMap } from "./environmentCompareIds.js";

const compare = (
  live: unknown,
  env: unknown,
  map = new IdMap(),
  status: [number, number] = [200, 200],
) =>
  compareAnswers(
    { status: status[0], body: live as never },
    { status: status[1], body: env as never },
    map,
  );

describe("compareAnswers", () => {
  it("agrees on mapped ids, clocks of one format and generated values, and counts each", () => {
    const map = new IdMap();
    map.learn(101, 1);
    const result = compare(
      {
        id: 101,
        created_at: "2026-10-20T10:00:00Z",
        token: "3f2a9c8d7e",
        uuid: "6f1c2b9e-2a3d-4f5e-8a9b-0c1d2e3f4a5b",
      },
      {
        id: 1,
        created_at: "2026-10-17T18:00:03Z",
        token: "9b8e7d6c5a",
        uuid: "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d",
      },
      map,
    );
    expect(result.differences).toEqual([]);
    expect(result.normalised).toEqual({
      ids: 1,
      clocks: 1,
      generated: 2,
      large_bodies: 0,
    });
  });

  it("categorises status, missing and extra fields, values and clock formats", () => {
    const result = compare(
      { name: "A", gone: 1, at: "2026-10-20T10:00:00.123+00:00" },
      { name: "B", added: true, at: "2026-10-20T10:00:00Z" },
      new IdMap(),
      [409, 204],
    );
    expect(result.differences.map((d) => [d.category, d.pointer])).toEqual([
      ["status", ""],
      ["value", "/name"],
      ["missing-field", "/gone"],
      ["clock-format", "/at"],
      ["extra-field", "/added"],
    ]);
  });

  it("reports array length and order and compares paired items", () => {
    const result = compare(
      [
        { name: "B", n: 2 },
        { name: "A", n: 1 },
        { name: "C", n: 3 },
      ],
      [
        { name: "A", n: 1 },
        { name: "B", n: 5 },
      ],
    );
    expect(result.differences.map((d) => [d.category, d.pointer])).toEqual([
      ["length", ""],
      ["order", ""],
      ["value", "/0/n"],
    ]);
  });

  it("treats an epoch number as a clock only under a time-named field", () => {
    expect(
      compare({ updated: 1760000000 }, { updated: 1760000999 }).differences,
    ).toEqual([]);
    expect(
      compare({ size: 1760000000 }, { size: 1760000999 }).differences.map(
        (d) => d.category,
      ),
    ).toEqual(["value"]);
  });

  it("compares an object keyed by mapped ids under the environment's keys", () => {
    const map = new IdMap();
    map.learn("liveTable", "envTable");
    expect(
      compare(
        { tables: { liveTable: { name: "T" } } },
        { tables: { envTable: { name: "T" } } },
        map,
      ).differences,
    ).toEqual([]);
  });

  it("reports a reordered set of scalars as order alone and reads epoch array items as clocks", () => {
    expect(
      compare(
        { access: ["a", "b", "c"] },
        { access: ["c", "a", "b"] },
      ).differences.map((d) => [d.category, d.pointer]),
    ).toEqual([["order", "/access"]]);
    expect(
      compare({ stats: [[1792450800, 3]] }, { stats: [[1792285200, 3]] })
        .differences,
    ).toEqual([]);
  });

  it("compares a live body over the replay limit by status only and counts it", () => {
    const result = compareAnswers(
      { status: 200, body: '{"data":[', cut: true },
      { status: 200, body: null },
      new IdMap(),
    );
    expect(result.differences).toEqual([]);
    expect(result.normalised.large_bodies).toBe(1);
  });
});

describe("scalar sets of mapped ids", () => {
  it("differ only in order once live ids are mapped", () => {
    const map = new IdMap();
    map.learn(101, 1);
    map.learn(102, 2);
    const compared = compareAnswers(
      { status: 200, body: { ids: [101, 102] } },
      { status: 200, body: { ids: [2, 1] } },
      map,
    );
    expect(compared.differences).toEqual([
      { category: "order", pointer: "/ids" },
    ]);
    expect(compared.normalised.ids).toBe(2);
  });
});
