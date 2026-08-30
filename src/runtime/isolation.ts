import { controlPrefix, summaryPrefix } from "./prompts.ts";

type ContentPart = { type: string; text?: string };

export type IsolatableMessage = { role: string; content?: string | readonly ContentPart[] };

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

/**
 * The exact current-context slice: everything from the latest workflow control
 * message onward. Nothing from earlier positions survives; there are no
 * protected message types.
 */
export function isolateWorkflowContext<T extends IsolatableMessage>(messages: readonly T[], runId: string): T[] | undefined {
  const prefixes = [controlPrefix(runId), summaryPrefix(runId)];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const text = messageText(message);
    if (text !== undefined && prefixes.some((prefix) => text.startsWith(prefix))) {
      return messages.slice(index);
    }
  }
  return undefined;
}
