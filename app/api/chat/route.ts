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

// --------- vendor-specific system prompt ----------
const VENDOR_SYSTEM_PROMPT = `
You are Vivaah, a wedding vendor recommendation assistant.
You must use ONLY the vendor data returned by the "vectorDatabaseSearch" tool as your primary source of truth.
Focus on recommending wedding vendors in Mumbai by default, unless the user clearly specifies another city.
Keep answers under 100 words, be clear and concise.
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
