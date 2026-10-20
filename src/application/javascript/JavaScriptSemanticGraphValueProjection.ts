import {
  semanticContainer,
  semanticPropertyPointer,
} from "../../domain/javascript/javascriptSemanticSlots.js";
import { digestCanonicalValue } from "../../domain/canonicalDigest.js";
import type { JavaScriptSemanticBinding } from "../../domain/javascript/javascriptSemanticIr.js";
import type {
  JavaScriptSemanticProperty,
  JavaScriptSemanticValue,
} from "../../domain/javascript/javascriptSemanticValueTypes.js";
import {
  retainSemanticGraphNode,
  addSemanticGraphRelation,
  addSemanticGraphUnknown,
} from "./JavaScriptSemanticGraphConstruction.js";
import type { SemanticFlowProjectionContext } from "./JavaScriptSemanticGraphFlowProjection.js";
import {
  observedSemanticEvidence,
  unknownSemanticEvidence,
} from "./JavaScriptSemanticGraphEvidence.js";

/** Project bounded literal values and object slots for exact query seeds. */
export const projectSemanticValues = (
  context: SemanticFlowProjectionContext,
): void => {
  for (const binding of context.ir.bindings) {
    const bindingNode = context.bindingNodes.get(binding.bindingId);
    if (bindingNode === undefined) continue;
    projectValue({
      context,
      binding,
      value: binding.value,
      target: bindingNode,
      path: [],
    });
  }
  // A return through an identifier already reaches its value through the
  // resolved binding alias. Any other returned expression, such as a member
  // read, carries its evaluated primitive on the return site itself.
  for (const callable of context.ir.callables)
    for (const site of callable.returnSites) {
      const returnNode = context.returnSiteNodes.get(site.returnSiteId);
      if (returnNode === undefined || site.identityReferenceLocation !== null)
        continue;
      const primitives =
        site.value.status === "literal"
          ? [site.value.value]
          : site.value.status === "union"
            ? site.value.values
            : [];
      for (const primitive of primitives)
        addSemanticGraphRelation(context.state, {
          source: addLiteralNode(context, {
            key: `return:${site.returnSiteId}`,
            location: site.location,
            functionNodeId: returnNode.function_node_id,
            value: primitive,
          }),
          target: returnNode,
          relation: "defines",
          resolution:
            site.value.status === "literal" ? "resolved" : "candidate",
        });
    }
};

interface ValueProjectionInput {
  readonly context: SemanticFlowProjectionContext;
  readonly binding: JavaScriptSemanticBinding;
  readonly value: JavaScriptSemanticValue;
  readonly target: ReturnType<typeof semanticPropertySlot>;
  readonly path: readonly string[];
}

const projectValue = (input: ValueProjectionInput): void => {
  const { context, binding, value, target, path } = input;
  const role =
    path.length === 0 ? "binding" : `property:${semanticPropertyPointer(path)}`;
  if (target === null) return;
  if (value.status === "literal") {
    const literal = addLiteralNode(
      context,
      bindingLiteral(context, binding, value.value, role),
    );
    addSemanticGraphRelation(context.state, {
      source: literal,
      target,
      relation: "defines",
      resolution: "resolved",
    });
  } else if (value.status === "union")
    for (const primitive of value.values) {
      const literal = addLiteralNode(
        context,
        bindingLiteral(context, binding, primitive, role),
      );
      addSemanticGraphRelation(context.state, {
        source: literal,
        target,
        relation: "defines",
        resolution: "candidate",
      });
    }
  else if (value.status === "object" || value.status === "array") {
    const container = semanticContainer(value);
    for (const property of container.slots) {
      const propertyPath = [...path, property.name];
      const slot = semanticPropertySlot(
        context,
        binding.bindingId,
        propertyPath,
        property,
      );
      if (property.presence === "absent") continue;
      addSemanticGraphRelation(context.state, {
        source: target,
        target: slot,
        relation: "writes-property",
        resolution: property.presence === "present" ? "resolved" : "candidate",
      });
      if (property.presence === "present")
        projectValue({
          context,
          binding,
          value: property.value,
          target: slot,
          path: propertyPath,
        });
    }
    if (container.coverage.status === "partial")
      addSemanticGraphUnknown(context.state, {
        node_id: target.node_id,
        family: "object-flow",
        relation_kinds: ["writes-property"],
        reason: "ambiguous-target",
        detail: `Initializer container has unknown ${
          value.status === "object" ? "properties" : "items"
        }${container.coverage.omitted === null ? " with an unknown omitted count" : `; ${container.coverage.omitted} omitted`}.`,
        candidate_node_ids: [target.node_id],
        evidence: unknownSemanticEvidence(
          context.file,
          binding.definitions[0]?.location ?? null,
        ),
      });
  } else if (
    value.status === "unknown" ||
    value.status === "ambiguous" ||
    value.status === "cycle"
  ) {
    const location = binding.definitions[0]?.location ?? null;
    const evidence = observedSemanticEvidence(context.file, location);
    addSemanticGraphUnknown(context.state, {
      node_id: target.node_id,
      family: "data-flow",
      relation_kinds: ["defines"],
      reason:
        value.resourceLimit === undefined ? "unknown-value" : "resource-limit",
      detail: `${value.reason} Unknown value at ${role}.`,
      candidate_node_ids: [target.node_id],
      evidence: {
        ...evidence,
        authority: "unknown",
        state: "unknown",
        confidence: "unknown",
        limitations: [value.reason],
      },
    });
  }
};

interface LiteralOwner {
  /** Stable owner and role, such as a binding slot or a return site. */
  readonly key: string;
  readonly location:
    | JavaScriptSemanticBinding["definitions"][number]["location"]
    | null;
  readonly functionNodeId: string | null;
  readonly value: string | number | boolean | null;
}

const bindingLiteral = (
  context: SemanticFlowProjectionContext,
  binding: JavaScriptSemanticBinding,
  value: string | number | boolean | null,
  role: string,
): LiteralOwner => ({
  key: `${binding.bindingId}:${role}`,
  location: binding.definitions[0]?.location ?? null,
  functionNodeId:
    context.bindingNodes.get(binding.bindingId)?.function_node_id ?? null,
  value,
});

const addLiteralNode = (
  context: SemanticFlowProjectionContext,
  { key, location, functionNodeId, value }: LiteralOwner,
) => {
  const encodedValue = JSON.stringify(value);
  const valueDigest = `value-sha256:${digestCanonicalValue(value, "Semantic literal")}`;
  const valueKey =
    encodedValue.length <= valueDigest.length ? encodedValue : valueDigest;
  const stringLabel = "string literal";
  return retainSemanticGraphNode(context.state, context.file, {
    kind: "literal",
    // Identity needs an exact value commitment, not another payload copy.
    // Keep the complete literal in properties for queries and Evidence export.
    roleKey: `literal:${key}:${valueKey}`,
    location,
    label:
      typeof value === "string" && encodedValue.length > stringLabel.length
        ? stringLabel
        : encodedValue,
    functionNodeId,
    properties: { value },
  });
};

/** Create one canonical slot for a root binding and exact static property path. */
export const semanticPropertySlot = (
  context: SemanticFlowProjectionContext,
  objectBindingId: string,
  path: readonly string[],
  fact: JavaScriptSemanticProperty,
) =>
  retainSemanticGraphNode(context.state, context.file, {
    kind: "property-slot",
    roleKey: `property:${JSON.stringify([objectBindingId, path])}`,
    location: null,
    label: fact.name,
    functionNodeId:
      context.bindingNodes.get(objectBindingId)?.function_node_id ?? null,
    properties: {
      name: fact.name,
      property_path: [...path],
      property_pointer: semanticPropertyPointer(path),
      object_binding_id: objectBindingId,
      presence: fact.presence,
      value_status: fact.value.status,
      value_coverage: semanticContainer(fact.value)?.coverage ?? null,
    },
  });
