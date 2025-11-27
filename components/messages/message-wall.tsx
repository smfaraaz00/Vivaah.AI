// components/messages/message-wall.tsx
"use client";
import React, { useEffect, useRef, useMemo } from "react";
import { useChat } from "ai"; // keep same import as your project uses
import type { UIMessage } from "ai";
import { AssistantMessage } from "./assistant-message";
import { UserMessage } from "./user-message";

type MessageWallProps = {
  messages?: UIMessage[]; // optional — if provided, will be used
  status?: "error" | "streaming" | "submitted" | "ready";
  durations?: Record<string, number>;
  onDurationChange?: (key: string, duration: number) => void;
};

/**
 * MessageWall: compatible with older callers that pass props,
 * and with new callers that rely on useChat().
 */
export function MessageWall(props: MessageWallProps) {
  const chat = useChat();

  // prefer explicit props (keeps backwards compatibility)
  const messages = props.messages ?? (chat?.messages ?? []);
  const status = props.status ?? (chat?.status ?? "ready");

  // Some SDKs/type defs don't include these helpers — use a safe cast to access them
  const chatAny = chat as unknown as any;
  const onDurationChange = props.onDurationChange ?? chatAny?.onDurationChange ?? undefined;
  const durations = props.durations ?? chatAny?.durations ?? {};

  const scrollRef = useRef<HTMLDivElement | null>(null);

  const renderedMessages = useMemo(() => (messages || []).slice(), [messages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // scroll after frame so layout is stable
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [renderedMessages.length]);

  return (
    <div className="message-wall h-full flex flex-col">
      <div
        ref={scrollRef}
        className="messages flex-1 overflow-auto px-4 py-3 space-y-4"
        data-testid="message-wall-scroll"
      >
        {renderedMessages.map((m: UIMessage, i: number) => {
          const role = (m.role ?? "assistant") as string;

          // assemble plaintext from text parts
          const textParts = (m.parts || [])
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text ?? "")
            .join("");

          // detect any tool-result-like part defensively
          const toolPart = (m.parts || []).find((p: any) =>
            ["tool-result", "json", "tool"].includes(p.type)
          );
          // normalize toolResult payload if present
          const toolResult = toolPart ? (toolPart.content ?? toolPart.value ?? toolPart) : null;

          if (role === "user") {
            return <UserMessage key={m.id ?? i} message={m} text={textParts} />;
          } else {
            return (
              <AssistantMessage
                key={m.id ?? i}
                message={m}
                text={textParts}
                toolResult={toolResult}
              />
            );
          }
        })}
      </div>

      <div className="chat-status px-4 py-2 border-t text-sm text-muted-foreground">
        <div className="flex items-center justify-between">
          <div>
            {status === "streaming" && <span>Assistant is typing…</span>}
            {status === "error" && <span className="text-red-500">Error</span>}
            {status === "ready" && <span>Connected</span>}
            {status === "submitted" && <span>Sending…</span>}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => (chatAny?.clear ? chatAny.clear() : undefined)}
              className="text-xs underline"
              title="Clear chat"
            >
              Clear
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
