# Implementation plan

## Review revision contract

Before extending a function across a non-fallthrough handler jump, require a
caller-supplied or imported Borland RTL symbol;
an arbitrary executable destination is insufficient. Unknown layouts retain
an explicit omission. Keep SEH provenance on procedure-reference observations,
merge omission coverage with existing computed-call diagnostics at the Java
producer, and require verified empty process lineage before verifier success.
Integrate these facts into main's current boundary-observation/source manifest
contracts and cover a shared-handler jump followed by unrelated instructions.

1. Add a Ghidra-owned producer that reads decoded instruction encodings and
   tracks exact adjacent zero-offset registration patterns. Use Ghidra's
   disassembler with a restriction set containing only unowned gaps; disable
   automatic code analysis for that command.
2. Traverse handler entry and the continuation after its RTL jump veneer.
   Add decoded reachable instructions only, stop at original body/other owners,
   and require a return to the original body or a recognized flow terminator.
   Store per-function diagnostics, including unrecovered handler addresses.
3. Run the producer once before the bridge initializes its decompiler. Supply
   its diagnostics to every function observation; preserve the existing shape.
   Bind the changed semantics into the analysis profile.
4. Verify a self-owned PE32 fixture through real Ghidra, including negative
   registration and ownership cases. Run source/static/document checks.
5. If process-group verification races with an acknowledged JVM shutdown,
   wait for the retained child exit and retry full group verification once.
   Child exit alone never authorizes runtime deletion; incomplete group
   cleanup retains its supervisor and files for a later verified close.

## Executed validation

Review revision on upstream `1629266e3`, Node 24.18.0, Ghidra 12.1.4,
JDK 21 and darwin/arm64:

- 354 tests passed across function values, provider behavior, snapshot/MCP,
  client lifecycle, bridge-source ownership and packed-bridge suites.
- Real CLI/MCP and producer-probe verification passed, including rejecting an
  ordinary shared-handler jump followed by unrelated bytes, recovery with a
  supplied RTL identity, procedure-reference provenance, partial coverage with
  indirect-call diagnostics, immutable target and verified empty lineage.
- Static checks and docs checks passed. The old Greek README drift (#3022)
  is resolved in current main.
- Full package verification passed, including installation/update, CLI/MCP,
  setup/uninstall and verified empty process lineage.
- The public executable reproduction recorded before review used the previous
  permissive jump heuristic. It has not been rerun with the current RTL-identity
  gate and does not establish the current branch's public-target recovery.
  Windows-host execution and full public-target coverage remain unverified.
- No controlled speed, live-model token or process-family memory comparison was
  performed for this pass; no performance improvement is claimed.
