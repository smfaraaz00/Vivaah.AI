// components/messages/message-wall.tsx
// Named export: MessageWall
// Accepts optional props so parent pages/components can pass data (backwards compatible).

import React, { useEffect, useRef, useMemo } from "react";
import { useChat } from "ai";
import type { UIMessage } from "ai";
import { AssistantMessage } from "./assistant-message";
import { UserMessage } from "./user-message";

/** Props shape your page.tsx appears to pass */
export type MessageWallProps = {
  messages?: UIMessage[]; // optional — if omitted we use useChat().messages
  status?: "error" | "streaming" | "submitted" | "ready" | string;
  durations?: Record<string, number>;
  onDurationChange?: (key: string, duration: number) => void;
};

export function MessageWall(props: MessageWallProps = {}) {
  // If parent provided messages (page.tsx) prefer that; otherwise use hook
  const chat = useChat();
  const messagesFromHook = chat?.messages;
  const messages = props.messages ?? messagesFromHook ?? [];

  // last message id for scroll effect
  const lastMessageId = messages.length ? messages[messages.length - 1].id : null;

  const containerRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll when new messages arrive
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // smooth scrolling; if you want instant use behavior: "auto"
    requestAnimationFrame(() => {
      try {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      } catch {
        el.scrollTop = el.scrollHeight;
      }
    });
  }, [lastMessageId]);

  // stable map of messages to avoid re-render churn in large lists
  const items = useMemo(() => messages.slice(), [messages]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full overflow-y-auto px-6 py-6"
      role="log"
      aria-live="polite"
    >
      <div className="max-w-4xl mx-auto flex flex-col gap-6">
        {items.length === 0 ? (
          <div className="text-center text-sm text-muted-foreground py-8">No messages yet</div>
        ) : (
          items.map((m: UIMessage) => {
            if (m.role === "user") {
              return <UserMessage key={m.id} message={m} />;
            }

            if (m.role === "assistant") {
              // AssistantMessage should handle rendering tool-result events, images, cards, etc.
              return <AssistantMessage key={m.id} message={m} />;
            }

            // fallback for system/other roles
            return (
              <div key={m.id} className="text-sm text-muted-foreground">
                {(m.parts || []).map((p: any, i: number) => (
                  <div key={`${m.id}-part-${i}`}>{p.type === "text" ? p.text : `[${p.type}]`}</div>
                ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
