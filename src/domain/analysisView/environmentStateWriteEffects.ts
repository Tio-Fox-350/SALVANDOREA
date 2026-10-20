import type { JsonValue } from "../jsonValue.js";
import {
  collectionPathOf,
  decodedSegment,
  isObject,
  isStateWrite,
  lastSegmentValue,
  locateItem,
  at,
  same,
  segmentsOf,
  type JsonObject,
  type StateDocument,
  type StateRecordFacts,
  type StateToolFacts,
  type StateView,
} from "./environmentStateRules.js";
import {
  documentBodyProblem,
  updatedEntity,
  updatedFields,
  writtenDocument,
} from "./environmentStateWriteApply.js";
import {
  collectionTarget,
  documentTarget,
  entityTarget,
  type SimulatedState,
} from "./environmentStateWriteChecks.js";
import {
  documentPointerOf,
  explainUpdate,
  responseShapeOf,
} from "./environmentStateWriteExplain.js";
import {
  laterObservation,
  type Observed,
} from "./environmentStateWriteObserve.js";
import { integerOf, slugOf } from "./environmentStateWriteValues.js";
import {
  pathValuesOf,
  type FieldRule,
  type InsertRule,
  type StateWritePlan,
  type WriteCall,
  type WriteReason,
} from "./environmentStateWriteRules.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** A plan under construction and the evidence the walk gathers for its verdict. */
export interface WriteDraft {
  readonly plan: Mutable<StateWritePlan>;
  /** The exemplar's observed entity, whose unruled fields a create keeps. */
  observed: JsonObject | undefined;
  candidates: InsertRule[];
  readonly confirmed: number[];
  contradictedBy: number | undefined;
  sideEffect: boolean;
  calls: number;
  /** The scalar values each modelled update call showed and sent, which later rules must reproduce. */
  readonly updates: {
    readonly shown: ReadonlyMap<string, JsonValue>;
    readonly sent: ReadonlyMap<string, JsonValue>;
  }[];
}

/** Response bodies, request bodies and budget the effects read. */
export interface WriteIo {
  readonly withBody: <T>(
    ordinal: number,
    use: (body: JsonValue | undefined) => T,
  ) => T;
  readonly requestBody: (ordinal: number) => JsonValue | undefined;
  readonly emptyResponse: (ordinal: number) => boolean;
  readonly retain: (bytes: number) => void;
}

/** What applying a recorded write reads besides the draft and the call. */
export interface EffectContext {
  readonly state: SimulatedState;
  readonly io: WriteIo;
  readonly records: readonly StateRecordFacts[];
  readonly timed: boolean;
  readonly viewOf: (ordinal: number) => StateView | undefined;
  readonly idField: (type: string) => string;
  /** Mark a later read as a create's or update's observation, so it does not check that write. */
  readonly observed: (ordinal: number) => void;
  /** Whether an unmodelled write may have changed the entity since the state last saw it. */
  readonly unknown: (type: string, collection: string, id: string) => boolean;
  /** A document as the initial state holds it: its path, and the value serving also reads member types from. */
  readonly initialDocument: (tool: string) => StateDocument | undefined;
}

/** One recorded write: the record, its timeline index, its tool, and whether its plan only takes the recorded outcome. */
export interface WriteStep {
  readonly record: StateRecordFacts;
  readonly index: number;
  readonly tool: StateToolFacts;
  /** Set once the plan has a reason: the write only brings the state to its recorded outcome. */
  readonly observeOnly: boolean;
}

/**
 * What applying a recorded write did: the modelled effect (attributable to the tool), the
 * recorded outcome when the model does not explain it (not attributable), or nothing known.
 */
export type EffectResult =
  | {
      readonly kind: "applied";
      readonly targets: readonly string[];
      readonly entity?: WrittenEntity;
      /** The fields an update wrote; a create writes the whole entity. */
      readonly fields?: readonly string[];
      readonly inserted?: string;
    }
  | {
      readonly kind: "observed";
      readonly targets: readonly string[];
      readonly entity?: WrittenEntity;
    }
  | { readonly kind: "unknown" };

/** The entity a write changed, by type, collection and id. */
export interface WrittenEntity {
  readonly type: string;
  readonly collection: string;
  readonly id: string;
}

export const UNKNOWN: EffectResult = { kind: "unknown" };

export const built = (draft: WriteDraft): boolean =>
  draft.plan.exemplar_ordinal !== null;

/** Give an unbuilt plan its reason; a built plan keeps its model. */
export const fail = (
  draft: WriteDraft,
  step: WriteStep,
  reason: WriteReason,
): void => {
  if (!built(draft) && !step.observeOnly) draft.plan.reason = reason;
};

/** A recorded call the built model does not explain disqualifies the plan. */
export const refuse = (
  draft: WriteDraft,
  step: WriteStep,
  reason: WriteReason,
): void => {
  if (!step.observeOnly) draft.plan.reason = reason;
};

export const requestObject = (
  context: EffectContext,
  record: StateRecordFacts,
): JsonObject | undefined => {
  const body = context.io.requestBody(record.ordinal);
  return isObject(body) ? body : undefined;
};

export const callOf = (
  step: WriteStep,
  body: JsonObject | undefined,
): WriteCall => ({
  path: step.record.path,
  pathValues:
    pathValuesOf(step.tool.path_template, step.record.path) ?? new Map(),
  body,
});

export const startOf = (
  context: EffectContext,
  step: WriteStep,
): number | undefined => (context.timed ? step.record.start : undefined);

export const searchFrom = (context: EffectContext, step: WriteStep) => ({
  records: context.records,
  from: step.index,
  viewOf: context.viewOf,
  withBody: context.io.withBody,
});

/** The entity an update's response shows, located by its identity, else a later item read of it. */
const updatedObservation = (
  context: EffectContext,
  step: WriteStep,
  target: {
    readonly type: string;
    readonly collection: string;
    readonly idField: string;
    readonly id: string;
  },
): Observed | undefined => {
  const own = context.io.withBody(
    step.record.ordinal,
    (body): Observed | undefined => {
      const located =
        body === undefined ? undefined : locateItem(body, target.id);
      const object =
        located === undefined ? undefined : at(body!, located.pointer);
      return located?.keys.includes(target.idField) === true && isObject(object)
        ? {
            ordinal: step.record.ordinal,
            pointer: located.pointer,
            object,
            id: target.id,
          }
        : undefined;
    },
  );
  if (own !== undefined) return own;
  const later = laterObservation(searchFrom(context, step), {
    ...target,
    held: () => true,
    isWrite: isStateWrite,
  });
  if (later !== undefined) context.observed(later.ordinal);
  return later;
};

/** Add what a later call of an update showed to its plan: members, fixed values and rules not seen before. */
const refineUpdate = (
  plan: WriteDraft["plan"],
  explained: ReturnType<typeof explainUpdate>,
): void => {
  const body = plan.body!;
  const fixed = new Set(body.fixed.map((entry) => entry.member));
  plan.body = {
    ...body,
    accepted: [
      ...body.accepted,
      ...explained.body.accepted.filter(
        (member) => !body.accepted.includes(member),
      ),
    ],
    fixed: [
      ...body.fixed,
      ...explained.body.fixed.filter((entry) => !fixed.has(entry.member)),
    ],
  };
  const ruled = new Set(plan.rules.map((rule) => rule.field));
  plan.rules = [
    ...plan.rules,
    ...explained.rules.filter((rule) => !ruled.has(rule.field)),
  ];
};

/** Whether a rule changes its field on calls that do not send it: serving applies it to every call that could. */
const unsentChange = (rule: FieldRule): boolean =>
  rule.rule === "increment" || rule.rule === "slug";

/** A call's scalar members by name, as much of it as later rules are checked against. */
const scalars = (object: JsonObject): Map<string, JsonValue> =>
  new Map(
    Object.entries(object).filter(
      ([, value]) => value === null || typeof value !== "object",
    ),
  );

/** Whether a rule a later call showed gives an earlier call a value other than the one it showed for a field it did not send. */
const contradictsEarlierCalls = (
  draft: WriteDraft,
  rules: readonly FieldRule[],
): boolean => {
  const ruled = new Set(draft.plan.rules.map((rule) => rule.field));
  return rules.some(
    (rule) =>
      unsentChange(rule) &&
      !ruled.has(rule.field) &&
      draft.updates.some(({ shown, sent }) => {
        // An unruled field an earlier call showed is one it left as it was.
        const value = shown.get(rule.field);
        if (value === undefined) return false;
        if (rule.rule === "increment") return integerOf(value) !== undefined;
        const from = rule.rule === "slug" ? sent.get(rule.from) : undefined;
        return typeof from === "string" && slugOf(from) !== value;
      }),
  );
};

/** Build an update plan from its exemplar, or add what a later call showed. */
const buildUpdate = (
  context: EffectContext,
  draft: WriteDraft,
  step: WriteStep,
  evidence: {
    readonly after: Observed;
    readonly explained: ReturnType<typeof explainUpdate>;
    readonly idField: string;
  },
): void => {
  if (built(draft)) {
    refineUpdate(draft.plan, evidence.explained);
    return;
  }
  const { ordinal } = step.record;
  Object.assign(draft.plan, {
    exemplar_ordinal: ordinal,
    observation: {
      ordinal: evidence.after.ordinal,
      pointer: evidence.after.pointer,
    },
    response: context.io.withBody(ordinal, (response) =>
      responseShapeOf(ordinal, response, context.io.emptyResponse(ordinal), {
        idField: evidence.idField,
        id: evidence.after.id,
      }),
    ),
    body: evidence.explained.body,
    rules: evidence.explained.rules,
  });
  draft.observed = evidence.after.object;
};

/**
 * Apply a recorded update to the held entity, explaining every change it made. An update the
 * model does not explain, or of an entity an unmodelled write may have changed, brings the
 * entity to what it recorded instead and is not attributed to the tool.
 */
export const applyUpdate = (
  context: EffectContext,
  draft: WriteDraft,
  step: WriteStep,
): EffectResult => {
  const type = draft.plan.target!;
  const idField = context.idField(type);
  const collection = collectionPathOf(step.record, true);
  const id = lastSegmentValue(step.record.path);
  const entity = context.state.entity(type, collection, id);
  const after =
    entity === undefined
      ? undefined
      : updatedObservation(context, step, { type, collection, idField, id });
  if (entity === undefined || after === undefined) {
    fail(draft, step, "no-observation");
    return UNKNOWN;
  }
  const targets = [
    entityTarget(type, collection, id),
    collectionTarget(type, collection),
  ];
  const target = { type, collection, id };
  const recorded = (): EffectResult => {
    context.state.put(
      updatedEntity(entity, { ...entity.fields, ...after.object }),
    );
    return { kind: "observed", targets, entity: target };
  };
  const body = requestObject(context, step.record);
  if (step.observeOnly || body === undefined) {
    fail(draft, step, "body-unusable");
    return recorded();
  }
  const unknown = context.unknown(type, collection, id);
  const call = { ...callOf(step, body), body };
  const explained = explainUpdate({
    before: entity.fields,
    after: after.object,
    call,
    method: step.tool.method,
    idField,
    id,
    startMs: startOf(context, step),
  });
  if (explained.unexplained.length > 0 && !unknown) {
    refuse(draft, step, "unexplained-change");
    return recorded();
  }
  // Rules for unsent changes hold for every call, so each call must agree with those of the others.
  if (
    built(draft) &&
    !unknown &&
    contradictsEarlierCalls(draft, explained.rules)
  ) {
    refuse(draft, step, "unexplained-change");
    return recorded();
  }
  buildUpdate(context, draft, step, { after, explained, idField });
  // Serving reads the plan's observation, so the gate does too; generated values are this call's.
  const written = updatedFields(
    draft.plan,
    { before: entity.fields, observed: draft.observed! },
    { ...call, id },
    (rule) => after.object[rule.field] ?? null,
  );
  const disagrees =
    written.ok &&
    draft.plan.rules.some(
      (rule) =>
        unsentChange(rule) &&
        Object.hasOwn(after.object, rule.field) &&
        !same(written.value[rule.field], after.object[rule.field]),
    );
  if (!written.ok || (disagrees && !unknown))
    refuse(draft, step, "unexplained-change");
  if (!written.ok || disagrees || unknown) return recorded();
  const facts = { shown: scalars(after.object), sent: scalars(body) };
  context.io.retain(
    64 + JSON.stringify([...facts.shown, ...facts.sent]).length * 2,
  );
  draft.updates.push(facts);
  context.io.retain(64 + JSON.stringify(written.value).length * 2);
  context.state.put(updatedEntity(entity, written.value));
  // A later read that also shows an unmodelled change checks only the members this call sent.
  const sent = Object.keys(body).filter(
    (member) => member !== draft.plan.body?.identity,
  );
  return { kind: "applied", targets, entity: target, fields: sent };
};

/** Apply a recorded delete: the held entity leaves its collection. */
export const applyDelete = (
  context: EffectContext,
  draft: WriteDraft,
  step: WriteStep,
): EffectResult => {
  const type = draft.plan.target!;
  const collection = collectionPathOf(step.record, true);
  const id = lastSegmentValue(step.record.path);
  const entity = context.state.entity(type, collection, id);
  if (entity === undefined) {
    fail(draft, step, "no-observation");
    return UNKNOWN;
  }
  const { ordinal } = step.record;
  if (!built(draft) && !step.observeOnly)
    Object.assign(draft.plan, {
      exemplar_ordinal: ordinal,
      response: context.io.withBody(ordinal, (body) =>
        responseShapeOf(ordinal, body, context.io.emptyResponse(ordinal), {
          idField: context.idField(type),
          id,
        }),
      ),
    });
  context.state.remove(entity);
  const targets = [
    entityTarget(type, collection, id),
    collectionTarget(type, collection),
  ];
  return {
    kind: step.observeOnly ? "observed" : "applied",
    targets,
    entity: { type, collection, id },
  };
};

/** Whether a write's path names the held document's, a segment verbatim or once percent-decoded, as serving matches a call. */
const namesDocument = (path: string, held: string): boolean => {
  const written = segmentsOf(path);
  const recorded = segmentsOf(held);
  return (
    written.length === recorded.length &&
    recorded.every(
      (segment, index) =>
        segment === written[index] ||
        decodedSegment(segment) === written[index],
    )
  );
};

/** Apply a recorded document write: the body merged into, or replacing, the object holding most of its members. */
export const applyDocument = (
  context: EffectContext,
  draft: WriteDraft,
  step: WriteStep,
): EffectResult => {
  const tool = draft.plan.target!;
  const initial = context.initialDocument(tool);
  // Serving refuses a write at another path, so one here changes no document the state holds.
  if (initial !== undefined && !namesDocument(step.record.path, initial.path))
    return UNKNOWN;
  const value = context.state.document(tool);
  const body = requestObject(context, step.record);
  const pointer =
    value === undefined || body === undefined
      ? undefined
      : documentPointerOf(value, body);
  if (
    step.observeOnly ||
    value === undefined ||
    body === undefined ||
    pointer === undefined
  ) {
    fail(draft, step, body === undefined ? "body-unusable" : "no-observation");
    return UNKNOWN;
  }
  const { ordinal } = step.record;
  if (!built(draft))
    Object.assign(draft.plan, {
      exemplar_ordinal: ordinal,
      observation: { ordinal, pointer },
      merge: step.tool.method === "PUT" ? "replace" : "merge",
      body: {
        accepted: Object.keys(body),
        fixed: [],
        required: [],
        identity: null,
      },
    });
  const call = callOf(step, body);
  // Serving refuses a body its check refuses, so such a call cannot confirm the plan.
  if (
    documentBodyProblem(draft.plan, call, {
      initial: initial?.value,
      current: value,
    }) !== undefined
  ) {
    refuse(draft, step, "unexplained-change");
    return UNKNOWN;
  }
  const written = writtenDocument(draft.plan, value, call);
  if (!written.ok) {
    refuse(draft, step, "no-observation");
    return UNKNOWN;
  }
  draft.plan.response ??= context.io.withBody(ordinal, (response) => ({
    ordinal,
    shape: context.io.emptyResponse(ordinal)
      ? "empty"
      : response !== undefined && same(response, written.value)
        ? "entity"
        : "recorded",
    pointer: null,
  }));
  context.io.retain(64 + JSON.stringify(written.value).length * 2);
  context.state.setDocument(tool, written.value);
  return { kind: "applied", targets: [documentTarget(tool)] };
};
