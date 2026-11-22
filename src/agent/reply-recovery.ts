import type { Context } from "@earendil-works/chord/context";
import { type EntryRecord, GenerationTask, hook, type HookApi, LiveDoc, ROOT_CONVERSATION_ID, ToolTask } from "@earendil-works/pi-durable";

const marker = "[Pots reply retry]";

const isRetry = (entry: EntryRecord) => entry.kind === "pi.user" && entry.model?.some(
  (message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith(marker),
);

async function replyRun(api: HookApi, context: Context) {
  if (api.conversationId !== ROOT_CONVERSATION_ID) return;
  const live = await api.snapshot(LiveDoc, api.conversationId, context);
  const run = live?.run;
  if (run?.first === undefined) return;
  const wake = await api.entry(run.first, context);
  const data = wake?.kind === "bot.wake" ? wake.data : undefined;
  if (!data || typeof data !== "object" || Array.isArray(data) || !("place" in data) || !("reason" in data)) return;
  const { place, reason } = data;
  if ((reason !== "dm" && reason !== "child") || typeof place !== "string") return;
  const { items, next } = await api.entries({ minEntryId: run.first }, 128, undefined, context);
  if (next) return;
  return { place, items, run, tools: live?.tools, retry: items.some(isRetry) };
}

type ChatRequest = {
  messages?: Array<{ role: string; content?: string | Array<{ type: string; text?: string }> | null }>;
  tools?: Array<{ function?: { name: string } }>;
  chat_template_kwargs?: Record<string, unknown>;
};

/** An oMLX model can finish with private answer text when a one-place DM or child result needs a send. */
export const replyRecovery = hook(GenerationTask, {
  onYield: async (answer, api, context) => {
    if (answer.provider !== "omlx-local" || answer.stopReason !== "stop" ||
        !answer.content.some((part) => part.type === "text" && part.text.trim())) return;
    const found = await replyRun(api, context);
    if (!found || found.run.inputs.length !== 1 || found.retry || found.items.some((entry) => entry.kind === "pi.tool-result")) return;
    return { continue: `${marker} The draft has not been sent. Use send to reply to ${JSON.stringify(found.place)} once. If no reply is needed, use empty text.` };
  },
  beforeProviderRequest: ({ model, payload }, api) => {
    if (api.conversationId !== ROOT_CONVERSATION_ID || model.provider !== "omlx-local" || model.api !== "openai-completions") return;
    const request = payload as ChatRequest | undefined;
    const messages = request?.messages;
    const last = messages?.at(-1);
    if (!messages || last?.role !== "user" || typeof last.content !== "string" || !last.content.startsWith(marker)) return;
    const send = request?.tools?.find((tool) => tool.function?.name === "send");
    const previous = messages.slice(0, -1);
    const draft = previous.findLast((message) => message.role === "assistant")?.content;
    if (!send || typeof draft !== "string" || !draft.trim()) return;
    const trigger = previous.findLast((message) => message.role === "user")?.content;
    const triggerText = typeof trigger === "string" ? trigger
      : Array.isArray(trigger) ? trigger.filter((part) => part.type === "text").map((part) => part.text).join("\n")
      : "";
    return { payload: {
      ...request,
      messages: [
        { role: "system", content: "Deliver the draft with send. Keep the language and relevant content of the draft." },
        { role: "user", content: `${last.content}\n\nRequest: ${triggerText}\n\nDraft: ${draft}` },
      ],
      chat_template_kwargs: { ...request?.chat_template_kwargs, enable_thinking: false },
      tools: [send],
      tool_choice: { type: "function", function: { name: "send" } },
      parallel_tool_calls: false,
    } };
  },
});

export const replyRecoveryTools = hook(ToolTask, {
  beforeTool: async (call, api, context) => {
    const found = await replyRun(api, context);
    if (!found?.retry) return;
    const firstSend = found.tools?.find((slot) => slot.name === "send");
    if (call.name !== "send" || call.id !== firstSend?.callId) return { block: "Only one send is allowed in a reply retry." };
    if (typeof call.arguments.text === "string" && !call.arguments.text.trim()) return { block: "Reply declined." };
    return { arguments: { ...call.arguments, to: found.place } };
  },
  afterTool: async (_call, result, api, context) => {
    const found = await replyRun(api, context);
    return found?.retry ? { ...result, control: { terminate: true } } : undefined;
  },
});
