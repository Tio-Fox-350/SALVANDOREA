import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../../fixtures/artifactInventory.js";
import { readJavaScriptArtifactFiles } from "../../../support/javascriptApplicationScope.js";
import { createJavaScriptArtifactReader } from "../../../../src/artifacts/javascript/JavaScriptArtifactReader.js";
import { analyzeJavaScriptArtifactFiles } from "../../../../src/application/javascript/JavaScriptArtifactAnalysis.js";
import { buildJavaScriptArtifactGraph } from "../../../../src/application/javascript/JavaScriptArtifactGraphBuilder.js";

const sources = [
  {
    file: "callback.js",
    endpoint: "wss://example.test/pair",
    source:
      'const invoke=run=>run();invoke(()=>{});const Socket=globalThis.WebSocket;invoke(()=>new Socket("wss://example.test/pair"));',
  },
  {
    file: "apply.js",
    endpoint: "wss://example.test/apply",
    source:
      'const connect=()=>new Socket("wss://example.test/apply");try{connect.apply(null,1)}catch{}const Socket=globalThis.WebSocket;',
  },
  {
    file: "options.mjs",
    endpoint: "wss://example.test/options",
    source:
      'export {};const{WebSocket:Socket}=await import("ws",{with(){}});new Socket("wss://example.test/options");',
  },
  {
    file: "disposer.js",
    endpoint: "wss://example.test/disposer",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/disposer")})()){await using r={set[Symbol.asyncDispose](value){},[Symbol.dispose](){}}}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "helper-read.js",
    source:
      'const connect=()=>new Socket("wss://example.test/helper-read");connect.call(null,connect.call=()=>{});const Socket=globalThis.WebSocket;',
  },
] as const;

it("retains reviewed callback and descriptor endpoints with source provenance", async () => {
  const root = await createTestTempDirectory("rea-reviewed-calls-");
  for (const fixture of sources)
    await writeFile(join(root, fixture.file), fixture.source);
  const snapshot = await scanCanonicalArtifactInventory(root, {});
  const reader = createJavaScriptArtifactReader(root, "directory");
  try {
    const files = await readJavaScriptArtifactFiles(reader, snapshot);
    const graph = buildJavaScriptArtifactGraph(
      snapshot,
      files,
      analyzeJavaScriptArtifactFiles(files),
    );
    const observations = graph.nodes
      .filter(({ kind }) => kind === "endpoint")
      .flatMap(({ observations }) => observations);
    const expected = sources.filter((fixture) => "endpoint" in fixture);
    expect(observations).toHaveLength(expected.length);
    for (const fixture of expected)
      expect(observations).toContainEqual(
        expect.objectContaining({
          properties: expect.objectContaining({ value: fixture.endpoint }),
          evidence: expect.objectContaining({
            location: {
              available: true,
              value: expect.objectContaining({ source: fixture.file }),
            },
          }),
        }),
      );
  } finally {
    await reader.close();
    await rm(root, { recursive: true, force: true });
  }
});
