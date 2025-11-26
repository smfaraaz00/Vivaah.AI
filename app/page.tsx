"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import * as z from "zod";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useChat } from "@ai-sdk/react";
import { ArrowUp, Loader2, Plus, Square } from "lucide-react";
import { MessageWall } from "@/components/messages/message-wall";
import { ChatHeader, ChatHeaderBlock } from "@/app/parts/chat-header";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { UIMessage } from "ai";
import { useEffect, useState, useRef } from "react";
import { AI_NAME, CLEAR_CHAT_TEXT, OWNER_NAME, WELCOME_MESSAGE } from "@/config";
import Image from "next/image";
import Link from "next/link";

import { getOrCreateSessionKey } from "@/lib/session-client";

const formSchema = z.object({
  message: z.string().min(1).max(2000),
});

const STORAGE_KEY = "chat-messages";

export default function Chat() {
  const [isClient, setIsClient] = useState(false);
  const welcomeMessageShownRef = useRef(false);
  const [durations, setDurations] = useState<Record<string, number>>({});

  const stored =
    typeof window !== "undefined"
      ? JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")
      : { messages: [], durations: {} };

  const [initialMessages] = useState<UIMessage[]>(stored.messages || []);

  const { messages, sendMessage, status, stop, setMessages } = useChat({
    messages: initialMessages,
  });

  useEffect(() => {
    setIsClient(true);
    setDurations(stored.durations || {});
    setMessages(stored.messages || []);
  }, []);

  useEffect(() => {
    if (isClient) {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ messages, durations })
      );
    }
  }, [messages, durations, isClient]);

  useEffect(() => {
    if (
      isClient &&
      initialMessages.length === 0 &&
      !welcomeMessageShownRef.current
    ) {
      const welcomeMsg: UIMessage = {
        id: `welcome-${Date.now()}`,
        role: "assistant",
        parts: [{ type: "text", text: WELCOME_MESSAGE }],
      };
      setMessages([welcomeMsg]);
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ messages: [welcomeMsg], durations: {} })
      );
      welcomeMessageShownRef.current = true;
    }
  }, [isClient, initialMessages.length, setMessages]);

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { message: "" },
  });

  const clearChat = () => {
    setMessages([]);
    setDurations({});
    localStorage.removeItem(STORAGE_KEY);
    toast.success("Chat cleared");
  };

  function onSubmit(data: z.infer<typeof formSchema>) {
    // Add sessionKey to every outgoing chat message
    sendMessage({ text: data.message, sessionKey: getOrCreateSessionKey() });
    form.reset();
  }

  return (
    <div className="flex h-screen justify-center items-center">
      <main className="w-full h-screen relative">

        {/* ===== Header with gold underline ===== */}
        <div className="fixed top-0 left-0 right-0 z-50 bg-[var(--cream-bg)] border-b-[2px] border-[var(--gold-1)] shadow-sm">
          <ChatHeader>
            <ChatHeaderBlock />
            <ChatHeaderBlock className="justify-center items-center gap-2">
              <Avatar className="size-8 ring-2 ring-[var(--gold-1)]">
                <AvatarImage src="/logo.png" />
                <AvatarFallback>
                  <Image src="/logo.png" alt="Logo" width={36} height={36} />
                </AvatarFallback>
              </Avatar>
              <p className="tracking-tight font-semibold text-[var(--text-maroon)]">
                Chat with {AI_NAME}
              </p>
            </ChatHeaderBlock>

            <ChatHeaderBlock className="justify-end">
              <Button
                variant="outline"
                size="sm"
                className="border-[var(--gold-1)] text-[var(--text-maroon)] rounded-full px-3 py-1"
                onClick={clearChat}
              >
                <Plus className="size-4" />
                {CLEAR_CHAT_TEXT}
              </Button>
            </ChatHeaderBlock>
          </ChatHeader>
        </div>

        {/* ===== Messages ===== */}
        <div className="h-screen overflow-y-auto px-5 py-4 pt-[100px] pb-[150px]">
          <div className="flex flex-col items-center">
            {isClient ? (
              <>
                <MessageWall
                  messages={messages}
                  status={status}
                  durations={durations}
                  onDurationChange={(d, k) => {}}
                />
                {status === "submitted" && (
                  <Loader2 className="size-4 animate-spin text-[var(--text-maroon)]" />
                )}
              </>
            ) : (
              <Loader2 className="size-4 animate-spin text-[var(--text-maroon)]" />
            )}
          </div>
        </div>

        {/* ===== Input Bar (Cream + Gold) ===== */}
        <div className="fixed bottom-0 left-0 right-0 z-50 bg-[var(--cream-bg)] pb-4 pt-3 border-t-2 border-[var(--gold-1)]">
          <div className="max-w-3xl mx-auto px-5">
            <form id="chat-form" onSubmit={form.handleSubmit(onSubmit)}>
              <FieldGroup>
                <Controller
                  name="message"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel className="sr-only">Message</FieldLabel>
                      <div className="relative">
                        <Input
                          {...field}
                          placeholder="Type your message..."
                          className="h-14 rounded-2xl pl-5 pr-16 bg-white border-[var(--gold-1)] shadow-sm"
                          disabled={status === "streaming"}
                        />

                        {(status === "ready" || status === "error") && (
                          <Button
                            type="submit"
                            disabled={!field.value.trim()}
                            size="icon"
                            className="absolute right-3 top-3"
                          >
                            <ArrowUp className="size-4 text-white" />
                          </Button>
                        )}

                        {(status === "streaming" ||
                          status === "submitted") && (
                          <Button
                            size="icon"
                            className="absolute right-3 top-3 bg-[var(--gold-2)]"
                            onClick={() => stop()}
                          >
                            <Square className="size-4 text-white" />
                          </Button>
                        )}
                      </div>
                    </Field>
                  )}
                />
              </FieldGroup>
            </form>
          </div>

          <div className="text-xs text-[var(--text-maroon)] opacity-70 text-center pt-2">
            © {new Date().getFullYear()} {OWNER_NAME} •{" "}
            <Link href="/terms" className="underline">
              Terms
            </Link>
            • Powered by Vivaah AI
          </div>
        </div>

      </main>
    </div>
  );
}
