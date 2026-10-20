import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { waitForExit } from "../process/processFixture.js";
import {
  createCliSessionFrameReader,
  encodeCliSessionFrame,
} from "./cliCommandSessionFrames.mjs";

const workerPath = fileURLToPath(
  new URL("./cliCommandSessionWorker.mjs", import.meta.url),
);
const SHUTDOWN_GRACE_MS = 1_000;

const responseSchema = z.object({
  ready: z.boolean().optional(),
  id: z.number().optional(),
  exitCode: z.number().nullable().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  pid: z.number().optional(),
  fatal: z.boolean().optional(),
});

/** One compiled CLI command sent to the shared process. */
export interface CliCommandRequest {
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

/** Captured result from one shared CLI command. */
export interface CliCommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly json: unknown | undefined;
}

/** File-scoped compiled CLI process. */
export interface CliCommandSession {
  run(request: CliCommandRequest): Promise<CliCommandResult>;
  /** PID of the live process, when one is running. */
  processId(): number | undefined;
  close(): Promise<void>;
}

interface CliCommandSessionDependencies {
  readonly spawnWorker?: (
    environment: Readonly<Record<string, string>>,
  ) => ChildProcessWithoutNullStreams;
}

interface PendingCommand {
  readonly id: number;
  readonly resolve: (result: CliCommandResult) => void;
  readonly reject: (error: unknown) => void;
}

type SessionResponse = z.infer<typeof responseSchema>;

const closedError = (): Error => new Error("Shared CLI session is closed");

const envKey = (environment: Readonly<Record<string, string>>): string =>
  JSON.stringify(
    Object.keys(environment)
      .sort()
      .map((key) => [key, environment[key]]),
  );

const parseCliStdout = (stdout: string): unknown | undefined => {
  const document = stdout.trim();
  if (document.length === 0) return undefined;
  try {
    return JSON.parse(document) as unknown;
  } catch {
    return undefined;
  }
};

const signalChild = (
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void => {
  try {
    child.kill(signal);
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? error.code : undefined;
    if (code !== "ESRCH") throw error;
  }
};

const stopChild = async (
  child: ChildProcessWithoutNullStreams,
): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalChild(child, "SIGTERM");
  if (await waitForExit(child, SHUTDOWN_GRACE_MS)) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalChild(child, "SIGKILL");
  if (await waitForExit(child, SHUTDOWN_GRACE_MS)) return;
  throw new Error(
    `shared CLI process ${String(child.pid)} did not exit after SIGKILL`,
  );
};

const commandResult = (message: SessionResponse): CliCommandResult => ({
  exitCode: message.exitCode ?? null,
  signal: null,
  stdout: message.stdout ?? "",
  stderr: message.stderr ?? "",
  json: parseCliStdout(message.stdout ?? ""),
});

const writeChild = (
  child: ChildProcessWithoutNullStreams,
  frame: Buffer,
): Promise<void> =>
  new Promise((resolve, reject) => {
    child.stdin.write(frame, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });

const defaultSpawnWorker = (
  environment: Readonly<Record<string, string>>,
): ChildProcessWithoutNullStreams =>
  spawn(process.execPath, [workerPath], {
    cwd: process.cwd(),
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });

class SharedCliProcess implements CliCommandSession {
  readonly #spawnWorker: (
    environment: Readonly<Record<string, string>>,
  ) => ChildProcessWithoutNullStreams;

  #child: ChildProcessWithoutNullStreams | undefined;
  #childEnvKey: string | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  #starting: Promise<void> | undefined;
  #nextId = 1;
  #pending: PendingCommand | undefined;
  #resolveReady: (() => void) | undefined;
  #rejectReady: ((error: unknown) => void) | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(dependencies: CliCommandSessionDependencies) {
    this.#spawnWorker = dependencies.spawnWorker ?? defaultSpawnWorker;
  }

  run(request: CliCommandRequest): Promise<CliCommandResult> {
    const result = this.#queue.then(() => this.#invoke(request));
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  processId(): number | undefined {
    const child = this.#child;
    if (
      child === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      return undefined;
    }
    return child.pid;
  }

  close(): Promise<void> {
    this.#closed = true;
    if (this.#closing !== undefined) return this.#closing;
    const attempt = this.#shutdown();
    this.#closing = attempt;
    return attempt;
  }

  async #shutdown(): Promise<void> {
    const owner = this.#child;
    try {
      if (owner !== undefined) await stopChild(owner);
    } catch (error) {
      this.#closing = undefined;
      throw error;
    }
    const pendingStart = this.#starting;
    if (pendingStart !== undefined) await pendingStart.catch(() => undefined);
  }

  async #invoke(request: CliCommandRequest): Promise<CliCommandResult> {
    if (this.#closed) throw closedError();
    await this.#ensure(request.environment);
    const owner = this.#child;
    if (this.#closed || owner === undefined) throw closedError();
    const id = this.#nextId;
    this.#nextId += 1;
    const result = new Promise<CliCommandResult>((resolve, reject) => {
      this.#pending = { id, resolve, reject };
    });
    try {
      await writeChild(
        owner,
        encodeCliSessionFrame({
          id,
          arguments: request.arguments,
          cwd: request.cwd,
          env: request.environment,
        }),
      );
    } catch (error) {
      this.#failPending(error);
    }
    return result;
  }

  async #ensure(environment: Readonly<Record<string, string>>): Promise<void> {
    if (this.#closed) throw closedError();
    const key = envKey(environment);
    const current = this.#child;
    if (
      current !== undefined &&
      current.exitCode === null &&
      current.signalCode === null &&
      this.#childEnvKey === key
    ) {
      return;
    }
    if (current !== undefined) await stopChild(current);
    if (this.#closed) throw closedError();
    await this.#start(environment);
  }

  #start(environment: Readonly<Record<string, string>>): Promise<void> {
    if (this.#closed) return Promise.reject(closedError());
    const started = this.#spawnWorker(environment);
    this.#child = started;
    this.#childEnvKey = envKey(environment);
    const ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#starting = ready;
    this.#watch(started);
    if (this.#closed) {
      signalChild(started, "SIGTERM");
      this.#failReady(closedError());
    }
    return ready.finally(() => {
      if (this.#starting === ready) this.#starting = undefined;
    });
  }

  #watch(started: ChildProcessWithoutNullStreams): void {
    const reader = createCliSessionFrameReader((frame) => {
      this.#onFrame(started, frame);
    });
    started.stdout.on("data", (chunk: Buffer) => {
      try {
        reader(chunk);
      } catch (error) {
        this.#failTransport(started, error);
      }
    });
    started.stderr.resume();
    started.stdin.on("error", (error) => {
      this.#failTransport(started, error);
    });
    started.once("error", (error) => {
      this.#failTransport(started, error);
    });
    started.once("close", (code, signal) => {
      this.#onClose(started, code, signal);
    });
  }

  #onFrame(owner: ChildProcessWithoutNullStreams, value: unknown): void {
    if (this.#child !== owner || this.#closed) return;
    const parsed = responseSchema.safeParse(value);
    if (!parsed.success) {
      this.#failTransport(
        owner,
        new Error("CLI session response was not a command result"),
      );
      return;
    }
    const message = parsed.data;
    if (message.ready === true && message.id === undefined) {
      const resolve = this.#resolveReady;
      this.#resolveReady = undefined;
      this.#rejectReady = undefined;
      resolve?.();
      return;
    }
    const current = this.#pending;
    if (current === undefined || message.id !== current.id) {
      this.#failTransport(
        owner,
        new Error("CLI session response did not match the command"),
      );
      return;
    }
    if (message.exitCode === undefined) {
      this.#failTransport(
        owner,
        new Error("CLI session response omitted its exit code"),
      );
      return;
    }
    this.#pending = undefined;
    current.resolve(commandResult(message));
  }

  #onClose(
    owner: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.#child !== owner) return;
    this.#child = undefined;
    this.#childEnvKey = undefined;
    const error = this.#closed
      ? closedError()
      : new Error(
          `Shared CLI process exited (${String(code ?? signal ?? "unknown")})`,
        );
    this.#failReady(error);
    this.#failPending(error);
  }

  #failTransport(owner: ChildProcessWithoutNullStreams, error: unknown): void {
    if (this.#child !== owner) return;
    this.#failReady(error);
    this.#failPending(error);
    if (owner.exitCode === null && owner.signalCode === null) {
      signalChild(owner, "SIGTERM");
    }
  }

  #failPending(error: unknown): void {
    const current = this.#pending;
    this.#pending = undefined;
    current?.reject(error);
  }

  #failReady(error: unknown): void {
    const reject = this.#rejectReady;
    this.#resolveReady = undefined;
    this.#rejectReady = undefined;
    reject?.(error);
  }
}

/** Keep one compiled CLI process for commands that share an environment. */
export const createCliCommandSession = (
  dependencies: CliCommandSessionDependencies = {},
): CliCommandSession => new SharedCliProcess(dependencies);
