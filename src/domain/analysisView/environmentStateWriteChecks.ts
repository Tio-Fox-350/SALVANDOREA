import type { JsonValue } from "../jsonValue.js";
import { iterateUrlQueryParameters } from "../recordedTransportUrl.js";
import {
  compareUnicodeCodePoints as compare,
  compositeKey,
} from "../unicodeCodePointOrder.js";
import {
  at,
  collectionPathOf,
  decodedSegment,
  isObject,
  isParam,
  lastSegmentValue,
  listItems,
  renderStateEntity,
  renderStateList,
  replaceAt,
  same,
  scalarText,
  segmentsOf,
  type JsonObject,
  type StateDocument,
  type StateEntity,
  type StateItemView,
  type StateListView,
  type StateRecordFacts,
  type StateToolFacts,
  type StateView,
} from "./environmentStateRules.js";

/** A query as replay compares a call's: decoded values by name, in any order. A query repeating a name, which no call's arguments can carry, keeps its spelling. */
const queryKey = (query: string | undefined): string => {
  const pairs = [...iterateUrlQueryParameters(query ?? "")];
  return new Set(pairs.map(([name]) => name)).size === pairs.length
    ? compositeKey(pairs.sort(([left], [right]) => compare(left, right)))
    : compositeKey([query ?? ""]);
};

/** A list or document view's checked lines, by query, in the tool's recorded order, and which path segments are the tool's parameters. */
export interface CheckedLines {
  readonly params: ReadonlySet<number>;
  readonly byQuery: ReadonlyMap<
    string,
    readonly {
      readonly ordinal: number;
      readonly segments: readonly string[];
    }[]
  >;
}

/** The line a read's call is answered from, and the collection serving lists for it. */
export interface ServedLine {
  readonly ordinal: number;
  readonly collection: string;
}

/** Each list or document view's checked lines. */
export const checkedLines = (input: {
  readonly tools: readonly StateToolFacts[];
  readonly records: readonly StateRecordFacts[];
  readonly views: ReadonlyMap<string, StateView>;
}): Map<string, CheckedLines> => {
  const byOrdinal = new Map(
    input.records.map((record) => [record.ordinal, record]),
  );
  const tools = new Map(input.tools.map((tool) => [tool.name, tool]));
  const byView = new Map<string, CheckedLines>();
  for (const view of input.views.values()) {
    const tool = tools.get(view.tool);
    if (view.shape === "recorded" || view.shape === "item" || !tool) continue;
    const checked = new Set(view.checked_record_ordinals);
    const byQuery = new Map<
      string,
      { readonly ordinal: number; readonly segments: readonly string[] }[]
    >();
    for (const ordinal of tool.record_ordinals) {
      const record = byOrdinal.get(ordinal);
      if (!checked.has(ordinal) || record === undefined) continue;
      const key = queryKey(record.query);
      const lines = byQuery.get(key) ?? [];
      lines.push({ ordinal, segments: segmentsOf(record.path) });
      byQuery.set(key, lines);
    }
    const params = new Set(
      segmentsOf(tool.path_template).flatMap((segment, index) =>
        isParam(segment) ? [index] : [],
      ),
    );
    byView.set(view.tool, { params, byQuery });
  }
  return byView;
};

/**
 * The checked line serving answers a read's call from, ranked as replay ranks lines: every
 * parameter the read's value verbatim or once percent-decoded and the query the read's, then the
 * most verbatim parameters, then recorded order.
 */
export const servedLine = (
  lines: CheckedLines | undefined,
  record: StateRecordFacts,
): ServedLine | undefined => {
  const read = segmentsOf(record.path);
  let best: { line: ServedLine; verbatim: number } | undefined;
  for (const { ordinal, segments } of lines?.byQuery.get(
    queryKey(record.query),
  ) ?? []) {
    if (segments.length !== read.length) continue;
    let verbatim = 0;
    const matches = segments.every((segment, index) => {
      if (segment === read[index]) {
        if (lines!.params.has(index)) verbatim += 1;
        return true;
      }
      return (
        lines!.params.has(index) && decodedSegment(segment) === read[index]
      );
    });
    if (matches && (best === undefined || verbatim > best.verbatim))
      best = {
        line: { ordinal, collection: `/${segments.join("/")}` },
        verbatim,
      };
  }
  return best?.line;
};

export const entityTarget = (type: string, collection: string, id: string) =>
  `e${compositeKey([type, collection, id])}`;
export const collectionTarget = (type: string, collection: string) =>
  `c${compositeKey([type, collection])}`;
export const documentTarget = (tool: string) => `d${compositeKey([tool])}`;

/** The gate's copy of the state: entities in collection order and documents, changed by modelled writes. */
export class SimulatedState {
  readonly #entities = new Map<string, StateEntity>();
  readonly #collections = new Map<string, string[]>();
  readonly #documents = new Map<string, JsonValue>();

  constructor(
    entities: readonly StateEntity[],
    documents: readonly StateDocument[],
  ) {
    for (const entity of entities) this.put(entity);
    for (const document of documents)
      this.#documents.set(document.tool, document.value);
  }

  entity(
    type: string,
    collection: string,
    id: string,
  ): StateEntity | undefined {
    return this.#entities.get(entityTarget(type, collection, id));
  }

  members(type: string, collection: string): StateEntity[] {
    return (
      this.#collections.get(collectionTarget(type, collection)) ?? []
    ).map((key) => this.#entities.get(key)!);
  }

  ofType(type: string): StateEntity[] {
    return [...this.#entities.values()].filter(
      (entity) => entity.type === type,
    );
  }

  /** Replace an entity in place, or add it at `index` of its collection (the end when omitted). */
  put(entity: StateEntity, index?: number): void {
    const key = entityTarget(entity.type, entity.collection, entity.id);
    const known = this.#entities.has(key);
    this.#entities.set(key, entity);
    if (known) return;
    const collection = collectionTarget(entity.type, entity.collection);
    const order = this.#collections.get(collection) ?? [];
    order.splice(index ?? order.length, 0, key);
    this.#collections.set(collection, order);
  }

  remove(entity: StateEntity): void {
    const key = entityTarget(entity.type, entity.collection, entity.id);
    this.#entities.delete(key);
    const collection = collectionTarget(entity.type, entity.collection);
    const order = this.#collections.get(collection) ?? [];
    this.#collections.set(
      collection,
      order.filter((member) => member !== key),
    );
  }

  document(tool: string): JsonValue | undefined {
    return this.#documents.get(tool);
  }

  setDocument(tool: string, value: JsonValue): void {
    this.#documents.set(tool, value);
  }
}

/** An item read status that says the entity does not exist: 400, 404 or 410, as applications answer a missing id. */
export const isAbsence = (status: number | null): boolean =>
  status === 400 || status === 404 || status === 410;

/** A 2xx record: the only status whose response shows what a request did. */
export const succeeded = (record: StateRecordFacts): boolean =>
  record.status !== null && record.status >= 200 && record.status < 300;

/** Hand a base recording's body and a read's body to `use` together, parsing a recording once when both are the same. */
export const withBodies = <T>(
  withBody: <U>(ordinal: number, use: (body: JsonValue | undefined) => U) => U,
  ordinals: { readonly base: number; readonly read: number },
  use: (base: JsonValue | undefined, body: JsonValue | undefined) => T,
): T => {
  const { base, read } = ordinals;
  return base === read
    ? withBody(read, (body) => use(body, body))
    : withBody(base, (served) => withBody(read, (body) => use(served, body)));
};

/** A check's outcome and the targets it covered. */
export interface CheckOutcome {
  readonly pass: boolean;
  readonly targets: readonly string[];
  /** Entities the recording, or the served base of a recorded-membership list, lists that the state does not hold, by target. */
  readonly unheld: readonly string[];
}

/** What a check compares: the read's recorded body and the served base recording it would answer on. */
interface ReadBodies {
  readonly body: JsonValue | undefined;
  /** The recording whose envelope the served answer keeps: an item view's envelope, a list line's latest init recording. */
  readonly base: JsonValue | undefined;
  readonly volatile: ReadonlySet<string>;
}

/** An item read: the answer the held entity renders into the served envelope must equal the recording; a recorded 404 or 410 agrees with none held. */
export const checkItemRead = (
  state: SimulatedState,
  view: StateItemView,
  record: StateRecordFacts,
  check: ReadBodies,
): CheckOutcome | undefined => {
  const collection = collectionPathOf(record, true);
  const id = lastSegmentValue(record.path);
  const entity = state.entity(view.type, collection, id);
  const targets = [entityTarget(view.type, collection, id)];
  if (isAbsence(record.status) || (succeeded(record) && check.body === null))
    return { pass: entity === undefined, targets, unheld: [] };
  if (!succeeded(record) || check.base === undefined) return undefined;
  const object =
    check.body === undefined ? undefined : at(check.body, view.pointer);
  if (!isObject(object)) return undefined;
  if (entity === undefined) return { pass: false, targets, unheld: targets };
  const shown = renderStateEntity(entity, view, check.volatile, object);
  return {
    pass: same(replaceAt(check.base, view.pointer, shown), check.body),
    targets,
    unheld: [],
  };
};

/** A list read's bodies with the listed items of the read and of its served base. */
interface ListBodies {
  readonly body: JsonValue;
  readonly base: JsonValue;
  readonly items: readonly JsonObject[];
  readonly baseItems: readonly JsonObject[];
  readonly idField: string;
  readonly volatile: ReadonlySet<string>;
  /** The collection serving lists: the answering line's. */
  readonly collection: string;
}

/** The served list rendered from the base with `members`, compared with the read; volatile fields take the read's values. */
const listCheck = (
  view: StateListView,
  check: ListBodies,
  members: readonly StateEntity[],
): boolean => {
  const observed = new Map(
    check.items.map((item) => [scalarText(item[check.idField]) ?? "", item]),
  );
  const rendered = members.map((entity) =>
    renderStateEntity(entity, view, check.volatile, observed.get(entity.id)),
  );
  return same(renderStateList(view, check.base, rendered), check.body);
};

/** A list read of every entity of a collection: membership, order, fields and counters must render from the state. */
const checkAllList = (
  state: SimulatedState,
  view: StateListView,
  check: ListBodies,
): CheckOutcome => {
  const { collection } = check;
  const members = state.members(view.type, collection);
  const held = new Set(members.map((entity) => entity.id));
  return {
    pass: listCheck(view, check, members),
    targets: [
      collectionTarget(view.type, collection),
      ...members.map((entity) =>
        entityTarget(view.type, collection, entity.id),
      ),
    ],
    unheld: check.items
      .map((item) => scalarText(item[check.idField]) ?? "")
      .filter((id) => !held.has(id))
      .map((id) => entityTarget(view.type, collection, id)),
  };
};

/** A list read of recorded members: the served list holds the base's members the state still holds, so a member it dropped or never listed fails. */
const checkRecordedList = (
  state: SimulatedState,
  view: StateListView,
  check: ListBodies,
): CheckOutcome => {
  const { collection } = check;
  const idOf = (item: JsonObject) => scalarText(item[check.idField]) ?? "";
  const members = check.baseItems.flatMap((item) => {
    const entity = state.entity(view.type, collection, idOf(item));
    return entity === undefined ? [] : [entity];
  });
  const targets: string[] = [];
  const unheld: string[] = [];
  for (const id of new Set([...check.baseItems, ...check.items].map(idOf)))
    (state.entity(view.type, collection, id) === undefined
      ? unheld
      : targets
    ).push(entityTarget(view.type, collection, id));
  return { pass: listCheck(view, check, members), targets, unheld };
};

/** A list read on a checked line, compared with the answer the served environment renders on that line's base recording from the collection it names. */
export const checkListRead = (
  state: SimulatedState,
  view: StateListView,
  record: StateRecordFacts,
  check: ReadBodies & { readonly idField: string; readonly collection: string },
): CheckOutcome | undefined => {
  if (!succeeded(record)) return undefined;
  const { body, base } = check;
  const items = body === undefined ? undefined : listItems(body, view.pointer);
  const baseItems =
    base === undefined ? undefined : listItems(base, view.pointer);
  if (
    body === undefined ||
    base === undefined ||
    items === undefined ||
    baseItems === undefined
  )
    return undefined;
  const bodies = { ...check, body, base, items, baseItems };
  return view.membership === "all"
    ? checkAllList(state, view, bodies)
    : checkRecordedList(state, view, bodies);
};

/** A document read on its checked line must equal the held document. */
export const checkDocumentRead = (
  state: SimulatedState,
  tool: string,
  record: StateRecordFacts,
  body: JsonValue | undefined,
): CheckOutcome | undefined => {
  if (!succeeded(record)) return undefined;
  const value = state.document(tool);
  if (body === undefined || value === undefined) return undefined;
  return {
    pass: same(value, body),
    targets: [documentTarget(tool)],
    unheld: [],
  };
};

/**
 * Check, field by field, the writes that changed an entity an unmodelled write also changed:
 * each write's own fields must show as the state holds them. A create wrote every field, so it
 * cannot be told apart from the unmodelled change and is not checked.
 */
export const writtenFieldChecks = (
  entity: StateEntity,
  view: StateItemView,
  observed: JsonObject,
  check: {
    readonly volatile: ReadonlySet<string>;
    readonly writes: ReadonlyMap<string, readonly string[] | null>;
  },
): Map<string, boolean> => {
  const shown = renderStateEntity(entity, view, check.volatile, observed);
  const outcomes = new Map<string, boolean>();
  for (const [tool, fields] of check.writes) {
    const compared = (fields ?? []).filter(
      (field) => Object.hasOwn(observed, field) || Object.hasOwn(shown, field),
    );
    if (fields === null || compared.length === 0) continue;
    outcomes.set(
      tool,
      compared.every((field) => same(shown[field], observed[field])),
    );
  }
  return outcomes;
};
