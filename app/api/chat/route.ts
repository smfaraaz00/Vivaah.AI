import {
  streamText,
  UIMessage,
  convertToModelMessages,
  stepCountIs,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from 'ai';
import type { ToolSet } from 'ai';

import { MODEL } from '@/config';
import { SYSTEM_PROMPT } from '@/prompts';
import { isContentFlagged } from '@/lib/moderation';
import { webSearch } from './tools/web-search';
import { vectorDatabaseSearch } from './tools/search-vector-database';

export const maxDuration = 30;

// --------- helper to extract latest user text ----------
function getLatestUserText(messages: UIMessage[]): string | null {
  const latestUserMessage = messages
    .filter((msg) => msg.role === 'user')
    .pop();

  if (!latestUserMessage) return null;

  const textParts = latestUserMessage.parts
    .filter((part) => part.type === 'text')
    .map((part) => ('text' in part ? part.text : ''))
    .join('');

  return textParts || null;
}

// --------- vendor query detection ----------
function isVendorQuery(text: string | null): boolean {
  if (!text) return false;
  const t = text.toLowerCase();

  const vendorKeywords = [
    'vendor',
    'caterer',
    'venue',
    'wedding',
    'photographer',
    'makeup',
    'decorator',
    'dj',
    'banquet',
  ];
  const cityKeywords = ['mumbai', 'bombay'];

  return (
    vendorKeywords.some((k) => t.includes(k)) ||
    cityKeywords.some((c) => t.includes(c))
  );
}

const VENDOR_SYSTEM_PROMPT = `
You are Vivaah, a wedding vendor recommendation assistant.

When the user asks anything related to wedding vendors, you MUST:
1. Call the "vectorDatabaseSearch" tool ONCE using the user's latest request as the "query" argument (and a suitable topK, e.g. 5), before you answer.
2. Use ONLY the vendors returned by that tool as your primary source of truth.
3. If the tool returns one or more vendors, recommend specific vendors by name with 2–3 key details (category, location, price range, or description). Do NOT stay generic or only ask clarifying questions.
4. If the tool returns an empty list, say clearly that you currently do not have matching vendors in the database and ask a short follow-up question if needed. Never invent or guess vendor names.

Assume Mumbai by default unless the user clearly specifies another city.
Keep answers under 100 words and be clear and concise.
`.trim();


// ================== MAIN HANDLER ==================
export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const latestUserText = getLatestUserText(messages);

  // --------- Moderation ----------
  if (latestUserText) {
    const moderationResult = await isContentFlagged(latestUserText);

    if (moderationResult.flagged) {
      const stream = createUIMessageStream({
        execute({ writer }) {
          const textId = 'moderation-denial-text';

          writer.write({ type: 'start' });

          writer.write({
            type: 'text-start',
            id: textId,
          });

          writer.write({
            type: 'text-delta',
            id: textId,
            delta:
              moderationResult.denialMessage ||
              "Your message violates our guidelines. I can't answer that.",
          });

          writer.write({
            type: 'text-end',
            id: textId,
          });

          writer.write({ type: 'finish' });
        },
      });

      return createUIMessageStreamResponse({ stream });
    }
  }

  // --------- decide mode (vendor vs normal) ----------
  const vendorMode = isVendorQuery(latestUserText);
  const systemPrompt = vendorMode ? VENDOR_SYSTEM_PROMPT : SYSTEM_PROMPT;

  // --------- tools selection with explicit typing ----------
  let tools: ToolSet | undefined;

  if (vendorMode) {
    tools = { webSearch, vectorDatabaseSearch };
  } else {
    tools = { webSearch };
  }

  const result = streamText({
    model: MODEL,
    system: systemPrompt,
    messages: convertToModelMessages(messages),
    tools,
    stopWhen: stepCountIs(10),
    providerOptions: {
      openai: {
        reasoningSummary: 'auto',
        reasoningEffort: 'low',
        parallelToolCalls: false,
      },
    },
  });

  return result.toUIMessageStreamResponse({
    sendReasoning: true,
  });
}
