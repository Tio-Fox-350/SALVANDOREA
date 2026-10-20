import { fromJsonSchema } from "@modelcontextprotocol/server";
import { z } from "zod";
import { isJsonLike } from "../../domain/analysisView/EnvironmentManifestAccumulator.js";
import {
  mediaTypeEssence,
  readRecordedRequestLine,
} from "../../domain/analysisView/webNetworkRouteTemplates.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { parseExactJson } from "../../domain/exactJsonNumber.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { WebNetworkCaptureRecord } from "../../domain/webNetworkCapture.js";
import {
  compareAnswers,
  DIFFERENCE_CATEGORIES,
  STEP_DIFFERENCE_LIMIT,
  type Answer,
  type Difference,
  type DifferenceCategory,
  type Normalised,
} from "./environmentCompareDiff.js";
import {
  environmentArguments,
  IdMap,
  learnIds,
  translatePath,
} from "./environmentCompareIds.js";
import {
  collectionScope,
  matchProbeRequest,
  parameterScopes,
  type ProbeRequest,
  type ProbeToolCall,
} from "./environmentCompareMatch.js";
import {
  inputError,
  parseCaptureEvidence,
  recordedExchange,
  replayedBody,
  type EnvironmentSource,
  type ReplayedBody,
} from "./environmentSource.js";
import type { ReplayArguments, ReplayResult } from "./environmentReplay.js";
import { prepareServedState, servedCatalog } from "./environmentState.js";
import type { StateAnswer } from "./environmentStateAnswer.js";
import { EnvironmentStateStore } from "./environmentStateStore.js";
import {
  environmentToolAnswer,
  type EnvironmentToolAnswer,
} from "./environmentToolAnswer.js";
import type { EnvironmentToolDefinition } from "./environmentTools.js";

/** One probe capture file: its label for the report and its parsed JSON. */
export interface CompareProbeInput {
  readonly label: string;
  readonly value: unknown;
}

/** One probe request, how the environment answered it, and how that differs from the application. */
export interface CompareStep {
  readonly ordinal: number;
  readonly method: string;
  readonly path: string;
  readonly tool: string | null;
  readonly live_status: number | null;
  readonly env_status: number | null;
  readonly equal: boolean;
  /** Equal but for item order, which an application that returns sets in no fixed order cannot reproduce either. */
  readonly equal_ignoring_order: boolean;
  readonly categories: DifferenceCategory[];
  readonly differences: Difference[];
  readonly ignored_query: string[];
}

export interface CompareProbeReport {
  readonly label: string;
  readonly evidence_id: string;
  readonly steps: number;
  readonly equal: number;
  readonly ids_mapped: number;
  readonly id_conflicts: number;
  readonly normalised: Normalised;
  readonly results: CompareStep[];
}

export interface CompareReport {
  readonly status: "complete";
  readonly environment: {
    readonly name: string;
    readonly manifest_evidence_id: string;
    readonly evidence_id: string;
    readonly state: "served" | "replay-only";
  };
  readonly summary: {
    readonly probes: number;
    readonly steps: number;
    readonly equal: number;
    readonly agreement: number | null;
    readonly agreement_ignoring_order: number | null;
    readonly categories: Record<DifferenceCategory, number>;
    readonly normalised: Normalised;
  };
  readonly tools: { tool: string; steps: number; equal: number }[];
  readonly probes: CompareProbeReport[];
}

const startedSchema = z.object({ startedDateTime: z.string() });
const postDataSchema = z.object({
  request: z.object({
    postData: z.object({ mimeType: z.string(), text: z.string() }),
  }),
});

const startedMs = (record: WebNetworkCaptureRecord): number => {
  const started = startedSchema.safeParse(record.reported);
  const ms = started.success ? Date.parse(started.data.startedDateTime) : NaN;
  return Number.isFinite(ms) ? ms : 0;
};

/** The JSON a request body holds, its text when it is not JSON, or undefined without one. */
const requestBody = (
  record: WebNetworkCaptureRecord,
): JsonValue | undefined => {
  const parsed = postDataSchema.safeParse(record.reported);
  if (!parsed.success) return undefined;
  const { mimeType, text } = parsed.data.request.postData;
  return isJsonLike(mediaTypeEssence(mimeType))
    ? (parseExactJson(text) ?? text)
    : text;
};

/** An answer's body with empty text as no body, which both sides spell differently: a recording of nothing replays as "". */
const bodyOf = (body: JsonValue): JsonValue => (body === "" ? null : body);

/** The application's body as an environment answer carries it: JSON, text, or null when there is none or it is empty. */
const liveBody = (body: ReplayedBody): JsonValue => {
  if (body.kind === "json") return body.value;
  if (body.kind === "none") return null;
  if (body.kind === "base64") return body.encoded;
  return bodyOf(body.text);
};

/** A body over the replay limit, text or bytes: only a prefix is known, so only the status compares. */
export const isCut = (body: ReplayedBody): boolean =>
  body.kind === "cut" || (body.kind === "base64" && !body.whole);

/** The probe's requests in the order they were made, each with the application's answer. */
const probeRequests = (
  records: readonly WebNetworkCaptureRecord[],
): { ordinal: number; request: ProbeRequest; live: Answer }[] =>
  [...records]
    .sort(
      (left, right) =>
        startedMs(left) - startedMs(right) || left.ordinal - right.ordinal,
    )
    .flatMap((record) => {
      const line = readRecordedRequestLine(record.reported, true, () => true);
      const exchange = recordedExchange(record);
      if (line === null || line.kind !== "line" || exchange === undefined)
        return [];
      const body = replayedBody(exchange);
      return [
        {
          ordinal: record.ordinal,
          request: {
            method: line.method,
            path: exchange.path,
            query: exchange.query,
            body: requestBody(record),
          },
          live: {
            status: exchange.status,
            body: liveBody(body),
            cut: isCut(body),
          },
        },
      ];
    });

const NORMALISED_KEYS = ["ids", "clocks", "generated", "large_bodies"] as const;
const emptyNormalised = (): Normalised => ({
  ids: 0,
  clocks: 0,
  generated: 0,
  large_bodies: 0,
});

const isSuccess = (status: number | null): boolean =>
  status !== null && status >= 200 && status < 300;

/** Whether the environment answered this call itself, from the state or a recording of exactly these arguments, rather than replaying another call's recording. */
const answersCall = (answer: ReplayResult): boolean =>
  answer.replay.exact_match ||
  (answer as Partial<StateAnswer>).state?.source === "state";

/** A served tool's input check: the first problem with a call's arguments, or undefined. */
type InputCheck = (args: ReplayArguments) => string | undefined;

/** The input schema check the MCP server applies before a served tool answers, so a call it refuses is not compared as answered. */
const inputCheck = (definition: EnvironmentToolDefinition): InputCheck => {
  const schema = fromJsonSchema<ReplayArguments>(definition.inputSchema)[
    "~standard"
  ];
  return (args) => {
    const checked = schema.validate(args);
    return checked instanceof Promise
      ? undefined
      : checked.issues?.[0]?.message;
  };
};

interface ProbeRun {
  readonly answer: EnvironmentToolAnswer;
  readonly store: EnvironmentStateStore | undefined;
  /** The tools the environment offers, by name, with their input checks. */
  readonly served: ReadonlyMap<string, InputCheck>;
  readonly map: IdMap;
  readonly normalised: Normalised;
}

const heldIds = (
  store: EnvironmentStateStore | undefined,
): ReadonlySet<string> =>
  new Set(
    store?.snapshot().rea_state.entities.map((entity) => entity.id) ?? [],
  );

const stepOf = (
  base: Pick<CompareStep, "ordinal" | "method" | "path" | "live_status">,
  call: ProbeToolCall | undefined,
  outcome: { env_status: number | null; differences: Difference[] },
): CompareStep => {
  const categories = [...new Set(outcome.differences.map((d) => d.category))];
  return {
    ...base,
    tool: call?.tool.name ?? null,
    env_status: outcome.env_status,
    equal: outcome.differences.length === 0,
    equal_ignoring_order: outcome.differences.every(
      (difference) => difference.category === "order",
    ),
    categories,
    differences: outcome.differences.slice(0, STEP_DIFFERENCE_LIMIT),
    ignored_query: [...(call?.ignoredQuery ?? [])],
  };
};

/** Answer one probe request as the environment would and compare it with the application's answer. */
const compareStep = (
  run: ProbeRun,
  manifest: EnvironmentSource["manifest"],
  probe: { ordinal: number; request: ProbeRequest; live: Answer },
): CompareStep => {
  const { request, live } = probe;
  const base = {
    ordinal: probe.ordinal,
    method: request.method,
    path: request.path,
    live_status: live.status,
  };
  // Matched in the environment's terms, so a tool whose path holds a seeded id literally still matches; each path
  // parameter translates by the collection it names, where the request already fits a tool.
  const fitted = matchProbeRequest(manifest, request);
  const scopes =
    fitted === undefined ? undefined : parameterScopes(fitted.tool);
  const call = matchProbeRequest(manifest, {
    ...request,
    path: translatePath(request.path, run.map, (index) => scopes?.get(index)),
  });
  if (call === undefined)
    return stepOf(base, call, {
      env_status: null,
      differences: [{ category: "no-tool", pointer: "" }],
    });
  const check = run.served.get(call.tool.name);
  if (check === undefined)
    return stepOf(base, call, {
      env_status: null,
      differences: [{ category: "not-served", pointer: "" }],
    });
  const held = heldIds(run.store);
  const unknownPath = call.pathArguments.some((name) => {
    const value = call.args[name];
    return (
      typeof value === "string" && !run.map.hasEnv(value) && !held.has(value)
    );
  });
  const refusedWith = (message: string): CompareStep =>
    stepOf(base, call, {
      env_status: null,
      differences: [
        { category: "refused", pointer: "", env: message.slice(0, 200) },
      ],
    });
  const args = environmentArguments(call, run.map);
  const problem = check(args);
  if (problem !== undefined)
    return refusedWith(`Invalid arguments: ${problem}`);
  const answered = run.answer(call.tool, args);
  if (!answered.ok) return refusedWith(answered.error.message);
  const env: Answer = {
    status: answered.value.status,
    body: bodyOf(answered.value.body),
  };
  // Another call's recording holds other entities, whose ids would map wrongly and, the first pairing winning, for good.
  if (answersCall(answered.value))
    learnIds(live.body, env.body, run.map, {
      heldIds: heldIds(run.store),
      scope: collectionScope(call.tool),
    });
  const compared = compareAnswers(live, env, run.map);
  for (const key of NORMALISED_KEYS)
    run.normalised[key] += compared.normalised[key];
  const differences = [...compared.differences];
  if (unknownPath && isSuccess(live.status) && !isSuccess(env.status))
    differences.unshift({ category: "unmapped-id", pointer: "" });
  return stepOf(base, call, { env_status: env.status, differences });
};

const probeReport = (
  label: string,
  evidenceId: string,
  run: ProbeRun,
  results: CompareStep[],
): CompareProbeReport => ({
  label,
  evidence_id: evidenceId,
  steps: results.length,
  equal: results.filter((step) => step.equal).length,
  ids_mapped: run.map.size,
  id_conflicts: run.map.conflicts,
  normalised: run.normalised,
  results,
});

const summaryOf = (
  probes: readonly CompareProbeReport[],
): CompareReport["summary"] => {
  const steps = probes.flatMap((probe) => probe.results);
  const categories = Object.fromEntries(
    DIFFERENCE_CATEGORIES.map((category) => [category, 0]),
  ) as Record<DifferenceCategory, number>;
  for (const step of steps)
    for (const category of step.categories) categories[category] += 1;
  const equal = steps.filter((step) => step.equal).length;
  const ratio = (count: number): number | null =>
    steps.length === 0
      ? null
      : Math.round((count / steps.length) * 1000) / 1000;
  const normalised = emptyNormalised();
  for (const probe of probes)
    for (const key of NORMALISED_KEYS) normalised[key] += probe.normalised[key];
  return {
    probes: probes.length,
    steps: steps.length,
    equal,
    agreement: ratio(equal),
    agreement_ignoring_order: ratio(
      steps.filter((step) => step.equal_ignoring_order).length,
    ),
    categories,
    normalised,
  };
};

const toolsOf = (
  probes: readonly CompareProbeReport[],
): CompareReport["tools"] => {
  const tools = new Map<
    string,
    { tool: string; steps: number; equal: number }
  >();
  for (const step of probes.flatMap((probe) => probe.results)) {
    if (step.tool === null) continue;
    const entry = tools.get(step.tool) ?? {
      tool: step.tool,
      steps: 0,
      equal: 0,
    };
    entry.steps += 1;
    if (step.equal) entry.equal += 1;
    tools.set(step.tool, entry);
  }
  return [...tools.values()].sort(
    (left, right) =>
      left.equal / left.steps - right.equal / right.steps ||
      (left.tool < right.tool ? -1 : 1),
  );
};

/** Compare an environment with probe captures of the application: each probe from a reset state, every request answered and compared. */
export const compareEnvironment = (input: {
  readonly source: EnvironmentSource;
  readonly captureValue: unknown;
  readonly probes: readonly CompareProbeInput[];
  readonly operation: string;
}): Result<CompareReport, AnalysisError> => {
  const { source, operation } = input;
  const state = prepareServedState(source, input.captureValue, {
    operation,
  }).state;
  const catalog = servedCatalog(source, state, source.manifest.name, operation);
  if (!catalog.ok) return catalog;
  const served = new Map(
    catalog.value.tools.map((definition) => [
      definition.name,
      inputCheck(definition),
    ]),
  );
  const probes: CompareProbeReport[] = [];
  for (const [index, probe] of input.probes.entries()) {
    // A probe's request bodies are its call arguments, which a replay projection of a browser capture drops.
    const capture = parseCaptureEvidence(operation, probe.value, "manifest");
    if (!capture.ok)
      return err(
        inputError(
          operation,
          [
            {
              path: ["probe", index],
              reason: "invalid_value",
              message: `${probe.label}: ${capture.error.message}`,
            },
          ],
          "A probe file is not capture Evidence.",
        ),
      );
    const store =
      state === undefined ? undefined : new EnvironmentStateStore(state);
    const run: ProbeRun = {
      answer: environmentToolAnswer(source, store),
      store,
      served,
      map: new IdMap(),
      normalised: emptyNormalised(),
    };
    const results = probeRequests(capture.value.records).map((request) =>
      compareStep(run, source.manifest, request),
    );
    probes.push(
      probeReport(probe.label, capture.value.evidenceId, run, results),
    );
  }
  return ok({
    status: "complete",
    environment: {
      name: source.manifest.name,
      manifest_evidence_id: source.manifestEvidenceId,
      evidence_id: source.evidenceId,
      state: state === undefined ? "replay-only" : "served",
    },
    summary: summaryOf(probes),
    tools: toolsOf(probes),
    probes,
  });
};
