import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { ARTIFACT_MEDIA_TYPES, type ArtifactSink, isArtifactRef, type ArtifactRef } from "../domain/artifacts.ts";
import { canonicalJson, isJsonValue, type JsonValue } from "../domain/json.ts";

export type LoadResult =
  | { readonly ok: true; readonly content: Buffer }
  | { readonly ok: false; readonly error: string };

export type MaterializeResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string };

const OBJECTS_DIR = "objects";
const MATERIALIZE_DIR = ".choreograph/artifacts";

function hexOf(checksum: string): string {
  const prefix = "sha256-";
  if (!checksum.startsWith(prefix)) return "";
  const hex = checksum.slice(prefix.length);
  return /^[0-9a-f]{64}$/.test(hex) ? hex : "";
}

function checksumOf(content: Buffer | string): string {
  return `sha256-${createHash("sha256").update(content).digest("hex")}`;
}

/**
 * Content-addressed artifact store for one run, rooted under the run directory.
 * Objects live at `<root>/objects/<sha256 hex>` and dedupe by checksum;
 * retention is per-run because the root names the run.
 */
export class ArtifactStore {
  readonly rootDir: string;

  private constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  /** Roots the store under `<workflowDir>/.choreograph/runs/<runId>/artifacts`. */
  static forRun(workflowDir: string, runId: string): ArtifactStore | undefined {
    if (!isAbsolute(workflowDir)) return undefined;
    return new ArtifactStore(join(workflowDir, ".choreograph", "runs", runId, "artifacts"));
  }

  pathOf(ref: ArtifactRef): string {
    const hex = hexOf(ref.checksum);
    if (!hex) return "";
    return join(this.rootDir, OBJECTS_DIR, hex);
  }

  publishJson(name: string, invocationKey: string, value: JsonValue): ArtifactRef {
    if (!isJsonValue(value)) throw new Error(`artifact "${name}" must be a JSON value`);
    return this.write(name, invocationKey, Buffer.from(`${canonicalJson(value)}\n`, "utf8"), ARTIFACT_MEDIA_TYPES.json);
  }

  publishText(name: string, invocationKey: string, text: string, mediaType: string = ARTIFACT_MEDIA_TYPES.text): ArtifactRef {
    return this.write(name, invocationKey, Buffer.from(text, "utf8"), mediaType);
  }

  publishFile(name: string, invocationKey: string, path: string): ArtifactRef {
    return this.write(name, invocationKey, readFileSync(path), ARTIFACT_MEDIA_TYPES.bytes);
  }

  sinkFor(invocationKey: string): ArtifactSink {
    return {
      publishJson: (name, value) => this.publishJson(name, invocationKey, value),
      publishText: (name, text, mediaType) => this.publishText(name, invocationKey, text, mediaType),
    };
  }

  load(ref: unknown): LoadResult {
    if (!isArtifactRef(ref)) return { ok: false, error: "the value is not an artifact reference" };
    const path = this.pathOf(ref);
    if (!path) return { ok: false, error: `artifact checksum "${ref.checksum}" is not a sha-256 digest` };
    let content: Buffer;
    try {
      content = readFileSync(path);
    } catch (error) {
      return { ok: false, error: `artifact ${ref.checksum} could not be read: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (checksumOf(content) !== ref.checksum) return { ok: false, error: `artifact ${ref.checksum} does not match its stored bytes` };
    return { ok: true, content };
  }

  /** Writes the referenced bytes under the workspace and returns a workspace-relative path. */
  materialize(ref: unknown, workspaceDir: string): MaterializeResult {
    if (!isArtifactRef(ref)) return { ok: false, error: "the value is not an artifact reference" };
    const loaded = this.load(ref);
    if (!loaded.ok) return loaded;
    if (!isAbsolute(workspaceDir)) return { ok: false, error: `workspace "${workspaceDir}" is not an absolute directory` };
    const hex = hexOf(ref.checksum);
    if (!hex) return { ok: false, error: `artifact checksum "${ref.checksum}" is not a sha-256 digest` };
    const target = join(workspaceDir, MATERIALIZE_DIR, hex);
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, loaded.content);
    } catch (error) {
      return { ok: false, error: `artifact ${ref.checksum} could not be materialized: ${error instanceof Error ? error.message : String(error)}` };
    }
    const rel = relative(workspaceDir, target);
    return { ok: true, path: rel.split(sep).join("/") };
  }

  private write(name: string, invocationKey: string, content: Buffer, mediaType: string): ArtifactRef {
    const checksum = checksumOf(content);
    const target = join(this.rootDir, OBJECTS_DIR, checksum.slice("sha256-".length));
    try {
      mkdirSync(dirname(target), { recursive: true });
      if (!readAndCompare(target, content)) writeFileSync(target, content);
    } catch (error) {
      throw new Error(`artifact "${name}" could not be stored: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { invocationKey, output: name, checksum, size: content.length, mediaType };
  }
}

function readAndCompare(path: string, content: Buffer): boolean {
  try {
    return readFileSync(path).equals(content);
  } catch {
    return false;
  }
}
