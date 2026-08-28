import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

export interface ProcessResult {
  readonly code?: number;
  readonly signal?: string;
  readonly timedOut: boolean;
  readonly cancelled?: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly spawnError?: string;
}

export interface ProcessSpec {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxCaptureBytes: number;
  /** Optional payload written to the child's stdin, then closed. */
  readonly stdin?: string;
  readonly signal?: AbortSignal;
  /** When set, the cwd must resolve (through symlinks) inside this directory. */
  readonly containmentRoot?: string;
}

const GRACE_KILL_MS = 5_000;

type Containment = { readonly real: string } | { readonly error: string };

function containCwd(cwd: string, root: string | undefined): Containment {
  try {
    const real = realpathSync(cwd);
    if (root === undefined) return { real };
    const realRoot = realpathSync(root);
    const rel = relative(realRoot, real);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return { real };
    return { error: `cwd ${cwd} resolves to ${real}, which is outside the workflow directory ${realRoot}` };
  } catch (error) {
    return { error: `cwd could not be resolved: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
  return new Promise((resolveResult) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let truncated = false;
    let captured = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let child: ReturnType<typeof spawn> | undefined;
    const signalTree = (name: "SIGTERM" | "SIGKILL"): void => {
      if (child?.pid === undefined) return;
      try {
        process.kill(-child.pid, name);
      } catch {
        child.kill(name);
      }
    };
    const onAbort = (): void => {
      if (settled) return;
      cancelled = true;
      signalTree("SIGTERM");
      grace = setTimeout(() => signalTree("SIGKILL"), GRACE_KILL_MS);
    };
    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      spec.signal?.removeEventListener("abort", onAbort);
      resolveResult(result);
    };
    const capture = (chunks: Buffer[]) => (chunk: Buffer): void => {
      if (captured >= spec.maxCaptureBytes) {
        truncated = true;
        return;
      }
      const room = spec.maxCaptureBytes - captured;
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (slice.length < chunk.length) truncated = true;
      captured += slice.length;
      chunks.push(slice);
    };
    if (spec.signal?.aborted) {
      finish({ timedOut: false, cancelled: true, stdout: "", stderr: "", truncated: false });
      return;
    }
    const contained = containCwd(spec.cwd, spec.containmentRoot);
    if ("error" in contained) {
      finish({ timedOut: false, stdout: "", stderr: `spawn failed: ${contained.error}`, truncated: false, spawnError: contained.error });
      return;
    }
    try {
      child = spawn(spec.argv[0]!, spec.argv.slice(1), {
        cwd: contained.real,
        env: { ...spec.env },
        shell: false,
        detached: true,
        stdio: [spec.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ timedOut: false, stdout: "", stderr: `spawn failed: ${error instanceof Error ? error.message : String(error)}`, truncated: false });
      return;
    }
    if (spec.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {
        /* The child may exit without reading stdin; EPIPE here is not a failure. */
      });
      child.stdin.end(spec.stdin);
    }
    spec.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout!.on("data", capture(stdoutChunks));
    child.stderr!.on("data", capture(stderrChunks));
    timer = setTimeout(() => {
      timedOut = true;
      signalTree("SIGTERM");
      grace = setTimeout(() => signalTree("SIGKILL"), GRACE_KILL_MS);
    }, spec.timeoutMs);
    child.on("error", (error) => {
      finish({
        timedOut,
        stdout: text(stdoutChunks),
        stderr: `spawn failed: ${error instanceof Error ? error.message : String(error)}`,
        truncated,
        spawnError: error instanceof Error ? error.message : String(error),
      });
    });
    child.on("close", (code, signal) => {
      finish({
        code: code ?? undefined,
        signal: signal ?? undefined,
        timedOut,
        ...(cancelled ? { cancelled: true } : {}),
        stdout: text(stdoutChunks),
        stderr: text(stderrChunks),
        truncated,
      });
    });
  });
}

function text(chunks: readonly Buffer[]): string {
  return Buffer.concat(chunks).toString("utf8");
}
