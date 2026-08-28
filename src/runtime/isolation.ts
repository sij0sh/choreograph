import { controlPrefix, summaryPrefix } from "./prompts.ts";
import { estimateMessageTokens } from "./epoch.ts";

export const HANDOFF_MESSAGE_TYPE = "choreograph-handoff";
export const EPOCH_MESSAGE_TYPE = "choreograph-epoch";

type ContentPart = { type: string; text?: string };

export type IsolatableMessage = { role: string; content?: string | readonly ContentPart[]; customType?: string; details?: unknown; summary?: string };

function messageText(message: IsolatableMessage): string | undefined {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
  }
  return undefined;
}

function isProtected(message: IsolatableMessage, runId?: string): boolean {
  if (message.role === "compactionSummary") {
    return typeof message.summary === "string"
      && message.summary.includes("# Protected workflow handoff capsule")
      && (runId === undefined || message.summary.includes(runId));
  }
  if (message.role !== "custom" || (message.customType !== HANDOFF_MESSAGE_TYPE && message.customType !== EPOCH_MESSAGE_TYPE)) return false;
  const details = message.details && typeof message.details === "object" ? message.details as { runId?: unknown } : undefined;
  return runId === undefined || details?.runId === undefined || details.runId === runId;
}

export function isolateWorkflowContext<T extends IsolatableMessage>(messages: readonly T[], runId: string): T[] | undefined {
  const prefixes = [controlPrefix(runId), summaryPrefix(runId)];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const text = messageText(message);
    if (text !== undefined && prefixes.some((prefix) => text.startsWith(prefix))) {
      let protectedMessages = messages.slice(0, index).filter((candidate) => isProtected(candidate, runId));
      const latestCompaction = protectedMessages.findLastIndex((candidate) => candidate.role === "compactionSummary");
      if (latestCompaction >= 0) protectedMessages = protectedMessages.slice(latestCompaction);
      return [...protectedMessages, ...messages.slice(index)];
    }
  }
  return undefined;
}

export function capWorkflowContext<T extends IsolatableMessage>(messages: readonly T[], tokenBudget: number): T[] {
  if (messages.reduce((total, message) => total + estimateMessageTokens(message), 0) <= tokenBudget) return [...messages];
  const protectedMessages = messages.filter((candidate) => isProtected(candidate));
  const boundary = messages.find((message) => message.role === "user");
  const fixed = [...protectedMessages, ...(boundary && !protectedMessages.includes(boundary) ? [boundary] : [])];
  let used = fixed.reduce((total, message) => total + estimateMessageTokens(message), 0);
  const suffix: T[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (fixed.includes(message)) continue;
    const tokens = estimateMessageTokens(message);
    if (used + tokens > tokenBudget) break;
    suffix.unshift(message);
    used += tokens;
  }
  while (suffix[0]?.role === "toolResult") suffix.shift();
  return [...fixed, ...suffix];
}
