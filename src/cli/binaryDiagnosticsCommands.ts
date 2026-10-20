import { z } from "incur";
import {
  createRecordedCrashService,
  createBinaryLayoutService,
  createPeResourcesService,
  createWindowsMinidumpService,
} from "../composition/binaryDiagnostics.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { inspectPeResourcesInputSchema } from "../domain/native/peResources.js";
import { inspectWindowsMinidumpInputSchema } from "../domain/native/windowsMinidump.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";

/** Inspect operator-selected files through the same shared workflow as MCP. */
export const registerBinaryDiagnosticsCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  cli.command(CLI_COMMANDS.inspectPeResources, {
    description:
      "Inspect PE resource identities, payload ranges, hashes and icon-group relationships",
    args: z.object({ path: z.string().describe("Local PE32/PE32+ image") }),
    options: z.object({
      maxFileBytes: inspectPeResourcesInputSchema.shape.max_file_bytes,
      maxEntries: inspectPeResourcesInputSchema.shape.max_entries,
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const pe = createPeResourcesService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectPeResources,
          async () =>
            finishAnalysisCommand(
              () =>
                pe.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    max_file_bytes: options.maxFileBytes,
                    max_entries: options.maxEntries,
                  },
                  { signal },
                ),
              pe,
              "rea-pe-resources",
              "inspect_pe_resources",
              signal,
            ),
        );
      }),
  });
  cli.command(CLI_COMMANDS.inspectWindowsMinidump, {
    description:
      "Inspect recorded Windows minidump streams, threads, exception, modules and memory ranges without attaching",
    args: z.object({ path: z.string().describe("Local Windows minidump") }),
    options: z.object({
      maxFileBytes: inspectWindowsMinidumpInputSchema.shape.max_file_bytes,
      maxEntries: inspectWindowsMinidumpInputSchema.shape.max_entries,
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const minidump = createWindowsMinidumpService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectWindowsMinidump,
          async () =>
            finishAnalysisCommand(
              () =>
                minidump.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    max_file_bytes: options.maxFileBytes,
                    max_entries: options.maxEntries,
                  },
                  { signal },
                ),
              minidump,
              "rea-windows-minidump",
              "inspect_windows_minidump",
              signal,
            ),
        );
      }),
  });
  const service = createBinaryLayoutService(environment);
  cli.command(CLI_COMMANDS.inspectBinaryLayout, {
    description:
      "Inspect binary file/linked layout without executing the selected object",
    args: z.object({
      path: z.string().describe("Local ELF binary or relocatable object"),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectBinaryLayout, async () => {
          const result = await service.inspectAndClose(
            { path: absoluteCallerPath(args.path) },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
  const recorded = createRecordedCrashService(environment);
  cli.command(CLI_COMMANDS.inspectRecordedCrash, {
    description:
      "Inspect supplied core registers/signals and optional debugger mapping evidence",
    args: z.object({
      path: z
        .string()
        .describe("Local Linux ELF64 amd64 or AArch64 little-endian core"),
    }),
    options: z.object({
      debuggerContext: z
        .boolean()
        .default(false)
        .describe("Add BYO core-only GDB/pwndbg mapping candidates"),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectRecordedCrash, async () => {
          const result = await recorded.inspectAndClose(
            {
              path: absoluteCallerPath(args.path),
              include_debugger_context: options.debuggerContext,
            },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
};
