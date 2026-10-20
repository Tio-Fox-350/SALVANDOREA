import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import pino from "pino";
import { expect, it, onTestFinished, vi } from "vitest";

import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { registerEnhancedTools } from "../../../src/server/registerEnhancedTools.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { withAdmittedAnalysis } from "../../../src/server/analysisAdmission.js";
import type { AnalysisOperationPort } from "../../../src/application/AnalysisProvider.js";
import { parseEvidence, type Evidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { functionDossierSchema } from "../../../src/domain/hopperValues.js";
import { ghidraFunctionDossier } from "../../../src/domain/ghidraValues.fixture.js";

const dossier = functionDossierSchema.parse(ghidraFunctionDossier());

// A fixed provider that returns the fixture dossier for any analyze_function call.
const connect = async (retain = true) => {
  const ledger = new Map<string, Evidence>();
  const record = (evidence: Evidence) => {
    ledger.set(evidence.evidence_id, evidence);
    return ok("added" as const);
  };
  const lookup = (id: string) => ledger.get(id);
  const execute = vi.fn(
    async (_operation: string, _parameters: Record<string, unknown>) =>
      ok({
        result: dossier,
        rawResult: null,
        provider: { id: "ghidra", name: "Ghidra", version: "12.1.4" },
        limitations: [],
        locations: [],
        subject: {
          path: "/fixtures/native.exe",
          format: "pe" as const,
          sha256: "a".repeat(64),
        },
      }),
  );
  const analysis = { execute } as unknown as AnalysisOperationPort;
  const delivery = createToolResultDelivery(4 * 1024 * 1024);
  const server = new EvidenceMcpServer(
    { name: "fn-detail", version: "1" },
    {},
    retain ? record : undefined,
    delivery,
  );
  registerEnhancedTools(server, {
    withAdmittedAnalysis: withAdmittedAnalysis({ kind: "fixed", analysis }),
    logger: pino({ enabled: false }),
    activeTarget: () => undefined,
    analysisProfile: undefined,
    recordEvidence: retain ? record : undefined,
    evidenceById: retain ? lookup : undefined,
    recordUnknown: undefined,
    allowsSnapshotReplay: undefined,
    recordWorkflowSnapshot: undefined,
  });
  const client = new Client({ name: "fn-detail-client", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, ledger, execute };
};

it("defaults to a retained summary and strips delivery detail before the provider", async () => {
  const { client, ledger, execute } = await connect();
  const reply = await client.callTool({
    name: "analyze_function",
    arguments: { procedure: "main" },
  });
  const evidence = parseEvidence(reply.structuredContent);
  expect(evidence.normalized_result).toMatchObject({
    kind: "summary",
    parent_operation: "analyze_function",
  });
  const parentId = (
    evidence.normalized_result as { parent_evidence_id: string }
  ).parent_evidence_id;
  // The complete dossier is retained in-session so the summary's parent can be paged.
  expect(ledger.has(parentId)).toBe(true);
  // Delivery detail never crosses into the provider request.
  const providerParameters = execute.mock.calls[0]?.[1] ?? {};
  expect(providerParameters).not.toHaveProperty("detail");
  expect(providerParameters).toMatchObject({ procedure: "main" });
});

it("returns the complete dossier inline when detail is complete", async () => {
  const { client } = await connect();
  const reply = await client.callTool({
    name: "analyze_function",
    arguments: { procedure: "main", detail: "complete" },
  });
  const evidence = parseEvidence(reply.structuredContent);
  expect(evidence.normalized_result).toMatchObject({
    pseudocode: dossier.pseudocode,
  });
  expect(evidence.normalized_result).toHaveProperty("native_value_flow");
});

it("rejects a summary request before analysis when the server retains no Evidence", async () => {
  const { client, execute } = await connect(false);
  const reply = await client.callTool({
    name: "analyze_function",
    arguments: { procedure: "main" },
  });
  expect(reply.isError).toBe(true);
  expect(execute).not.toHaveBeenCalled();
});
