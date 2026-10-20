import { describe, expect, it } from "vitest";

import { x64dbgDiscoverySchema } from "../contracts/x64dbgToolContracts.js";
import { toolContract } from "../contracts/toolContracts.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import {
  discoverX64dbg,
  peArchitecture,
  wellKnownX64dbgPaths,
  type X64dbgDiscoveryHost,
} from "./X64dbgDiscovery.js";

const pe = (machine: number): Uint8Array => {
  const bytes = new Uint8Array(0x100);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  view.setUint32(0x3c, 0x80, true);
  view.setUint32(0x80, 0x00004550, true);
  view.setUint16(0x84, machine, true);
  return bytes;
};

const windowsHost = (
  files: Readonly<Record<string, Uint8Array>>,
  environment: NodeJS.ProcessEnv,
): X64dbgDiscoveryHost => ({
  platform: "win32",
  environment,
  fileSize: async (path) => files[path]?.length,
  readHead: async (path, length) => {
    const file = files[path];
    if (file === undefined) throw new Error(`ENOENT: ${path}`);
    return file.subarray(0, length);
  },
});

describe("discoverX64dbg", () => {
  it("returns unsupported_platform on Linux without touching the filesystem", async () => {
    const result = await discoverX64dbg({
      platform: "linux",
      environment: { REA_X64DBG_COMMAND: "/opt/x64dbg.exe" },
      fileSize: async () => {
        throw new Error("must not be called");
      },
    });
    expect(result.status).toBe("unsupported_platform");
    expect(result.reason).toContain("linux");
    expect(result.executables).toEqual([]);
    expect(result.launched_process).toBe(false);
    expect(x64dbgDiscoverySchema.parse(result)).toEqual(result);
  });

  it("prefers REA_X64DBG_COMMAND and reports PE architecture", async () => {
    const path = "D:\\tools\\x64dbg\\x64\\x64dbg.exe";
    const result = await discoverX64dbg(
      windowsHost(
        { [path]: pe(0x8664) },
        { REA_X64DBG_COMMAND: ` ${path} `, ProgramFiles: "C:\\Program Files" },
      ),
    );
    expect(result.status).toBe("available");
    expect(result.executables).toEqual([
      {
        path,
        source: "environment",
        architecture: "x64",
        size_bytes: 0x100,
        architecture_status: "pe_header",
        header_read_error: null,
      },
    ]);
    expect(x64dbgDiscoverySchema.parse(result)).toEqual(result);
  });

  it("does not fall back to well-known paths when the configured path is missing", async () => {
    const known = "C:\\Program Files\\x64dbg\\release\\x64\\x64dbg.exe";
    const result = await discoverX64dbg(
      windowsHost(
        { [known]: pe(0x8664) },
        {
          REA_X64DBG_COMMAND: "C:\\missing.exe",
          ProgramFiles: "C:\\Program Files",
        },
      ),
    );
    expect(result.status).toBe("configured_path_not_found");
    expect(result.executables).toEqual([]);
  });

  it("finds x64 and x32 builds in well-known locations", async () => {
    const x64 = "C:\\Program Files\\x64dbg\\release\\x64\\x64dbg.exe";
    const x32 = "C:\\Program Files\\x64dbg\\release\\x32\\x32dbg.exe";
    const result = await discoverX64dbg(
      windowsHost(
        { [x64]: pe(0x8664), [x32]: pe(0x014c) },
        { ProgramFiles: "C:\\Program Files" },
      ),
    );
    expect(result.status).toBe("available");
    expect(result.executables.map((entry) => entry.architecture)).toEqual([
      "x64",
      "x86",
    ]);
  });

  it("reports not_found with a remediation hint", async () => {
    const result = await discoverX64dbg(windowsHost({}, {}));
    expect(result.status).toBe("not_found");
    expect(result.reason).toContain("REA_X64DBG_COMMAND");
  });

  it("fails closed instead of throwing when the host seam throws", async () => {
    const result = await discoverX64dbg({
      platform: "win32",
      environment: { ProgramFiles: "C:\\Program Files" },
      fileSize: async () => {
        throw new Error("access denied");
      },
    });
    expect(result.status).toBe("not_found");
    expect(result.reason).toContain("access denied");
  });

  it("marks non-PE files as unrecognized", async () => {
    const path = "C:\\x\\x64dbg.exe";
    const result = await discoverX64dbg(
      windowsHost({ [path]: new Uint8Array(8) }, { REA_X64DBG_COMMAND: path }),
    );
    expect(result.executables[0]?.architecture_status).toBe(
      "unrecognized_header",
    );
  });
});

describe("x64dbg review regressions", () => {
  it("finds well-known installs through an upper-cased Windows snapshot", async () => {
    const x64 = "C:\\Program Files\\x64dbg\\release\\x64\\x64dbg.exe";
    const x32 = "C:\\Program Files (x86)\\x64dbg\\x32\\x32dbg.exe";
    const environment = snapshotEnvironment(
      {
        ProgramFiles: "C:\\Program Files",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
        SystemDrive: "C:",
      },
      "win32",
    );
    expect(Object.keys(environment)).toContain("PROGRAMFILES");
    const result = await discoverX64dbg(
      windowsHost({ [x64]: pe(0x8664), [x32]: pe(0x014c) }, environment),
    );
    expect(result.status).toBe("available");
    expect(result.executables.map((entry) => entry.path)).toEqual([x64, x32]);
  });

  it("reads REA_X64DBG_COMMAND case-insensitively on Windows", async () => {
    const path = "D:\\x64dbg.exe";
    const result = await discoverX64dbg(
      windowsHost({ [path]: pe(0x8664) }, { rea_x64dbg_command: path }),
    );
    expect(result.status).toBe("available");
    expect(result.configured_command).toBe(path);
  });

  it("keeps header read failures distinct from unrecognized headers", async () => {
    const path = "C:\\x\\x64dbg.exe";
    const result = await discoverX64dbg({
      platform: "win32",
      environment: { REA_X64DBG_COMMAND: path },
      fileSize: async () => 4096,
      readHead: async () => {
        throw new Error("EACCES: permission denied");
      },
    });
    expect(result.status).toBe("available");
    expect(result.executables[0]).toMatchObject({
      architecture: null,
      architecture_status: "header_read_failed",
      header_read_error: "EACCES: permission denied",
    });
    expect(x64dbgDiscoverySchema.parse(result)).toEqual(result);
  });

  it("does not block the event loop while a file probe is pending", async () => {
    let release: (value: number | undefined) => void = () => undefined;
    const pending = discoverX64dbg({
      platform: "win32",
      environment: { REA_X64DBG_COMMAND: "\\\\slow\\share\\x64dbg.exe" },
      fileSize: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    let peerRan = false;
    await new Promise<void>((resolve) =>
      setImmediate(() => {
        peerRan = true;
        resolve();
      }),
    );
    expect(peerRan).toBe(true);
    release(undefined);
    expect((await pending).status).toBe("configured_path_not_found");
  });
});

describe("x64dbg helpers", () => {
  it("rejects truncated or foreign machine headers", async () => {
    expect(peArchitecture(new Uint8Array(2))).toBeNull();
    expect(peArchitecture(pe(0xaa64))).toBeNull();
  });

  it("derives deduplicated install candidates from the environment", async () => {
    const paths = wellKnownX64dbgPaths({
      ProgramFiles: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
    });
    expect(paths).toContain(
      "C:\\Users\\a\\AppData\\Local\\Programs\\x64dbg\\release\\x64\\x64dbg.exe",
    );
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("publishes a read-only discovery contract with no session tools", async () => {
    const contract = toolContract("discover_x64dbg");
    expect(contract.effects.launchesProcess).toBe(false);
    expect(contract.effects.executesForeignCode).toBe(false);
    expect(contract.effects.mutatesTarget).toBe(false);
    expect(contract.annotations.readOnlyHint).toBe(true);
  });
});
