import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { borlandSehFixture } from "./lib/borland-seh-fixture.mjs";
import { parseEvidence } from "../dist/domain/evidence.js";
import {
  spawnOwnedProviderProcess,
  ProviderProcessSupervisor,
} from "../dist/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../dist/process/ProcessOwnership.js";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";

const exec = promisify(execFile);
const run = createVerifierRun();
assert.ok(
  process.platform === "darwin" || process.platform === "linux",
  "Handler recovery verification requires a POSIX Ghidra host; Windows P0 is observe-only.",
);
const workspace = await mkdtemp(join(tmpdir(), "rea-borland-seh-"));
const runtime = join(workspace, "runtime");
const scripts = join(workspace, "scripts");
const project = join(workspace, "project");
const target = join(workspace, "owned.exe");
const seeds = join(workspace, "seeds.tsv");
const entrypoint = resolve("scripts/rea.mjs");
const bytes = borlandSehFixture();
const sha256 = createHash("sha256").update(bytes).digest("hex");
const environment = {
  ...process.env,
  TMPDIR: runtime,
  REA_LOG_LEVEL: "silent",
  REA_GHIDRA_SEED_FILE: seeds,
};
let verifiedCleanup = false;
const assertDossier = (evidence) => {
  assert.equal(evidence.provider.id, "ghidra");
  assert.equal(evidence.provider.version, "12.1.4");
  assert.equal(evidence.subject.digest.sha256, sha256);
  const dossier = evidence.normalized_result;
  assert.ok(
    dossier.procedure.body.ranges.some(
      ({ start, end }) =>
        BigInt(start) <= 0x401025n && BigInt(end) >= 0x40102an,
    ),
  );
  assert.ok(dossier.callees.some(({ address }) => address === "0x401090"));
  assert.ok(
    dossier.referenced_strings.some(
      ({ source_address, value }) =>
        source_address === "0x401025" && value === "REA_BORLAND_SEH_ERROR_ONLY",
    ),
  );
  assert.ok(
    evidence.limitations.some(
      (text) => text.includes("SEH registration") && text.includes("included"),
    ),
  );
};

try {
  for (const path of [runtime, scripts, project]) await mkdir(path);
  await writeFile(target, bytes);
  await writeFile(
    seeds,
    "0x401080\tfunction\t_HandleAnyException\n0x401090\tfunction\trea_seh_message\n0x4010f0\tfunction\trea_seh_other_string_reference\n",
  );
  // Ghidra compiles each script directory as a separate bundle. Copy the exact
  // producer and probe into one private bundle; do not alter the installation.
  await copyFile(
    "bridge/ghidra/ReaGhidraBorlandSeh.java",
    join(scripts, "ReaGhidraBorlandSeh.java"),
  );
  await copyFile(
    "tests/conformance/ghidra/ReaBorlandSehProbe.java",
    join(scripts, "ReaBorlandSehProbe.java"),
  );
  const launched = await spawnOwnedProviderProcess({
    command: join(process.env.GHIDRA_INSTALL_DIR, "support/analyzeHeadless"),
    arguments: [
      project,
      "BorlandSeh",
      "-import",
      target,
      "-readOnly",
      "-deleteProject",
      "-scriptPath",
      scripts,
      "-postScript",
      "ReaBorlandSehProbe.java",
    ],
    env: environment,
    runId: run.run_id,
    expectedCommand: null,
  });
  const supervisor = new ProviderProcessSupervisor({
    ...launched,
    ownsProcessLifetime: true,
    cleanup: () => cleanupOwnedProcessGroup(launched.ownership),
  });
  try {
    assert.ok(await supervisor.waitForExit(180000), "SEH probe timed out");
    assert.ok(
      await supervisor.waitForOutputClose(1000),
      "SEH probe output did not close",
    );
    const probe = supervisor.snapshot();
    assert.equal(probe.exitCode, 0);
    assert.match(
      probe.stdout.text + probe.stderr.text,
      /REA_BORLAND_SEH_PROBE_PASSED/u,
    );
  } finally {
    const cleanup = await supervisor.stop();
    assert.equal(cleanup.status, "verified-cleanup", JSON.stringify(cleanup));
  }

  const cli = await exec(
    process.execPath,
    [
      entrypoint,
      "function",
      target,
      "0x401000",
      "--provider",
      "ghidra",
      "--json",
    ],
    { env: environment, timeout: 240000, maxBuffer: 8 * 1024 * 1024 },
  );
  assertDossier(parseEvidence(JSON.parse(cli.stdout)));

  const client = new Client({ name: "rea-borland-seh-verifier", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, "mcp"],
    env: environment,
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const call = async (name, arguments_) => {
      const result = await client.callTool(
        { name, arguments: arguments_ },
        { timeout: 240000 },
      );
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return result.structuredContent;
    };
    await call("open_binary", { path: target, provider_id: "ghidra" });
    assertDossier(
      parseEvidence(await call("analyze_function", { procedure: "0x401000" })),
    );
    const resolved = parseEvidence(
      await call("resolve_containing_procedure", { address: "0x401025" }),
    );
    assert.equal(resolved.normalized_result.found, true);
    assert.equal(resolved.normalized_result.procedure.address, "0x401000");
    const info = parseEvidence(
      await call("procedure_info", { procedure: "0x401000" }),
    );
    assert.equal(info.normalized_result.body.total_bytes, 57);
    const callees = parseEvidence(
      await call("procedure_callees", { procedure: "0x401000" }),
    );
    assert.ok(callees.normalized_result.includes("0x401090"));
    const references = parseEvidence(
      await call("procedure_references", {
        procedure: "0x401000",
        direction: "outgoing",
      }),
    );
    assert.ok(
      references.limitations.some(
        (text) =>
          text.includes("SEH registration") && text.includes("included"),
      ),
    );
    await call("close_binary", {});
    await writeFile(
      seeds,
      "0x401080\tfunction\tunidentified_shared_handler\n0x401090\tfunction\trea_seh_message\n0x4010f0\tfunction\trea_seh_other_string_reference\n",
    );
    await call("open_binary", { path: target, provider_id: "ghidra" });
    const omitted = parseEvidence(
      await call("procedure_callees", { procedure: "0x401000" }),
    );
    assert.equal(omitted.relationship_coverage.status, "partial");
    assert.ok(
      omitted.relationship_coverage.diagnostics.some((text) =>
        text.includes("indirect calls remain unknown"),
      ),
    );
    assert.ok(!omitted.normalized_result.includes("0x401090"));
    const omittedReferences = parseEvidence(
      await call("procedure_references", {
        procedure: "0x401000",
        direction: "outgoing",
      }),
    );
    assert.ok(
      omittedReferences.limitations.some((text) =>
        text.includes("No supplied Borland RTL identity"),
      ),
    );
    await call("close_binary", {});
  } finally {
    try {
      await client.close();
    } finally {
      await transport.close();
    }
  }
  assert.equal(
    createHash("sha256")
      .update(await readFile(target))
      .digest("hex"),
    sha256,
  );
  assert.deepEqual(await readdir(runtime), []);
  const verifierRun = await completeVerifierRun(run);
  assert.equal(verifierRun.process_lineage.status, "verified");
  assert.deepEqual(verifierRun.process_lineage.descendants, []);
  verifiedCleanup = true;
  console.log(
    JSON.stringify({
      status: "passed",
      target_sha256: sha256,
      provider: "Ghidra 12.1.4",
      host: `${process.platform}/${process.arch}`,
      checks: [
        "orphan_handler_recovered",
        "ordinary_jump_continuation_rejected",
        "procedure_reference_provenance",
        "partial_coverage_retains_indirect_call_diagnostics",
        "handler_only_string_and_call",
        "containing_procedure",
        "nonzero_fs_rejected",
        "independent_owner_preserved",
        "windows_observe_only_policy",
        "target_immutable",
        "runtime_cleanup",
      ],
      verification_scope:
        "Real Ghidra on a source-owned PE32; Windows host execution and the issue's full public binary are separate coverage.",
      verifier_run: verifierRun,
    }),
  );
} finally {
  if (verifiedCleanup) await rm(workspace, { recursive: true, force: true });
  else
    console.error(
      `Verification failed; retained owned diagnostics at ${workspace}`,
    );
}
