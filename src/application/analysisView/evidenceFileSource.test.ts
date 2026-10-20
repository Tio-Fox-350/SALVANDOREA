import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  analysisViewCaptureEvidence,
  analysisViewNativeEvidence,
} from "../../../tests/fixtures/analysisView.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { createEvidenceBundle } from "../../domain/evidenceBundle.js";
import {
  estimateJsonValueBytes,
  readEvidenceFileSource,
  requireAuthenticationHeadroom,
} from "./evidenceFileSource.js";

describe("evidence-file source", () => {
  it("estimates parsed JSON at no less than its UTF-16 text", () => {
    const text = "x".repeat(1000);
    expect(estimateJsonValueBytes(text)).toBeGreaterThanOrEqual(2000);
    expect(
      estimateJsonValueBytes({ outer: [text, { inner: text }] }),
    ).toBeGreaterThan(2 * estimateJsonValueBytes(text));
  });

  it("refuses authentication when live heap headroom cannot hold its copies", () => {
    const value = { normalized_result: "y".repeat(10_000) };
    expect(
      requireAuthenticationHeadroom(value, "/tmp/capture.json", 1024),
    ).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisResourceConstraintError",
        resource: "memory",
        reportedLimits: {
          input_path: "/tmp/capture.json",
          available_heap_bytes: 1024,
        },
      },
    });
    expect(
      requireAuthenticationHeadroom(value, "/tmp/capture.json", 1 << 30),
    ).toEqual({ ok: true, value: undefined });
  });

  it("refuses a cancelled request before reading and reads within the caller's resource scope", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await readEvidenceFileSource("/nonexistent/capture.json", {
        signal: controller.signal,
      }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
    const path = join(
      await createTestTempDirectory("rea-evidence-file-source-"),
      "capture.json",
    );
    const parent = analysisViewCaptureEvidence();
    await writeFile(path, JSON.stringify(parent));
    const resources = new ArtifactResourceScope();
    const read = await readEvidenceFileSource(path, { resources });
    await resources.close();
    if (!read.ok) throw read.error;
    expect(read.value).toEqual(JSON.parse(JSON.stringify(parent)));
  });

  it("projects the selected or only record of an Evidence bundle file", async () => {
    const root = await createTestTempDirectory("rea-evidence-bundle-source-");
    const native = analysisViewNativeEvidence();
    const capture = analysisViewCaptureEvidence();
    const single = join(root, "single.json");
    await writeFile(single, JSON.stringify(createEvidenceBundle([native])));
    const only = await readEvidenceFileSource(single);
    if (!only.ok) throw only.error;
    expect(only.value.evidence_id).toBe(native.evidence_id);

    const several = join(root, "several.json");
    await writeFile(
      several,
      JSON.stringify(createEvidenceBundle([native, capture])),
    );
    const selected = await readEvidenceFileSource(
      several,
      {},
      capture.evidence_id,
    );
    if (!selected.ok) throw selected.error;
    expect(selected.value.evidence_id).toBe(capture.evidence_id);

    // Ambiguity and a missing selection are input errors that name the records held.
    const ambiguous = await readEvidenceFileSource(several);
    expect(ambiguous).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        issues: [{ path: ["source", "evidence_id"], reason: "invalid_value" }],
      },
    });
    if (ambiguous.ok) throw new Error("Expected an ambiguous bundle");
    expect(ambiguous.error.userMessage).toContain(native.evidence_id);
    expect(ambiguous.error.userMessage).toContain("analyze_function");
    const absent = "ev_" + "f".repeat(64);
    const missing = await readEvidenceFileSource(several, {}, absent);
    expect(missing).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        userMessage: expect.stringContaining(absent),
      },
    });

    // A bundle-shaped file that is not a valid bundle is a wrong-kind file, not Evidence.
    const invalid = join(root, "invalid.json");
    await writeFile(invalid, JSON.stringify({ records: [{ hello: 1 }] }));
    expect(await readEvidenceFileSource(invalid)).toMatchObject({
      ok: false,
      error: {
        _tag: "EvidenceFileError",
        reason: "wrong-kind",
        userMessage: expect.stringContaining("Evidence bundle"),
      },
    });
  });
});
