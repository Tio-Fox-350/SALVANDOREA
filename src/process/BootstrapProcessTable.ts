import { execFileOutput } from "./ExecFileOutput.js";
import type { ProcessTableEntry } from "./ProcessOwnership.js";

/** Read a live process table without the compiled Darwin ownership helper. */
export const readBootstrapProcessTable = async (
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<readonly ProcessTableEntry[]> => {
  const { stdout } = await execFileOutput(
    "ps",
    ["-axo", "pid=,ppid=,pgid=,uid=,stat=,command="],
    {
      env: environment,
      stopSignal: "SIGTERM",
      ...(signal === undefined ? {} : { signal }),
    },
  );
  return stdout
    .split("\n")
    .map((line) =>
      /\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)/u.exec(line),
    )
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      processGroupId: Number(match[3]),
      uid: Number(match[4]),
      state: match[5] ?? "",
      command: match[6] ?? "",
    }));
};
