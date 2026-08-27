import { spawn } from "node:child_process";

export interface ProcessResult {
  readonly code?: number;
  readonly signal?: string;
  readonly timedOut: boolean;
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
}

const GRACE_KILL_MS = 5_000;

export function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
  return new Promise((resolveResult) => {
    let settled = false;
    let timedOut = false;
    let truncated = false;
    let captured = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
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
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.argv[0]!, spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...spec.env },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ timedOut: false, stdout: "", stderr: `spawn failed: ${error instanceof Error ? error.message : String(error)}`, truncated: false });
      return;
    }
    child.stdout!.on("data", capture(stdoutChunks));
    child.stderr!.on("data", capture(stderrChunks));
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      grace = setTimeout(() => child.kill("SIGKILL"), GRACE_KILL_MS);
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
