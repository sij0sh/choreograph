import { createHash } from "node:crypto";
import { readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { compileContract, type ContractDescriptor } from "../domain/contract.ts";
import type { JsonValue } from "../domain/json.ts";
import type { Block, OperatorDescriptor, SequenceBlock, Workflow } from "../domain/workflow.ts";
import { MAX_WORKFLOW_BYTES } from "./schema.ts";







const CACHE_VERSION = 1;

export const MANIFEST_CACHE_FILENAME = ".workflow-manifest-cache.json";

interface CachedContract {
  readonly id: string;
  readonly path: string;
  readonly schema?: JsonValue;
}

interface CachedWorkflow {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly overviewPath: string;
  readonly piVisibility: boolean;
  readonly tools?: readonly string[];
  readonly root: SequenceBlock;
  readonly operators: ReadonlyArray<[string, OperatorDescriptor]>;
  readonly contracts: ReadonlyArray<[string, CachedContract]>;
  readonly inputEdges: ReadonlyArray<[string, readonly string[]]>;
}

interface CacheEntry {
  readonly hash: string;
  readonly workflow: CachedWorkflow;
}

interface CacheFile {
  version: number;
  entries: Record<string, CacheEntry>;
}

export interface ManifestCache {
  
  lookup(name: string, digest: string, realRoot: string): Workflow | undefined;
  store(name: string, digest: string, workflow: Workflow): void;
  drop(name: string): void;
  
  flush(): void;
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}


export function manifestDigest(directory: string): string | undefined {
  try {
    const path = join(directory, "WORKFLOW.md");
    if (readFileSync(path).byteLength > MAX_WORKFLOW_BYTES) return undefined;
    return sha256Bytes(readFileSync(path));
  } catch {
    return undefined;
  }
}

function encodeWorkflow(workflow: Workflow): CachedWorkflow {
  return {
    name: workflow.name,
    title: workflow.title,
    description: workflow.description,
    overviewPath: workflow.overviewPath,
    piVisibility: workflow.piVisibility,
    ...(workflow.tools !== undefined ? { tools: workflow.tools } : {}),
    root: workflow.root,
    operators: [...workflow.operators],
    contracts: [...workflow.contracts].map(([id, contract]) => [
      id,
      {
        id: contract.id,
        path: contract.path,
        ...(contract.schema !== undefined ? { schema: contract.schema } : {}),
      },
    ]),
    inputEdges: [...workflow.inputEdges].map(([id, producers]) => [id, [...producers]]),
  };
}

function decodeWorkflow(cached: CachedWorkflow): Workflow {
  const contracts = new Map<string, ContractDescriptor>();
  for (const [id, entry] of cached.contracts) {
    
    contracts.set(id, {
      id: entry.id,
      path: entry.path,
      ...(entry.schema !== undefined ? { schema: entry.schema } : {}),
      validate: compileContract(entry.schema ?? {}, `contracts/${basename(entry.path)}`),
    });
  }
  return {
    name: cached.name,
    title: cached.title,
    description: cached.description,
    overviewPath: cached.overviewPath,
    piVisibility: cached.piVisibility,
    root: cached.root,
    operators: new Map(cached.operators),
    contracts,
    inputEdges: new Map(cached.inputEdges),
    ...(cached.tools !== undefined ? { tools: cached.tools } : {}),
  };
}

function escapesRoot(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

function insideRoot(candidate: string, realRoot: string): boolean {
  try {
    return !escapesRoot(relative(realRoot, realpathSync(candidate)));
  } catch {
    return false;
  }
}

function collectInstructionPaths(block: Block, into: string[]): void {
  switch (block.kind) {
    case "sequence":
      block.children.forEach((child) => collectInstructionPaths(child, into));
      break;
    case "loop":
      collectInstructionPaths(block.body, into);
      break;
    case "task":
      into.push(block.instructionPath);
      break;
  }
}


function trustedEntry(entry: CacheEntry, realRoot: string): boolean {
  const paths: string[] = [entry.workflow.overviewPath];
  for (const [, operator] of entry.workflow.operators) paths.push(operator.path);
  for (const [, contract] of entry.workflow.contracts) paths.push(contract.path);
  collectInstructionPaths(entry.workflow.root, paths);
  return paths.every((candidate) => insideRoot(candidate, realRoot));
}

function readCacheFile(cachePath: string): { entries: Record<string, CacheEntry>; corrupted: boolean } {
  let raw: string;
  try {
    raw = readFileSync(cachePath, "utf8");
  } catch {
    return { entries: {}, corrupted: false }; 
  }
  try {
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed === null || typeof parsed !== "object") throw new Error("cache is not an object");
    if (parsed.version !== CACHE_VERSION) throw new Error("unsupported cache version");
    if (parsed.entries === null || typeof parsed.entries !== "object" || Array.isArray(parsed.entries)) {
      throw new Error("cache entries are not an object");
    }
    return { entries: parsed.entries, corrupted: false };
  } catch {
    return { entries: {}, corrupted: true };
  }
}

function writeCacheFile(cachePath: string, file: CacheFile): void {
  const temp = `${cachePath}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(file));
    renameSync(temp, cachePath);
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      
    }
  }
}

export function openManifestCache(cachePath: string): ManifestCache {
  const loaded = readCacheFile(cachePath);
  const entries: Record<string, CacheEntry> = loaded.entries;
  let dirty = loaded.corrupted;
  return {
    lookup(name, digest, realRoot) {
      const entry = entries[name];
      if (entry === undefined || entry.hash !== digest) return undefined;
      try {
        if (!trustedEntry(entry, realRoot)) return undefined;
        return decodeWorkflow(entry.workflow);
      } catch {
        return undefined; 
      }
    },
    store(name, digest, workflow) {
      entries[name] = { hash: digest, workflow: encodeWorkflow(workflow) };
      dirty = true;
    },
    drop(name) {
      if (entries[name] === undefined) return;
      delete entries[name];
      dirty = true;
    },
    flush() {
      if (!dirty) return;
      writeCacheFile(cachePath, { version: CACHE_VERSION, entries });
      dirty = false;
    },
  };
}
