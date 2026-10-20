import type {
  StateEntity,
  StateType,
} from "../../domain/analysisView/environmentStateRules.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import { compositeKey } from "../../domain/unicodeCodePointOrder.js";
import { ENVIRONMENT_SERVE_OPERATION } from "./environmentSource.js";
import type { EnvironmentState } from "./environmentState.js";
import {
  parseStateDocument,
  STATE_INTAKE_LIMIT_BYTES,
  type HeldDocument,
  type StateContent,
} from "./environmentStateDocument.js";

/** What `data/get` reports: the current state as a `rea-state/v1` document. */
export interface StateSnapshot {
  readonly rea_state: {
    readonly version: 1;
    readonly state_evidence_id: string;
    readonly types: readonly StateType[];
    readonly entities: readonly StateEntity[];
    readonly documents: readonly HeldDocument[];
  };
}

const jsonBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

/** The bytes JSON writes for these array items and the commas between them. */
const itemsBytes = (items: readonly unknown[]): number =>
  items.reduce<number>((sum, item) => sum + jsonBytes(item), 0) +
  Math.max(0, items.length - 1);

/**
 * The live state one served environment answers from, shared by every MCP
 * session and the data plane. Mutations are synchronous and swap the whole
 * state, so every answer reads one consistent state. A mutation that would take
 * what `data/get` reports past the size `data/add` loads is refused, so that
 * report always loads back.
 */
export class EnvironmentStateStore {
  #entities: ReadonlyMap<string, StateEntity> = new Map();
  #collections: ReadonlyMap<string, readonly StateEntity[]> = new Map();
  #typeCollections: ReadonlyMap<string, readonly string[]> = new Map();
  #documents: ReadonlyMap<string, HeldDocument> = new Map();
  #content: StateContent = { entities: [], documents: [] };
  readonly #types: ReadonlyMap<string, StateType>;
  readonly #clockStart: number;
  /** What `data/get` writes for the current state, in UTF-8 bytes; kept by each mutation rather than reserialized. */
  #bytes = 0;
  /** The bytes of `data/get` with no entities or documents. */
  readonly #frameBytes: number;
  readonly #initialBytes: number;
  /** Served writes since the state was last reset or loaded: the clock's seconds and the generators' counter. */
  #writes = 0;
  /** The largest value each sequence has generated since the last reset or load, so a deleted entity's value is not reused. */
  readonly #sequences = new Map<string, number>();

  constructor(readonly state: EnvironmentState) {
    this.#types = new Map(
      state.types.map((type) => [type.collection_template, type]),
    );
    this.#clockStart =
      state.writeClock === null ? 0 : Date.parse(state.writeClock);
    this.#frameBytes = jsonBytes(this.#snapshotOf([], []));
    this.#initialBytes = this.#contentBytes(state);
    this.reset();
  }

  /** Restore the initial state the Evidence holds; the clock and counter start again. */
  reset(): void {
    this.#install(this.state, this.#initialBytes);
    this.#restart();
  }

  /** Validate a `rea-state/v1` document and, only when it is valid, make it the whole state; the clock and counter start again. */
  replace(document: unknown): Result<void, AnalysisInputError> {
    const content = parseStateDocument(this.state, document);
    if (!content.ok) return content;
    // data/get writes members a document may omit, so the state it reports must still be one data/add loads.
    const bytes = this.#contentBytes(content.value);
    if (bytes > STATE_INTAKE_LIMIT_BYTES)
      return err(
        new AnalysisInputError(
          ENVIRONMENT_SERVE_OPERATION,
          {
            userMessage: `The state would exceed ${String(STATE_INTAKE_LIMIT_BYTES)} bytes as data/get writes it.`,
          },
          [
            {
              path: [],
              reason: "out_of_range",
              message: `would exceed ${String(STATE_INTAKE_LIMIT_BYTES)} bytes as data/get writes it`,
              maximum: STATE_INTAKE_LIMIT_BYTES,
            },
          ],
        ),
      );
    this.#install(content.value, bytes);
    this.#restart();
    return ok(undefined);
  }

  /** The write a served call would be: its number since the last reset or load, and its clock instant, one second past the previous applied write. */
  pendingWrite(): { readonly count: number; readonly clockMs: number } {
    const count = this.#writes + 1;
    return { count, clockMs: this.#clockStart + count * 1000 };
  }

  /** Count an applied write and keep the sequence values it took, so a refused call takes none. */
  commitWrite(sequences: ReadonlyMap<string, number>): void {
    this.#writes += 1;
    for (const [key, value] of sequences)
      this.#sequences.set(key, Math.max(value, this.#sequences.get(key) ?? 0));
  }

  /** The next value of a sequence: one past both the largest held value and the largest an applied write took. */
  sequenceAfter(key: string, held: number): number {
    return Math.max(held, (this.#sequences.get(key) ?? 0) + 1);
  }

  #restart(): void {
    this.#writes = 0;
    this.#sequences.clear();
  }

  /** Every held entity of a type, in state order. */
  ofType(type: string): readonly StateEntity[] {
    return this.#content.entities.filter((entity) => entity.type === type);
  }

  /** Add an entity at `index` of its collection's order, unless the state would outgrow what `data/add` loads. */
  insert(
    entity: StateEntity,
    index: number,
  ): Result<void, AnalysisResourceConstraintError> {
    const entities = this.#content.entities;
    const bytes = this.#grown(
      jsonBytes(entity) + (entities.length > 0 ? 1 : 0),
    );
    if (!bytes.ok) return bytes;
    const members = this.inCollection(entity.type, entity.collection);
    const anchor =
      index < members.length
        ? entities.indexOf(members[index]!)
        : members.length > 0
          ? entities.indexOf(members.at(-1)!) + 1
          : entities.length;
    this.#install(
      {
        ...this.#content,
        entities: [
          ...entities.slice(0, anchor),
          entity,
          ...entities.slice(anchor),
        ],
      },
      bytes.value,
    );
    return ok(undefined);
  }

  /** Replace a held entity's values in place, unless the state would outgrow what `data/add` loads. */
  update(entity: StateEntity): Result<void, AnalysisResourceConstraintError> {
    const key = compositeKey([entity.type, entity.collection, entity.id]);
    const held = this.#entities.get(key);
    if (held === undefined) return ok(undefined);
    const bytes = this.#grown(jsonBytes(entity) - jsonBytes(held));
    if (!bytes.ok) return bytes;
    this.#install(
      {
        ...this.#content,
        entities: this.#content.entities.map((candidate) =>
          candidate === held ? entity : candidate,
        ),
      },
      bytes.value,
    );
    return ok(undefined);
  }

  remove(entity: StateEntity): void {
    const held = this.#entities.get(
      compositeKey([entity.type, entity.collection, entity.id]),
    );
    if (held === undefined) return;
    const entities = this.#content.entities.filter(
      (candidate) => candidate !== held,
    );
    this.#install(
      { ...this.#content, entities },
      this.#bytes - jsonBytes(held) - (entities.length > 0 ? 1 : 0),
    );
  }

  /** Set a held document's value, unless the state would outgrow what `data/add` loads; a value that is not the Evidence's cites no record. */
  setDocument(
    tool: string,
    value: JsonValue,
  ): Result<void, AnalysisResourceConstraintError> {
    const held = this.#documents.get(tool);
    if (held === undefined) return ok(undefined);
    const written = { tool: held.tool, path: held.path, value };
    const bytes = this.#grown(jsonBytes(written) - jsonBytes(held));
    if (!bytes.ok) return bytes;
    this.#install(
      {
        ...this.#content,
        documents: this.#content.documents.map((document) =>
          document === held ? written : document,
        ),
      },
      bytes.value,
    );
    return ok(undefined);
  }

  /** The state's bytes after a change of `delta`, or a refusal when a change that grows it would pass the intake limit. */
  #grown(delta: number): Result<number, AnalysisResourceConstraintError> {
    const bytes = this.#bytes + delta;
    if (delta <= 0 || bytes <= STATE_INTAKE_LIMIT_BYTES) return ok(bytes);
    return err(
      new AnalysisResourceConstraintError(
        ENVIRONMENT_SERVE_OPERATION,
        "capacity",
        "The write would take the served state past the size data/add loads",
        { max_state_bytes: STATE_INTAKE_LIMIT_BYTES, state_bytes: bytes },
        {
          retryable: false,
          remediationAction:
            "Delete entities, or restore a smaller state with data/reset or data/add.",
        },
      ),
    );
  }

  type(collectionTemplate: string): StateType | undefined {
    return this.#types.get(collectionTemplate);
  }

  entity(
    type: string,
    collection: string,
    id: string,
  ): StateEntity | undefined {
    return this.#entities.get(compositeKey([type, collection, id]));
  }

  /** One collection's entities in state order. */
  inCollection(type: string, collection: string): readonly StateEntity[] {
    return this.#collections.get(compositeKey([type, collection])) ?? [];
  }

  /** The collections holding entities of one type, in state order of their first entity. */
  collectionsOf(type: string): readonly string[] {
    return this.#typeCollections.get(type) ?? [];
  }

  document(tool: string): HeldDocument | undefined {
    return this.#documents.get(tool);
  }

  snapshot(): StateSnapshot {
    return this.#snapshotOf(this.#content.entities, this.#content.documents);
  }

  /** What `data/get` writes for the current state, in UTF-8 bytes. */
  byteLength(): number {
    return this.#bytes;
  }

  #snapshotOf(
    entities: readonly StateEntity[],
    documents: readonly HeldDocument[],
  ): StateSnapshot {
    return {
      rea_state: {
        version: 1,
        state_evidence_id: this.state.evidenceId,
        types: this.state.types,
        entities,
        documents,
      },
    };
  }

  /** What `data/get` writes for some content, summed item by item so the whole state is never one string. */
  #contentBytes(content: StateContent): number {
    return (
      this.#frameBytes +
      itemsBytes(content.entities) +
      itemsBytes(content.documents)
    );
  }

  /** Build every index before assigning any, so a reader never sees half a state. */
  #install(content: StateContent, bytes: number): void {
    const entities = new Map<string, StateEntity>();
    const collections = new Map<string, StateEntity[]>();
    const typeCollections = new Map<string, string[]>();
    for (const entity of content.entities) {
      entities.set(
        compositeKey([entity.type, entity.collection, entity.id]),
        entity,
      );
      const key = compositeKey([entity.type, entity.collection]);
      const members = collections.get(key);
      if (members !== undefined) {
        members.push(entity);
        continue;
      }
      collections.set(key, [entity]);
      const named = typeCollections.get(entity.type);
      if (named === undefined)
        typeCollections.set(entity.type, [entity.collection]);
      else named.push(entity.collection);
    }
    this.#entities = entities;
    this.#collections = collections;
    this.#typeCollections = typeCollections;
    this.#documents = new Map(
      content.documents.map((document) => [document.tool, document]),
    );
    this.#content = content;
    this.#bytes = bytes;
  }
}
