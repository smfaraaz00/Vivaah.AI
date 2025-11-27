// components/messages/message-wall.tsx
"use client";
import React, { useEffect, useRef, useMemo } from "react";
import { useChat } from "@ai-sdk/react"; // <-- correct package for hook
import type { UIMessage } from "ai";
import { AssistantMessage } from "./assistant-message";
import { UserMessage } from "./user-message";

/**
 * Simple MessageWall that consumes useChat() messages and renders them.
 * Exports a named MessageWall so page.tsx's `import { MessageWall }` works.
 *
 * This component intentionally avoids printing any raw JSON sentinels
 * into the visible chat stream — structured payloads (tool-result)
 * are passed to AssistantMessage via props for UI rendering.
 */

export function MessageWall() {
  const { messages, status, clear } = useChat();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Flatten messages to a stable array for rendering
  const renderedMessages = useMemo(() => (messages || []).slice(), [messages]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // small timeout to allow DOM to update
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
          const role = m.role ?? "assistant";
          // combine text parts into one string
          const textParts = (m.parts || [])
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text ?? "")
            .join("");

          // find any tool-result parts (the streaming protocol writes tool-result events separately)
          // In some SDKs tool results come as `parts` too; handle conservatively:
          const toolResultPart = (m.parts || []).find((p: any) => p.type === "tool-result" || p.type === "json");
          const toolResult = toolResultPart ? toolResultPart.content ?? toolResultPart.value ?? toolResultPart : null;

          // Provide both the raw message and parsed tool result to AssistantMessage so it can render cards/rows.
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
              onClick={() => clear?.()}
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
