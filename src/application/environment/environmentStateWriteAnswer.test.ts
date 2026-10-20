import { describe, expect, it } from "vitest";

import {
  servedFrom,
  type Served,
} from "../../../tests/fixtures/environmentStateServing.js";
import {
  BOOK_INIT_ROWS,
  BOOK_NOT_FOUND,
  BOOK_ROWS,
  DELETE_NOT_FOUND,
  FIRST_BOOK,
  SECOND_BOOK,
  THIRD_BOOK,
  book,
  bookClock,
  renamedBook,
  type Book,
} from "../../../tests/fixtures/environmentStateWrites.js";
import type { TimedCaptureRow } from "../../../tests/fixtures/analysisView.js";
import type { ReplayArguments } from "./environmentReplay.js";
import { servedCatalog } from "./environmentState.js";
import {
  environmentToolArguments,
  environmentToolDefinitions,
} from "./environmentTools.js";

/** The book the first served create of "New Book" makes: the next id, one second past the served clock's start. */
const NEW_BOOK = book(3, "New Book", bookClock(13));
const CREATE_NEW_BOOK = { body: { name: "New Book" } };

const entityOf = (books: Served, id: string) =>
  books.store.snapshot().rea_state.entities.find((entity) => entity.id === id);

/** Load what data/get reports back through data/add: the state must come back byte for byte. */
const expectReloadsUnchanged = (books: Served): void => {
  const before = books.snapshot();
  expect(books.store.replace(JSON.parse(before)).ok).toBe(true);
  expect(books.snapshot()).toBe(before);
};

describe("served creates", () => {
  it("creates a book with the next id, the served clock and a derived slug, which later reads show", () => {
    const books = servedFrom();
    const created = books.answer("post_books", CREATE_NEW_BOOK);
    expect(created).toMatchObject({
      status: 201,
      content_type: "application/json",
      state: {
        source: "state",
        view: "create",
        type: "/api/books",
        collection: "/api/books",
        id: "3",
      },
    });
    expect(created.body).toEqual(NEW_BOOK);
    expect(books.answer("get_books_by_id", { id: "3" })).toMatchObject({
      status: 200,
      body: NEW_BOOK,
      state: { source: "state", view: "item", id: "3" },
    });
    expect(books.answer("get_books")).toMatchObject({
      body: [FIRST_BOOK, SECOND_BOOK, NEW_BOOK],
      state: { source: "state", view: "list", membership: "all", listed: 3 },
    });
  });

  it("reports a created book in data/get without record citations and loads it back unchanged", () => {
    const books = servedFrom();
    books.answer("post_books", CREATE_NEW_BOOK);
    expect(entityOf(books, "3")).toEqual({
      type: "/api/books",
      collection: "/api/books",
      id: "3",
      fields: NEW_BOOK,
      view_fields: [],
      record_ordinals: [],
    });
    expectReloadsUnchanged(books);
    expect(books.answer("get_books_by_id", { id: "3" }).body).toEqual(NEW_BOOK);
  });
});

describe("served updates and deletes", () => {
  const SECOND_EDITION = renamedBook(SECOND_BOOK, "Second Edition", 13);
  const RENAME_SECOND = { id: "2", body: { name: "Second Edition" } };

  it("changes only the sent members, the slug that follows them and the clock", () => {
    const books = servedFrom();
    expect(books.answer("patch_books_by_id", RENAME_SECOND)).toMatchObject({
      status: 200,
      body: SECOND_EDITION,
      state: { source: "state", view: "update", id: "2" },
    });
    expect(books.answer("get_books_by_id", { id: "2" }).body).toEqual(
      SECOND_EDITION,
    );
    expect(books.answer("get_books").body).toEqual([
      FIRST_BOOK,
      SECOND_EDITION,
    ]);
  });

  it("cites no records for an updated book in data/get, so it loads back unchanged", () => {
    const books = servedFrom();
    books.answer("patch_books_by_id", RENAME_SECOND);
    expect(entityOf(books, "2")).toMatchObject({
      fields: SECOND_EDITION,
      record_ordinals: [],
    });
    expectReloadsUnchanged(books);
  });

  it("removes a deleted book; a later read answers the recorded 404 as a missing entity", () => {
    const books = servedFrom();
    expect(books.answer("delete_books_by_id", { id: "2" })).toMatchObject({
      status: 204,
      body: null,
      state: { source: "state", view: "delete", id: "2" },
    });
    expect(books.answer("get_books_by_id", { id: "2" })).toMatchObject({
      status: 404,
      body: BOOK_NOT_FOUND,
      state: {
        source: "state",
        view: "missing",
        type: "/api/books",
        collection: "/api/books",
        id: "2",
      },
    });
    expect(books.answer("get_books").body).toEqual([FIRST_BOOK]);
  });

  it("answers an update or delete of a missing book with a recorded 404, else refuses it", () => {
    const books = servedFrom();
    const before = books.snapshot();
    // The update recorded no absence, so it answers the item view's; the delete answers its own.
    expect(
      books.answer("patch_books_by_id", { id: "99", body: { name: "Ghost" } }),
    ).toMatchObject({
      status: 404,
      body: BOOK_NOT_FOUND,
      state: { view: "missing", id: "99" },
    });
    expect(books.answer("delete_books_by_id", { id: "99" })).toMatchObject({
      status: 404,
      body: DELETE_NOT_FOUND,
      state: { view: "missing", id: "99" },
    });
    expect(books.snapshot()).toBe(before);
    const unrecorded = servedFrom(
      BOOK_ROWS.filter(([, , , status]) => status !== 404),
    );
    for (const [name, args] of [
      ["patch_books_by_id", { id: "99", body: { name: "Ghost" } }],
      ["delete_books_by_id", { id: "99" }],
    ] as const)
      expect(unrecorded.refusal(name, args)).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining(
          "holds no /api/books entity 99 in /api/books",
        ),
      });
  });
});

describe("refusals", () => {
  it("refuses a body the capture does not support and leaves the state unchanged", () => {
    const books = servedFrom();
    const before = books.snapshot();
    const refused: [string, ReplayArguments, string][] = [
      [
        "post_books",
        { body: { name: "Extra", color: "red" } },
        "Member color is not one the capture showed stored",
      ],
      ["post_books", { body: {} }, "lacks required members name"],
      [
        "post_books",
        { body: { name: 42 } },
        "Member name must be a JSON string",
      ],
      ["post_books", { body: ["New Book"] }, "takes a JSON object body"],
      [
        "patch_books_by_id",
        { id: "1", body: "New Book" },
        "takes a JSON object body",
      ],
      ["patch_books_by_id", { id: "1", body: {} }, "sends none of the members"],
      [
        "patch_books_by_id",
        { id: "1", body: { title: "New" } },
        "Member title is not one",
      ],
    ];
    for (const [name, args, message] of refused) {
      expect(books.refusal(name, args)).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining(message),
      });
      expect(books.snapshot()).toBe(before);
    }
  });

  it("accepts a member the application stored differently only with the value the capture sent", () => {
    const bound = (entry: Book, format: string): Book => ({ ...entry, format });
    const books = servedFrom([
      [
        "GET",
        "/api/books",
        [bound(FIRST_BOOK, "PAPERBACK"), bound(SECOND_BOOK, "PAPERBACK")],
      ],
      ["GET", "/api/books/1", bound(FIRST_BOOK, "PAPERBACK")],
      ["GET", "/api/books/2", bound(SECOND_BOOK, "PAPERBACK")],
      [
        "POST",
        "/api/books",
        bound(THIRD_BOOK, "HARDCOVER"),
        201,
        { name: "Third Book", format: "hardcover" },
      ],
      ["GET", "/api/books/3", bound(THIRD_BOOK, "HARDCOVER")],
    ]);
    const before = books.snapshot();
    expect(
      books.refusal("post_books", {
        body: { name: "Soft", format: "softcover" },
      }),
    ).toMatchObject({
      message: expect.stringContaining(
        "Member format is accepted only with the value the capture sent",
      ),
    });
    expect(books.snapshot()).toBe(before);
    expect(
      books.answer("post_books", {
        body: { name: "Hard", format: "hardcover" },
      }).body,
    ).toMatchObject({ id: 3, name: "Hard", format: "HARDCOVER" });
  });

  it("generates the same values after a refused call as without it", () => {
    const refusedFirst = servedFrom();
    refusedFirst.refusal("post_books", { body: {} });
    refusedFirst.refusal("patch_books_by_id", {
      id: "1",
      body: { title: "New" },
    });
    expect(refusedFirst.answer("post_books", CREATE_NEW_BOOK).body).toEqual(
      servedFrom().answer("post_books", CREATE_NEW_BOOK).body,
    );
  });
});

describe("generated values", () => {
  it("answers the same calls identically after a reset, never reusing a deleted id", () => {
    const books = servedFrom();
    const session = () => {
      const answers = [
        books.answer("post_books", CREATE_NEW_BOOK),
        books.answer("patch_books_by_id", {
          id: "3",
          body: { name: "Newer Book" },
        }),
        books.answer("delete_books_by_id", { id: "3" }),
        books.answer("post_books", { body: { name: "Another Book" } }),
        books.answer("get_books"),
      ];
      return { answers, text: JSON.stringify([answers, books.snapshot()]) };
    };
    const first = session();
    books.store.reset();
    expect(session().text).toBe(first.text);
    expect(first.answers[3]?.body).toMatchObject({
      id: 4,
      name: "Another Book",
    });
  });

  it("restarts the clock and the sequences when data/add loads a state", () => {
    const books = servedFrom();
    const initial: unknown = JSON.parse(books.snapshot());
    const created = books.answer("post_books", CREATE_NEW_BOOK);
    books.answer("post_books", { body: { name: "Another Book" } });
    expect(books.store.replace(initial).ok).toBe(true);
    // Had the sequence and clock run on, this create would take id 5 one second later.
    expect(books.answer("post_books", CREATE_NEW_BOOK).body).toEqual(
      created.body,
    );
  });
});

describe("served catalog", () => {
  it("adds only the served write tools, saying what each does to the state", () => {
    const { source, state } = servedFrom();
    const catalog = servedCatalog(source, state, "books");
    if (!catalog.ok) throw catalog.error;
    const described = new Map(
      catalog.value.tools.map((tool) => [tool.name, tool]),
    );
    // The export write targets no state type, so it is not served.
    expect([...described.keys()].sort()).toEqual([
      "delete_books_by_id",
      "get_books",
      "get_books_by_id",
      "patch_books_by_id",
      "post_books",
    ]);
    expect(described.get("post_books")?.description).toContain(
      "creates an entity of /api/books in the served environment state (body members name; required: name), modelled on the recorded calls",
    );
    expect(described.get("patch_books_by_id")?.description).toContain(
      "changes the entity the path names in the served environment state (body members name; send at least one)",
    );
    expect(described.get("delete_books_by_id")?.description).toContain(
      "removes the entity the path names from the served environment state",
    );
    expect(described.get("post_books")?.annotations.readOnlyHint).toBe(false);
    expect(described.get("get_books")?.description).toContain(
      "answers from the served environment state where the state backs this tool",
    );
  });

  it("serves every manifest tool unchanged in replay mode", () => {
    const { source } = servedFrom();
    const replay = servedCatalog(source, undefined, "books");
    const definitions = environmentToolDefinitions(source, "books");
    if (!replay.ok || !definitions.ok) throw new Error("Expected a catalog");
    expect(replay.value).toEqual({
      tools: definitions.value,
      dataPlane: "none",
    });
    expect(replay.value.tools.map(({ name }) => name)).toContain(
      "post_exports",
    );
  });
});

describe("paged list lines", () => {
  it("answers an argument-less list from the state on a line that only pages, and another page from its recording", () => {
    const paged = servedFrom([
      ["GET", "/api/books?limit=50", [FIRST_BOOK, SECOND_BOOK]],
      ...BOOK_INIT_ROWS.slice(1),
      ["POST", "/api/books", THIRD_BOOK, 201, { name: "Third Book" }],
      ["GET", "/api/books/3", THIRD_BOOK],
      ["GET", "/api/books?limit=50", [FIRST_BOOK, SECOND_BOOK, THIRD_BOOK]],
    ]);
    const created = paged.answer("post_books", CREATE_NEW_BOOK).body;
    expect(paged.answer("get_books")).toMatchObject({
      body: [FIRST_BOOK, SECOND_BOOK, created],
      replay: { record_ordinal: 0, exact_match: false },
      state: { source: "state", view: "list", listed: 3 },
    });
    expect(paged.answer("get_books", { limit: "10" })).toMatchObject({
      body: [FIRST_BOOK, SECOND_BOOK],
      state: { source: "recording", reason: "unrecorded-request" },
    });
  });
});

describe("path values", () => {
  const orgBook = (id: number, org: string, name: string): Book => ({
    id,
    org,
    name,
  });
  const ALPHA = orgBook(1, "my org1", "Alpha");
  const BETA = orgBook(2, "acme2", "Beta");
  const GAMMA = orgBook(3, "my org1", "Gamma");
  const DELTA = orgBook(4, "acme2", "Delta");
  /** Books under two organisations, one whose name the paths percent-encode, and a create under each. */
  const ROWS: readonly TimedCaptureRow[] = [
    ["GET", "/api/orgs/my%20org1/books", [ALPHA]],
    ["GET", "/api/orgs/acme2/books", [BETA]],
    ["GET", "/api/orgs/my%20org1/books/1", ALPHA],
    ["GET", "/api/orgs/acme2/books/2", BETA],
    ["POST", "/api/orgs/my%20org1/books", GAMMA, 201, { name: "Gamma" }],
    ["GET", "/api/orgs/my%20org1/books", [ALPHA, GAMMA]],
    ["POST", "/api/orgs/acme2/books", DELTA, 201, { name: "Delta" }],
    ["GET", "/api/orgs/acme2/books", [BETA, DELTA]],
  ];

  it("stores a parent path value decoded, as the gate learned it, whichever spelling the call uses", () => {
    for (const spelling of ["my%20org1", "my org1"]) {
      const books = servedFrom(ROWS);
      const tool = books.source.manifest.tools.find(
        (candidate) => candidate.method === "POST",
      )!;
      expect(books.state.writes.get(tool.name)).toMatchObject({
        served: true,
        rules: expect.arrayContaining([
          expect.objectContaining({ field: "org", rule: "path" }),
        ]),
      });
      const [org] = environmentToolArguments(tool).path.values();
      books.answer(tool.name, { [org!]: spelling, body: { name: "Epsilon" } });
      const created = books.store
        .snapshot()
        .rea_state.entities.find(
          (entity) => entity.fields["name"] === "Epsilon",
        );
      expect(created).toMatchObject({
        collection: "/api/orgs/my%20org1/books",
        fields: { org: "my org1" },
      });
    }
  });
});

describe("collections a create chooses", () => {
  const orgBook = (id: number, name: string): Book => ({ id, name });
  /** One organisation listed under two spellings and another organisation, each with a create. */
  const ROWS: readonly TimedCaptureRow[] = [
    ["GET", "/api/orgs/%61cme1/books", [orgBook(1, "Alpha")]],
    ["GET", "/api/orgs/acme1/books", [orgBook(2, "Beta")]],
    ["GET", "/api/orgs/beta2/books", [orgBook(3, "Gamma")]],
    [
      "POST",
      "/api/orgs/acme1/books",
      orgBook(4, "Delta"),
      201,
      { name: "Delta" },
    ],
    ["GET", "/api/orgs/acme1/books", [orgBook(2, "Beta"), orgBook(4, "Delta")]],
    [
      "POST",
      "/api/orgs/beta2/books",
      orgBook(5, "Epsilon"),
      201,
      { name: "Epsilon" },
    ],
    [
      "GET",
      "/api/orgs/beta2/books",
      [orgBook(3, "Gamma"), orgBook(5, "Epsilon")],
    ],
  ];

  it("creates in the collection the call spells verbatim, as item calls choose their entity", () => {
    const books = servedFrom(ROWS);
    const tool = books.source.manifest.tools.find(
      (candidate) => candidate.method === "POST",
    )!;
    expect(books.state.writes.get(tool.name)).toMatchObject({ served: true });
    const [org] = environmentToolArguments(tool).path.values();
    books.answer(tool.name, { [org!]: "acme1", body: { name: "Zeta" } });
    expect(
      books.store
        .snapshot()
        .rea_state.entities.find((entity) => entity.fields["name"] === "Zeta")
        ?.collection,
    ).toBe("/api/orgs/acme1/books");
  });
});

describe("missing entities after a delete", () => {
  it("answers with a recorded 2xx null, which the gate also took as an absence", () => {
    const books = servedFrom([
      ...BOOK_INIT_ROWS,
      ["DELETE", "/api/books/2", "", 204],
      ["GET", "/api/books/2", null],
    ]);
    expect(books.state.writes.get("delete_books_by_id")).toMatchObject({
      served: true,
    });
    books.answer("delete_books_by_id", { id: "1" });
    expect(books.answer("get_books_by_id", { id: "1" })).toMatchObject({
      status: 200,
      body: null,
      state: { view: "missing", id: "1" },
    });
  });
});
