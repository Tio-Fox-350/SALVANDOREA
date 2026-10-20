import { describe, expect, it } from "vitest";

import {
  timedCaptureEvidence,
  type TimedCaptureRow,
} from "../../../tests/fixtures/analysisView.js";
import {
  BOOK_INIT_ROWS,
  BOOK_NOT_FOUND,
  FIRST_BOOK,
  SECOND_BOOK,
  THIRD_BOOK,
  book,
  bookClock,
  environmentStateViewOf,
  renamedBook,
  type Book,
} from "../../../tests/fixtures/environmentStateWrites.js";
import type { JsonValue } from "../jsonValue.js";
import { ok } from "../result.js";
import { updatedFields } from "./environmentStateWriteApply.js";

/** The plan the gate gives `tool` over a capture of `rows`. */
const gated = (rows: readonly TimedCaptureRow[], tool: string) => {
  const { writes } = environmentStateViewOf(timedCaptureEvidence(rows));
  const plan = writes.find((candidate) => candidate.tool === tool);
  if (plan === undefined) throw new Error(`The gate planned no ${tool}`);
  return plan;
};

const RENAMED = renamedBook(FIRST_BOOK, "Renamed Book", 3);

describe("reads compared as the served environment answers them", () => {
  /** Item reads in a `{data, revision}` envelope, a rename, then a read recorded at `revision`. */
  const renamedInEnvelope = (revision: string): TimedCaptureRow[] => [
    ["GET", "/api/books", [FIRST_BOOK, SECOND_BOOK]],
    ["GET", "/api/books/1", { data: FIRST_BOOK, revision: "r1" }],
    ["GET", "/api/books/2", { data: SECOND_BOOK, revision: "r1" }],
    ["PATCH", "/api/books/1", RENAMED, 200, { name: "Renamed Book" }],
    ["GET", "/api/books/1", { data: RENAMED, revision }],
  ];

  it("contradicts a write when an item read's envelope differs from the one served", () => {
    expect(gated(renamedInEnvelope("r2"), "patch_books_by_id")).toMatchObject({
      served: false,
      reason: "contradicted",
      contradicted_by: 4,
    });
    expect(gated(renamedInEnvelope("r1"), "patch_books_by_id")).toMatchObject({
      served: true,
      checked_record_ordinals: [4],
    });
  });

  /** A list in a `{items, revision}` envelope, a create, then the list recorded at `revision`. */
  const createdInEnvelope = (revision: string): TimedCaptureRow[] => [
    ["GET", "/api/books", { items: [FIRST_BOOK, SECOND_BOOK], revision: "r1" }],
    ["GET", "/api/books/1", FIRST_BOOK],
    ["GET", "/api/books/2", SECOND_BOOK],
    ["POST", "/api/books", THIRD_BOOK, 201, { name: "Third Book" }],
    [
      "GET",
      "/api/books",
      { items: [FIRST_BOOK, SECOND_BOOK, THIRD_BOOK], revision },
    ],
  ];

  it("contradicts a write when a list's envelope differs from its served line", () => {
    expect(gated(createdInEnvelope("r2"), "post_books")).toMatchObject({
      served: false,
      reason: "contradicted",
      contradicted_by: 4,
    });
    expect(gated(createdInEnvelope("r1"), "post_books")).toMatchObject({
      served: true,
      checked_record_ordinals: [4],
    });
  });

  /** A filtered list of both books, a delete of the second, then the filtered list recorded with `listed`. */
  const deletedFromFiltered = (listed: readonly Book[]): TimedCaptureRow[] => [
    ["GET", "/api/books/1", FIRST_BOOK],
    ["GET", "/api/books/2", SECOND_BOOK],
    ["GET", "/api/books?shelf=a", [FIRST_BOOK, SECOND_BOOK]],
    ["DELETE", "/api/books/2", "", 204],
    ["GET", "/api/books?shelf=a", [...listed]],
  ];

  it("contradicts a delete that a filtered list still shows, and confirms one it drops", () => {
    expect(
      gated(
        deletedFromFiltered([FIRST_BOOK, SECOND_BOOK]),
        "delete_books_by_id",
      ),
    ).toMatchObject({
      served: false,
      reason: "contradicted",
      contradicted_by: 4,
    });
    expect(
      gated(deletedFromFiltered([FIRST_BOOK]), "delete_books_by_id"),
    ).toMatchObject({ served: true, checked_record_ordinals: [4] });
  });

  /** A delete confirmed by an item read, then the filtered list recorded with its query reordered. */
  const deletedThenReordered = (listed: readonly Book[]): TimedCaptureRow[] => [
    ["GET", "/api/books/1", FIRST_BOOK],
    ["GET", "/api/books/2", SECOND_BOOK],
    ["GET", "/api/books?shelf=a&sort=id", [FIRST_BOOK, SECOND_BOOK]],
    ["DELETE", "/api/books/2", "", 204],
    ["GET", "/api/books/2", BOOK_NOT_FOUND, 404],
    ["GET", "/api/books?sort=id&shelf=a", [...listed]],
  ];

  it("checks a list read on a checked line however its query is ordered, as serving matches it", () => {
    // The item read already checked the delete, so a list still showing the book marks it a side effect.
    expect(
      gated(
        deletedThenReordered([FIRST_BOOK, SECOND_BOOK]),
        "delete_books_by_id",
      ),
    ).toMatchObject({ served: false, reason: "side-effect" });
    expect(
      gated(deletedThenReordered([FIRST_BOOK]), "delete_books_by_id"),
    ).toMatchObject({ served: true, checked_record_ordinals: [4] });
  });
});

describe("update constants", () => {
  const paper = (entry: Book, format = "PAPER"): Book => ({ ...entry, format });
  const RENAMED_PAPER = paper(RENAMED);
  const HARDCOVER = paper(
    { ...SECOND_BOOK, updated_at: bookClock(5) },
    "HARDCOVER",
  );
  /** A rename that keeps the format, then a format change the application stores in capitals. */
  const ROWS: TimedCaptureRow[] = [
    ["GET", "/api/books", [paper(FIRST_BOOK), paper(SECOND_BOOK)]],
    ["GET", "/api/books/1", paper(FIRST_BOOK)],
    ["GET", "/api/books/2", paper(SECOND_BOOK)],
    ["PATCH", "/api/books/1", RENAMED_PAPER, 200, { name: "Renamed Book" }],
    ["GET", "/api/books/1", RENAMED_PAPER],
    ["PATCH", "/api/books/2", HARDCOVER, 200, { format: "hardcover" }],
    ["GET", "/api/books/2", HARDCOVER],
  ];

  it("stores the value the call that showed a constant recorded, as serving applies the plan", () => {
    const plan = gated(ROWS, "patch_books_by_id");
    expect(plan).toMatchObject({
      served: true,
      observation: { ordinal: 3, pointer: "" },
      body: { fixed: [{ member: "format", sent: "hardcover" }] },
      checked_record_ordinals: [4, 6],
    });
    // Serving reads the plan's observation, the first update's answer, which still shows PAPER.
    const served = updatedFields(
      plan,
      { before: paper(SECOND_BOOK), observed: RENAMED_PAPER },
      {
        path: "/api/books/2",
        pathValues: new Map([["id", "2"]]),
        body: { format: "hardcover" },
        id: "2",
      },
      () => bookClock(9),
    );
    expect(served).toEqual(
      ok(paper({ ...SECOND_BOOK, updated_at: bookClock(9) }, "HARDCOVER")),
    );
  });
});

describe("write examples", () => {
  it("takes no modelled effect or exemplar from a redirected write", () => {
    const rows: TimedCaptureRow[] = [
      ...BOOK_INIT_ROWS,
      ["DELETE", "/api/books/2", "", 302],
      ["GET", "/api/books/2", SECOND_BOOK],
      ["DELETE", "/api/books/2", "", 204],
      ["GET", "/api/books/2", BOOK_NOT_FOUND, 404],
    ];
    expect(gated(rows, "delete_books_by_id")).toMatchObject({
      served: true,
      exemplar_ordinal: 5,
      checked_record_ordinals: [6],
      contradicted_by: null,
    });
  });
});

describe("update rules learned from a later call", () => {
  const versioned = (entry: Book, version: number): Book => ({
    ...entry,
    version,
  });
  /** Two renames, of the first and the second book, each answered at the version given. */
  const renames = (first: number, second: number): TimedCaptureRow[] => {
    const firstAfter = versioned(
      renamedBook(FIRST_BOOK, "Renamed Book", 3),
      first,
    );
    const secondAfter = versioned(
      renamedBook(SECOND_BOOK, "Second Edition", 5),
      second,
    );
    return [
      [
        "GET",
        "/api/books",
        [versioned(FIRST_BOOK, 1), versioned(SECOND_BOOK, 1)],
      ],
      ["GET", "/api/books/1", versioned(FIRST_BOOK, 1)],
      ["GET", "/api/books/2", versioned(SECOND_BOOK, 1)],
      ["PATCH", "/api/books/1", firstAfter, 200, { name: "Renamed Book" }],
      ["GET", "/api/books/1", firstAfter],
      ["PATCH", "/api/books/2", secondAfter, 200, { name: "Second Edition" }],
      ["GET", "/api/books/2", secondAfter],
    ];
  };

  it("leaves an update unserved when one call increments a field another left as it was", () => {
    for (const [first, second] of [
      [1, 2],
      [2, 1],
    ] as const)
      expect(gated(renames(first, second), "patch_books_by_id")).toMatchObject({
        served: false,
        reason: "unexplained-change",
      });
    expect(gated(renames(2, 2), "patch_books_by_id")).toMatchObject({
      served: true,
      rules: expect.arrayContaining([{ field: "version", rule: "increment" }]),
      checked_record_ordinals: [4, 6],
    });
  });
});

describe("slug rules learned from a later call", () => {
  /** A patch of the first book sending `name`, answered with `answered`, then a rename of the second. */
  const renames = (name: string, answered: Book): TimedCaptureRow[] => {
    const second = renamedBook(SECOND_BOOK, "Second Edition", 5);
    return [
      ...BOOK_INIT_ROWS,
      ["PATCH", "/api/books/1", answered, 200, { name }],
      ["GET", "/api/books/1", answered],
      ["PATCH", "/api/books/2", second, 200, { name: "Second Edition" }],
      ["GET", "/api/books/2", second],
    ];
  };

  it("serves a slug rule an earlier call agrees with, and not one it contradicts", () => {
    const kept = { ...FIRST_BOOK, updated_at: bookClock(3) };
    expect(
      gated(renames("First Book", kept), "patch_books_by_id"),
    ).toMatchObject({
      served: true,
      rules: expect.arrayContaining([
        { field: "slug", rule: "slug", from: "name" },
      ]),
    });
    // The application renamed the first book without following its slug.
    expect(
      gated(
        renames("Renamed Book", { ...kept, name: "Renamed Book" }),
        "patch_books_by_id",
      ),
    ).toMatchObject({ served: false, reason: "unexplained-change" });
  });
});

describe("checked lines", () => {
  /** A list page that echoes its own request path, as some APIs do. */
  const page = (path: string, items: JsonValue[]): JsonValue => ({
    path,
    items,
  });
  const PLAIN = "/api/orgs/acme1/books";
  const ENCODED = "/api/orgs/%61cme1/books";
  const OTHER = "/api/orgs/beta2/books";
  /** Three organisations' books under one templated tool, two spelling one organisation differently, then deletes each confirmed by its list. */
  const ROWS: TimedCaptureRow[] = [
    ["GET", PLAIN, page(PLAIN, [FIRST_BOOK])],
    ["GET", ENCODED, page(ENCODED, [SECOND_BOOK])],
    ["GET", OTHER, page(OTHER, [THIRD_BOOK])],
    ["GET", `${PLAIN}/1`, FIRST_BOOK],
    ["GET", `${ENCODED}/2`, SECOND_BOOK],
    ["GET", `${OTHER}/3`, THIRD_BOOK],
    ["DELETE", `${ENCODED}/2`, "", 204],
    ["GET", ENCODED, page(ENCODED, [])],
    ["DELETE", `${OTHER}/3`, "", 204],
    ["GET", OTHER, page(OTHER, [])],
  ];

  it("keeps a line's path spelling, as replay prefers the verbatim one", () => {
    const view = environmentStateViewOf(timedCaptureEvidence(ROWS), [
      "sibling-variance",
    ]);
    expect(view.views).toContainEqual(
      expect.objectContaining({
        shape: "list",
        checked_record_ordinals: [0, 1, 2],
      }),
    );
    expect(
      view.writes.find((candidate) => candidate.effect === "delete"),
    ).toMatchObject({ served: true, checked_record_ordinals: [7, 9] });
  });
  /** Organisations listed only under encoded or other spellings, a delete in each, then a list of the first spelled plainly. */
  const deletedThenPlain = (listed: readonly Book[]): TimedCaptureRow[] => {
    const third = "/api/orgs/gamma3/books";
    const fourth = book(4, "Fourth Book", "2026-10-01T11:00:00Z");
    return [
      ["GET", ENCODED, [SECOND_BOOK]],
      ["GET", OTHER, [THIRD_BOOK]],
      ["GET", third, [fourth]],
      ["GET", `${ENCODED}/2`, SECOND_BOOK],
      ["GET", `${OTHER}/3`, THIRD_BOOK],
      ["DELETE", `${ENCODED}/2`, "", 204],
      ["GET", `${ENCODED}/2`, BOOK_NOT_FOUND, 404],
      ["DELETE", `${OTHER}/3`, "", 204],
      ["GET", `${OTHER}/3`, BOOK_NOT_FOUND, 404],
      ["GET", PLAIN, [...listed]],
    ];
  };

  it("checks a read spelled plainly against the encoded line serving answers it from", () => {
    const deleteOf = (listed: readonly Book[]) =>
      environmentStateViewOf(timedCaptureEvidence(deletedThenPlain(listed)), [
        "sibling-variance",
      ]).writes.find((candidate) => candidate.effect === "delete");
    // Serving lists the encoded collection for the plain argument, which no longer holds the book.
    expect(deleteOf([SECOND_BOOK])).toMatchObject({
      served: false,
      reason: "contradicted",
      contradicted_by: 9,
    });
    expect(deleteOf([])).toMatchObject({
      served: true,
      checked_record_ordinals: [6, 8, 9],
    });
  });
});

describe("insert rules", () => {
  it("still learns where a list places a create after an item read confirmed it", () => {
    const alpha = book(3, "Alpha", bookClock(3));
    const rows: TimedCaptureRow[] = [
      ...BOOK_INIT_ROWS,
      ["POST", "/api/books", alpha, 201, { name: "Alpha" }],
      ["GET", "/api/books/3", alpha],
      ["GET", "/api/books", [alpha, FIRST_BOOK, SECOND_BOOK]],
    ];
    expect(gated(rows, "post_books")).toMatchObject({
      served: true,
      insert: { rule: "sorted", field: "name", direction: "ascending" },
      checked_record_ordinals: [4, 5],
    });
  });
});
