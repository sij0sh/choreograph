import { controlPrefix } from "./prompts.ts";

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

export function isolateWorkflowContext<T extends IsolatableMessage>(messages: readonly T[], runId: string): T[] | undefined {
  const prefix = controlPrefix(runId);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const text = messageText(message);
    if (text !== undefined && text.startsWith(prefix)) {
      return messages.slice(index);
    }
  }
  return undefined;
}
