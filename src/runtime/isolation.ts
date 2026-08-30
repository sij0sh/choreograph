import { controlPrefix, summaryPrefix } from "./prompts.ts";

type ContentPart = { type: string; text?: string };

export type IsolatableMessage = { role: string; content?: string | readonly ContentPart[] };

function startsWithAny(text: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => text.startsWith(prefix));
}

// A prefix match on the joined content is decided entirely by the first text
// part (filter preserves order), so no full-text materialization is needed.
function isBoundary(message: IsolatableMessage, prefixes: readonly string[]): boolean {
  if (message.role !== "user") return false;
  const content = message.content;
  if (typeof content === "string") return startsWithAny(content, prefixes);
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === "text" && typeof part.text === "string") return startsWithAny(part.text, prefixes);
    }
  }
  return false;
}

function scanForBoundary<T extends IsolatableMessage>(
  messages: readonly T[],
  prefixes: readonly string[],
  top: number,
  floor: number,
): number | undefined {
  for (let index = top; index >= floor; index -= 1) {
    if (isBoundary(messages[index], prefixes)) return index;
  }
  return undefined;
}

/**
 * The exact current-context slice: everything from the latest workflow control
 * message onward. Nothing from earlier positions survives; there are no
 * protected message types.
 */
export function isolateWorkflowContext<T extends IsolatableMessage>(messages: readonly T[], runId: string): T[] | undefined {
  const prefixes = [controlPrefix(runId), summaryPrefix(runId)];
  const index = scanForBoundary(messages, prefixes, messages.length - 1, 0);
  return index === undefined ? undefined : messages.slice(index);
}

type BoundaryMemo = { runId: string; length: number; boundary: number | undefined; last: IsolatableMessage | undefined };

/**
 * Memoizing isolator for the per-LLM-call context event: repeated calls visit
 * only messages appended since the previous call instead of the full tail
 * (cumulative Theta(T) visits instead of Theta(T^2)). The memo is keyed by the
 * message-array length; a shrink is a truncation/compaction and a runId switch
 * is a transfer/adopt, and both force a full rescan. An unchanged length whose
 * tail message is a different object also forces one (identity lost).
 */
export function createContextIsolator(): <T extends IsolatableMessage>(messages: readonly T[], runId: string) => T[] | undefined {
  let memo: BoundaryMemo | undefined;
  return <T extends IsolatableMessage>(messages: readonly T[], runId: string): T[] | undefined => {
    const prefixes = [controlPrefix(runId), summaryPrefix(runId)];
    const remembered = memo;
    let boundary: number | undefined;
    const identityLost = messages.length === remembered?.length && messages[messages.length - 1] !== remembered.last;
    if (!remembered || remembered.runId !== runId || messages.length < remembered.length || identityLost) {
      boundary = scanForBoundary(messages, prefixes, messages.length - 1, 0);
    } else {
      // Same runId, no shrink: a newer boundary can only sit in the appended tail.
      boundary = scanForBoundary(messages, prefixes, messages.length - 1, remembered.length);
      if (boundary === undefined && remembered.boundary !== undefined) {
        boundary = isBoundary(messages[remembered.boundary], prefixes)
          ? remembered.boundary
          : scanForBoundary(messages, prefixes, messages.length - 1, 0);
      }
    }
    memo = { runId, length: messages.length, boundary, last: messages[messages.length - 1] };
    return boundary === undefined ? undefined : messages.slice(boundary);
  };
}
