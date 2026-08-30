import { resolve } from "node:path";
import type { ArtifactRef } from "../domain/artifacts.ts";
import type { ScriptSpec } from "../domain/workflow.ts";
import { ArtifactStore } from "./artifact-store.ts";
import type { ProcessResult } from "./process-runner.ts";

/** Publishes a script's declared capture files into the run's artifact store after an accepted exit. */
export function captureScriptFiles(key: string, spec: ScriptSpec, cwd: string, store: ArtifactStore, exit: ProcessResult): { readonly files?: readonly ArtifactRef[]; readonly captureError?: string } {
  const accepted = !exit.timedOut && !exit.cancelled && exit.spawnError === undefined && exit.code !== undefined && spec.acceptedExitCodes.includes(exit.code);
  if (!accepted || !spec.files?.length) return {};
  const files: ArtifactRef[] = [];
  try {
    for (const capture of spec.files) files.push(store.publishFile(capture.name, key, resolve(cwd, capture.path)));
    return { files };
  } catch (error) {
    return { captureError: `a declared capture file could not be published: ${error instanceof Error ? error.message : String(error)}` };
  }
}
