import { open, stat } from "node:fs/promises";
import { win32 } from "node:path";

/** BYO x64dbg provider identity. Discovery never starts a debugger session. */
export const X64DBG_PROVIDER_IDENTITY = {
  id: "x64dbg.byo",
  name: "x64dbg (bring your own)",
  version: null,
} as const;

export type X64dbgArchitecture = "x64" | "x86";

export type X64dbgCandidateSource = "environment" | "well-known-path";

export type X64dbgExecutableCapability = {
  readonly path: string;
  readonly source: X64dbgCandidateSource;
  readonly architecture: X64dbgArchitecture | null;
  readonly size_bytes: number;
  readonly architecture_status:
    | "pe_header"
    | "unrecognized_header"
    | "header_read_failed";
  /** Why the header could not be read; null when it was read. */
  readonly header_read_error: string | null;
};

export type X64dbgDiscoveryStatus =
  | "available"
  | "unsupported_platform"
  | "configured_path_not_found"
  | "not_found";

export type X64dbgDiscoveryResult = {
  readonly provider: string;
  readonly host_platform: string;
  readonly status: X64dbgDiscoveryStatus;
  readonly reason: string;
  readonly executables: readonly X64dbgExecutableCapability[];
  readonly configured_command: string | null;
  readonly launched_process: false;
  readonly debug_session_capability: "not_implemented";
};

/** Host seams so discovery is deterministic in tests on any platform. */
export interface X64dbgDiscoveryHost {
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  /** Resolves file size when the path is a regular file, otherwise undefined. */
  readonly fileSize?: (path: string) => Promise<number | undefined>;
  /** Reads at most `length` bytes from the start of the file; rejects on I/O failure. */
  readonly readHead?: (path: string, length: number) => Promise<Uint8Array>;
}

export const X64DBG_COMMAND_ENV = "REA_X64DBG_COMMAND";

const PE_HEADER_READ_BYTES = 4096;

// Asynchronous so a slow mapped drive or UNC share cannot block the MCP
// server's event loop while peer tools and cancellation are waiting.
const defaultFileSize = async (path: string): Promise<number | undefined> => {
  try {
    const stats = await stat(path);
    return stats.isFile() ? stats.size : undefined;
  } catch {
    return undefined;
  }
};

const defaultReadHead = async (
  path: string,
  length: number,
): Promise<Uint8Array> => {
  const handle = await open(path, "r");
  try {
    const buffer = new Uint8Array(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

/** Windows environment names are case-insensitive; snapshots may upper-case them. */
const environmentValue = (
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
): string | undefined => {
  const exact = environment[name];
  if (exact !== undefined) return exact;
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(environment))
    if (key.toUpperCase() === wanted && value !== undefined) return value;
  return undefined;
};

/** Classify a PE image by its COFF machine field without executing it. */
export const peArchitecture = (head: Uint8Array): X64dbgArchitecture | null => {
  if (head.length < 0x40 || head[0] !== 0x4d || head[1] !== 0x5a) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const peOffset = view.getUint32(0x3c, true);
  if (peOffset + 6 > head.length) return null;
  if (view.getUint32(peOffset, true) !== 0x00004550) return null;
  const machine = view.getUint16(peOffset + 4, true);
  if (machine === 0x8664) return "x64";
  if (machine === 0x014c) return "x86";
  return null;
};

/** Ordered well-known install locations derived from the Windows environment. */
export const wellKnownX64dbgPaths = (
  environment: Readonly<NodeJS.ProcessEnv>,
): readonly string[] => {
  const localAppData = environmentValue(environment, "LOCALAPPDATA");
  const systemDrive = environmentValue(environment, "SystemDrive");
  const roots = [
    environmentValue(environment, "ProgramFiles"),
    environmentValue(environment, "ProgramFiles(x86)"),
    localAppData === undefined
      ? undefined
      : win32.join(localAppData, "Programs"),
    systemDrive === undefined ? undefined : `${systemDrive}\\`,
  ].filter((root): root is string => root !== undefined && root.length > 0);
  const paths: string[] = [];
  for (const root of roots)
    for (const relative of [
      "x64dbg\\release\\x64\\x64dbg.exe",
      "x64dbg\\release\\x32\\x32dbg.exe",
      "x64dbg\\x64\\x64dbg.exe",
      "x64dbg\\x32\\x32dbg.exe",
    ])
      paths.push(win32.join(root, relative));
  return [...new Set(paths)];
};

const describe = async (
  path: string,
  source: X64dbgCandidateSource,
  host: X64dbgDiscoveryHost,
): Promise<X64dbgExecutableCapability | undefined> => {
  const size = await (host.fileSize ?? defaultFileSize)(path);
  if (size === undefined) return undefined;
  let head: Uint8Array;
  try {
    head = await (host.readHead ?? defaultReadHead)(path, PE_HEADER_READ_BYTES);
  } catch (error) {
    // A permission or I/O failure is not an unsupported header.
    return {
      path,
      source,
      architecture: null,
      size_bytes: size,
      architecture_status: "header_read_failed",
      header_read_error: error instanceof Error ? error.message : String(error),
    };
  }
  const architecture = peArchitecture(head);
  return {
    path,
    source,
    architecture,
    size_bytes: size,
    architecture_status:
      architecture === null ? "unrecognized_header" : "pe_header",
    header_read_error: null,
  };
};

/**
 * Locate a BYO x64dbg/x32dbg executable and report file-metadata capability.
 * Reads file metadata and the PE header only; never launches the debugger,
 * attaches to a process, or writes anything. Every failure is reported as a
 * status instead of thrown, so callers composing optional providers are not
 * affected by this adapter being unavailable.
 */
export const discoverX64dbg = async (
  host: X64dbgDiscoveryHost,
): Promise<X64dbgDiscoveryResult> => {
  const configuredRaw = environmentValue(
    host.environment,
    X64DBG_COMMAND_ENV,
  )?.trim();
  const configured =
    configuredRaw === undefined || configuredRaw.length === 0
      ? null
      : configuredRaw;
  const base = {
    provider: X64DBG_PROVIDER_IDENTITY.id,
    host_platform: host.platform,
    configured_command: configured,
    launched_process: false,
    debug_session_capability: "not_implemented",
  } as const;
  if (host.platform !== "win32")
    return {
      ...base,
      status: "unsupported_platform",
      reason: `x64dbg is a Windows debugger; discovery is unavailable on ${host.platform}.`,
      executables: [],
    };
  try {
    if (configured !== null) {
      const found = await describe(configured, "environment", host);
      return found === undefined
        ? {
            ...base,
            status: "configured_path_not_found",
            reason: `${X64DBG_COMMAND_ENV} does not name an existing regular file.`,
            executables: [],
          }
        : {
            ...base,
            status: "available",
            reason: `Resolved from ${X64DBG_COMMAND_ENV}.`,
            executables: [found],
          };
    }
    const executables: X64dbgExecutableCapability[] = [];
    for (const path of wellKnownX64dbgPaths(host.environment)) {
      const found = await describe(path, "well-known-path", host);
      if (found !== undefined) executables.push(found);
    }
    return executables.length === 0
      ? {
          ...base,
          status: "not_found",
          reason: `No x64dbg executable found; set ${X64DBG_COMMAND_ENV} to x64dbg.exe or x32dbg.exe.`,
          executables: [],
        }
      : {
          ...base,
          status: "available",
          reason: "Resolved from well-known install locations.",
          executables,
        };
  } catch (error) {
    return {
      ...base,
      status: "not_found",
      reason: `Discovery failed closed: ${error instanceof Error ? error.message : String(error)}`,
      executables: [],
    };
  }
};
