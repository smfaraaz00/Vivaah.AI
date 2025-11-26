// app/api/chat/route.ts
// @ts-nocheck
import {
  streamText,
  UIMessage,
  convertToModelMessages,
  stepCountIs,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";

import { MODEL } from "@/config";
import { SYSTEM_PROMPT } from "@/prompts";
import { isContentFlagged } from "@/lib/moderation";
import { webSearch } from "./tools/web-search";
import { vectorDatabaseSearch } from "./tools/search-vector-database";

import { createClient } from "@supabase/supabase-js";

/**
 * Robust, defensive chat route implementing:
 *  - vendor mode (semantic vector search + DB enrichment)
 *  - "More details on X" and "Reviews for X"
 *  - conversational summaries + structured JSON sentinel
 *
 * Keep @ts-nocheck for maximum tolerance against type mismatches.
 */

// initialize supabase server client only if env available
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

export const maxDuration = 30;

function getLatestUserText(messages: UIMessage[]): string | null {
  try {
    const latestUserMessage = messages?.filter((m) => m.role === "user").pop();
    if (!latestUserMessage) return null;
    const textParts = latestUserMessage.parts
      .filter((p: any) => p.type === "text")
      .map((part: any) => ("text" in part ? part.text : ""))
      .join("");
    return textParts || null;
  } catch (e) {
    return null;
  }
}

function isVendorQuery(text: string | null): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  const vendorKeywords = [
    "vendor",
    "vendors",
    "caterer",
    "caterers",
    "venue",
    "venues",
    "wedding",
    "photographer",
    "photographers",
    "makeup",
    "decorator",
    "decor",
    "dj",
    "banquet",
    "vendors in",
    "vendors near",
  ];
  const cityKeywords = ["mumbai", "bombay"];
  return vendorKeywords.some((k) => t.includes(k)) || cityKeywords.some((c) => t.includes(c));
}

function parseBudget(text: string | null) {
  try {
    if (!text) return null;
    const m = text.match(/(\d[\d,.]*)\s*(lakh|lakhs|lacs|l|₹|rs|rupees|rupee|inr)?/i);
    if (!m) return null;
    let numRaw = (m[1] || "").replace(/[,]/g, "");
    let num = Number(numRaw);
    if (isNaN(num)) return null;
    const unit = (m[2] || "").toLowerCase();
    if (unit.includes("lakh") || unit === "l" || unit.includes("lacs")) {
      return Math.round(num * 100000);
    }
    return num;
  } catch (e) {
    return null;
  }
}

function parseCategory(text: string | null) {
  if (!text) return null;
  const cats = ["caterer", "caterers", "decorator", "decorators", "venue", "venues", "photographer", "photographers", "dj", "makeup"];
  for (const c of cats) {
    if (text.toLowerCase().includes(c)) return c.replace(/s$/, "");
  }
  return null;
}

function isMoreDetailsQuery(text: string | null) {
  if (!text) return false;
  return /\bmore details on\b|\bdetails on\b|\btell me more about\b/i.test(text);
}

function extractVendorNameFromMoreDetails(text: string | null) {
  if (!text) return null;
  const m = text.match(/\b(?:more details on|details on|tell me more about)\s+(.+)$/i);
  if (m && m[1]) return m[1].trim();
  return null;
}

function isReviewsQuery(text: string | null) {
  if (!text) return false;
  return /\breviews\b|\bratings\b|\bfeedback\b/i.test(text);
}

function extractVendorNameFromReviews(text: string | null) {
  if (!text) return null;
  const m = text.match(/\b(?:reviews of|reviews for|reviews on)\s+(.+)$/i);
  if (m && m[1]) return m[1].trim();
  return null;
}

async function normalizeVectorResults(result: any): Promise<any[]> {
  try {
    if (!result) return [];
    let vendors = [];
    if (Array.isArray(result)) vendors = result;
    else if (Array.isArray(result.vendors) && result.vendors.length) vendors = result.vendors;
    else if (Array.isArray(result.results) && result.results.length) vendors = result.results;
    else if (Array.isArray(result.items) && result.items.length) vendors = result.items;
    else if (Array.isArray(result.matches) && result.matches.length) {
      vendors = result.matches.map((m: any) => ({
        ...(m.metadata ?? {}),
        _score: m.score ?? m.similarity ?? undefined,
        _id: m.id ?? undefined,
      }));
    } else if (Array.isArray(result.hits) && result.hits.length) {
      vendors = result.hits.map((h: any) => ({
        ...(h.document ?? h.payload ?? h.metadata ?? h),
        _score: h.score ?? h._score ?? undefined,
        _id: h.id ?? undefined,
      }));
    } else if (Array.isArray(result.data?.matches)) vendors = result.data.matches;
    else if (Array.isArray(result.metadata?.matches)) vendors = result.metadata.matches;
    else vendors = [];
    return vendors.map((v: any) => (typeof v === "object" ? v : { text: String(v) }));
  } catch (e) {
    return [];
  }
}

type IncomingBody =
  | { messages?: UIMessage[]; [k: string]: any }
  | { message?: string; [k: string]: any };

export async function POST(req: Request) {
  console.log("[chat] request received");

  let body: IncomingBody;
  try {
    body = (await req.json()) as IncomingBody;
  } catch (err) {
    console.error("[chat] failed to parse JSON body:", err);
    return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400 });
  }

  // normalize messages: accept { messages } or { message }
  let messages: UIMessage[] | undefined = undefined;
  if (Array.isArray((body as any).messages)) {
    messages = (body as any).messages as UIMessage[];
  } else if (typeof (body as any).message === "string") {
    messages = [
      {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: (body as any).message }],
      } as any,
    ];
  } else {
    console.error("[chat] no messages or message found in request body:", body);
    return new Response(JSON.stringify({ error: "no messages provided" }), { status: 400 });
  }

  const latestUserText = getLatestUserText(messages) ?? "";
  console.log("[chat] latestUserText:", (latestUserText || "").slice(0, 300));

  // Moderation (defensive)
  try {
    if (latestUserText) {
      const moderationResult = await isContentFlagged(latestUserText);
      if (moderationResult?.flagged) {
        const stream = createUIMessageStream({
          execute({ writer }) {
            const textId = "moderation-denial-text";
            writer.write({ type: "start" });
            writer.write({ type: "text-start", id: textId });
            writer.write({
              type: "text-delta",
              id: textId,
              delta:
                moderationResult.denialMessage ||
                "Your message violates our guidelines. I can't answer that.",
            });
            writer.write({ type: "text-end", id: textId });
            writer.write({ type: "finish" });
          },
        });
        return createUIMessageStreamResponse({ stream });
      }
    }
  } catch (modErr) {
    console.warn("[chat] moderation check failed, continuing:", modErr);
  }

  // Vendor mode
  const vendorMode = isVendorQuery(latestUserText);
  if (vendorMode) {
    console.log("[chat] entering vendor mode");

    const stream = createUIMessageStream({
      async execute({ writer }) {
        const textId = "vendor-response";
        writer.write({ type: "start" });
        writer.write({ type: "text-start", id: textId });

        try {
          const composedQuery = (latestUserText || "").trim();
          console.log("[chat][vendor mode] composedQuery:", composedQuery);

          // Handle "more details" intent
          if (isMoreDetailsQuery(composedQuery)) {
            const vendorName = extractVendorNameFromMoreDetails(composedQuery);
            if (!vendorName) {
              writer.write({ type: "text-delta", id: textId, delta: "Which vendor would you like more details for? Please say 'More details on <name>'." });
            } else {
              // vector search by name (tolerant)
              let searchRes = null;
              try {
                searchRes = await (vectorDatabaseSearch as any).execute?.({ query: vendorName, topK: 8 });
              } catch (e1) {
                try {
                  searchRes = await (vectorDatabaseSearch as any)(vendorName, 8);
                } catch (e2) {
                  console.warn("[chat] vector search for details failed:", e2);
                }
              }
              const vectCandidates = await normalizeVectorResults(searchRes);

              // attempt DB enrichment
              let dbVendor = null;
              try {
                if (supabase) {
                  // prefer vendor_id from metadata
                  const vid = vectCandidates.map((v) => v.vendor_id || v._id || v.id).find(Boolean);
                  if (vid) {
                    const { data } = await supabase.from("vendors").select("*").eq("id", vid).limit(1).maybeSingle();
                    dbVendor = data || null;
                  }
                  if (!dbVendor) {
                    // name-based fallback
                    const { data } = await supabase.from("vendors").select("*").ilike("name", `%${vendorName}%`).limit(1).maybeSingle();
                    dbVendor = data || null;
                  }
                }
              } catch (e) {
                console.warn("[chat] supabase details fetch failed:", e);
              }

              if (dbVendor) {
                const parts = [];
                parts.push(`**${dbVendor.name || "Vendor"}**`);
                if (dbVendor.description) parts.push(dbVendor.description);
                if (dbVendor.city) parts.push(`City: ${dbVendor.city}`);
                if (dbVendor.category) parts.push(`Category: ${dbVendor.category}`);
                if (dbVendor.is_veg !== undefined) parts.push(`Veg-only: ${dbVendor.is_veg ? "Yes" : "No"}`);
                if (dbVendor.price_min || dbVendor.price_max) parts.push(`Price range: ${dbVendor.price_min || "NA"} - ${dbVendor.price_max || "NA"}`);
                if (dbVendor.contact) parts.push(`Contact: ${dbVendor.contact}`);
                if (dbVendor.images && Array.isArray(dbVendor.images) && dbVendor.images.length) parts.push(`Images: ${dbVendor.images.slice(0, 5).join(", ")}`);
                if (dbVendor.rating) parts.push(`Rating: ${dbVendor.rating}/5`);

                // optional: include top 3 reviews
                try {
                  if (dbVendor.id && supabase) {
                    const { data: revs } = await supabase.from("vendor_reviews").select("rating, text, author, created_at").eq("vendor_id", dbVendor.id).order("created_at", { ascending: false }).limit(3);
                    if (revs && revs.length) {
                      parts.push("Recent reviews:");
                      for (const r of revs) parts.push(`- ${r.rating}/5 ${r.author ? `by ${r.author}: ` : ""}${r.text}`);
                    }
                  }
                } catch (e) {
                  // ignore review errors
                }

                writer.write({ type: "text-delta", id: textId, delta: parts.join("\n\n") });
              } else {
                // fallback to web search
                const webRes = await webSearch(vendorName, { limit: 3 }).catch(() => null);
                if (webRes && webRes.length) {
                  const summary = webRes.slice(0, 3).map((r: any, i: number) => `${i + 1}. ${r.title || r.name}\n${r.snippet || r.summary || ""}\n${r.url || ""}`).join("\n\n");
                  writer.write({ type: "text-delta", id: textId, delta: `Couldn't find this vendor in the internal DB. Here's what I found on the web:\n\n${summary}` });
                } else {
                  writer.write({ type: "text-delta", id: textId, delta: `I couldn't find details for "${vendorName}".` });
                }
              }
            }

            writer.write({ type: "text-end", id: textId });
            writer.write({ type: "finish" });
            return;
          }

          // Handle "reviews" intent
          if (isReviewsQuery(composedQuery)) {
            let vendorName = extractVendorNameFromReviews(composedQuery);
            if (!vendorName) {
              // try context from previous assistant message
              const previousAssistant = messages?.slice().reverse().find((m) => m.role === "assistant");
              if (previousAssistant) {
                const txt = (previousAssistant.parts || []).map((p: any) => p.text || "").join(" ");
                const m = txt.match(/^\s*1\.\s*([^\n–-]+)/m);
                if (m && m[1]) vendorName = m[1].trim();
              }
            }
            if (!vendorName) {
              writer.write({ type: "text-delta", id: textId, delta: "Which vendor would you like reviews for? Please say 'Reviews for <vendor name>'. " });
              writer.write({ type: "text-end", id: textId });
              writer.write({ type: "finish" });
              return;
            }

            // Look up in DB first
            try {
              if (supabase) {
                const { data: v } = await supabase.from("vendors").select("id, name").ilike("name", `%${vendorName}%`).limit(1).maybeSingle();
                if (v && v.id) {
                  const { data: revs } = await supabase.from("vendor_reviews").select("rating, text, author, created_at").eq("vendor_id", v.id).order("created_at", { ascending: false }).limit(50);
                  if (revs && revs.length) {
                    const lines = revs.map((r: any) => `- ${r.rating}/5 ${r.author ? `by ${r.author}: ` : ""}${r.text}`);
                    writer.write({ type: "text-delta", id: textId, delta: `Recent reviews for ${v.name}:\n\n${lines.join("\n")}` });
                    writer.write({ type: "text-end", id: textId });
                    writer.write({ type: "finish" });
                    return;
                  }
                }
              }
            } catch (e) {
              console.warn("[chat] reviews DB fetch failed:", e);
            }

            // fallback to web search
            const webRes = await webSearch(vendorName, { limit: 6 }).catch(() => null);
            if (webRes && webRes.length) {
              const snippets = webRes.map((r: any, i: number) => `${i + 1}. ${r.title || r.name}\n${r.snippet || r.summary || ""}\n${r.url || ""}`);
              writer.write({ type: "text-delta", id: textId, delta: `Found these review snippets on the web:\n\n${snippets.join("\n\n")}` });
            } else {
              writer.write({ type: "text-delta", id: textId, delta: `No reviews found for "${vendorName}".` });
            }

            writer.write({ type: "text-end", id: textId });
            writer.write({ type: "finish" });
            return;
          }

          // Generic vendor search path (detect budget/category)
          const budgetVal = parseBudget(composedQuery);
          const categoryVal = parseCategory(composedQuery);
          const looksSpecific = Boolean(budgetVal || categoryVal || /\b(powai|bandra|andheri|khar|juhu|thane|navi mumbai|lower parel|colaba|churchgate)\b/i.test(composedQuery));

          if (!looksSpecific) {
            writer.write({ type: "text-delta", id: textId, delta: "Sure — do you have a category (caterers, decorators, venues), a budget, neighbourhoods, or a style in mind?" });
            writer.write({ type: "text-end", id: textId });
            writer.write({ type: "finish" });
            return;
          }

          // perform semantic search
          const semanticQueryParts = [composedQuery];
          if (categoryVal) semanticQueryParts.push(categoryVal);
          if (budgetVal) semanticQueryParts.push(`budget ${budgetVal}`);
          const semanticQuery = semanticQueryParts.join(" ");

          let searchRes = null;
          try {
            searchRes = await (vectorDatabaseSearch as any).execute?.({ query: semanticQuery, topK: 20 });
          } catch (e1) {
            try {
              searchRes = await (vectorDatabaseSearch as any)(semanticQuery, 20);
            } catch (e2) {
              console.warn("[chat] vector search failed:", e2);
            }
          }

          const vectResults = await normalizeVectorResults(searchRes);

          // collect vendor ids from metadata if present
          const vendorIds = (vectResults || []).map((v: any) => v.vendor_id || v._id || v.id || (v.metadata && (v.metadata.vendor_id || v.metadata.id))).filter(Boolean);

          // DB fetch if possible
          let dbRows = [];
          if (supabase && vendorIds.length) {
            try {
              const { data } = await supabase.from("vendors").select("*").in("id", vendorIds);
              dbRows = data || [];
            } catch (e) {
              console.warn("[chat] supabase fetch by ids failed:", e);
            }
          }

          // name-based fallback lookups if dbRows empty
          if (supabase && dbRows.length === 0 && vectResults.length) {
            const maybeNames = vectResults.slice(0, 6).map((v) => v.name || v.title || v.vendor_name).filter(Boolean);
            for (const nm of maybeNames) {
              try {
                const { data } = await supabase.from("vendors").select("*").ilike("name", `%${nm}%`).limit(3);
                if (data && data.length) dbRows.push(...data);
              } catch (e) {
                // ignore
              }
            }
            // dedupe
            const seen = new Set();
            dbRows = dbRows.filter((r: any) => {
              if (seen.has(r.id)) return false;
              seen.add(r.id);
              return true;
            });
          }

          // merge results preserving vector order
          const idToRow: any = {};
          for (const r of dbRows) idToRow[r.id] = r;
          const merged = [];
          for (const v of vectResults) {
            const id = v.vendor_id || v._id || v.id || (v.metadata && (v.metadata.vendor_id || v.metadata.id));
            if (id && idToRow[id]) merged.push({ ...idToRow[id], _score: v._score ?? v.score ?? v.similarity });
            else merged.push({ ...(v.metadata ?? v), name: v.name ?? v.title ?? v.vendor_name ?? v.provider ?? v.text ?? "Vendor", _score: v._score ?? v.score });
          }
          if (merged.length === 0 && dbRows.length) merged.push(...dbRows);

          // budget filter on merged results if budget provided
          let filtered = merged;
          if (budgetVal) {
            filtered = merged.filter((v: any) => {
              const mn = Number(v.price_min ?? v.min_price ?? v.price_from ?? 0) || 0;
              const mx = Number(v.price_max ?? v.max_price ?? v.price_to ?? 0) || 0;
              if (!mn && !mx) return true;
              if (mn && mx) return budgetVal >= mn && budgetVal <= mx;
              if (mn && !mx) return budgetVal >= mn;
              if (!mn && mx) return budgetVal <= mx;
              return true;
            });
          }

          const top = (filtered.length ? filtered : merged).slice(0, 6);

          // build conversational paragraphs
          const paragraphs = top.map((v: any, idx: number) => {
            const name = v.name ?? v.title ?? v.vendor_name ?? `Vendor ${idx + 1}`;
            const category = v.category ?? "vendor";
            const city = v.city ?? "Mumbai";
            const price = (v.price_min || v.price_max) ? `Price: ${v.price_min ?? "NA"} - ${v.price_max ?? "NA"}` : v.price_range ? `Approx: ${v.price_range}` : "";
            const veg = v.is_veg === true ? "Veg-only" : v.is_veg === false ? "Serves veg & non-veg" : "";
            const rating = v.rating ? `Rated ${v.rating}/5` : "";
            const shortDesc = v.short_description ?? v.description ?? "";
            const unique = v.unique_selling_point ?? v.highlights ?? "";
            const parts = [
              `**${idx + 1}. ${name}** — ${category} in ${city}.`,
              shortDesc ? shortDesc : "",
              unique ? `Why you might pick them: ${unique}` : "",
              price || veg || rating ? `${[price, veg, rating].filter(Boolean).join(" • ")}` : "",
            ].filter(Boolean);
            return parts.join("\n\n");
          });

          const conversational = [
            `I found these vendors that match your request "${composedQuery}". I’ll highlight why each could be a good fit and what to ask next:`,
            "",
            ...paragraphs,
            "",
            `If you want more details on any one, say "More details on <name>" or ask to see reviews.`,
          ].join("\n\n");

          writer.write({ type: "text-delta", id: textId, delta: conversational });

          // structured payload sentinel
          const structured = top.map((v: any) => ({
            id: v.id ?? v.vendor_id ?? v._id ?? null,
            name: v.name ?? v.title ?? v.vendor_name ?? null,
            category: v.category ?? null,
            city: v.city ?? null,
            price_min: v.price_min ?? v.min_price ?? null,
            price_max: v.price_max ?? v.max_price ?? null,
            is_veg: typeof v.is_veg === "boolean" ? v.is_veg : null,
            rating: v.rating ?? null,
            contact: v.contact ?? v.phone ?? null,
            images: Array.isArray(v.images) ? v.images : v.images ? [v.images] : null,
            short_description: v.short_description ?? v.description ?? null,
            raw: v,
          }));

          try {
            writer.write({
              type: "text-delta",
              id: textId,
              delta: `\n\n__VENDOR_HITS_JSON__${JSON.stringify(structured)}__END_VENDOR_HITS_JSON__`,
            });
          } catch (e) {
            console.warn("[chat] failed to write JSON sentinel:", e);
          }
        } catch (err) {
          console.error("[chat][vendor mode] error:", err);
          try {
            writer.write({ type: "text-delta", id: textId, delta: "Something went wrong while fetching vendors. Please try again in a moment." });
          } catch (e) {}
        } finally {
          try {
            writer.write({ type: "text-end", id: textId });
          } catch (e) {}
          try {
            writer.write({ type: "finish" });
          } catch (e) {}
        }
      },
    });

    return createUIMessageStreamResponse({ stream });
  }

  // Normal LLM mode (stream)
  try {
    const result = streamText({
      model: MODEL,
      system: SYSTEM_PROMPT,
      messages: convertToModelMessages(messages),
      tools: { webSearch },
      stopWhen: stepCountIs(10),
      providerOptions: {
        openai: {
          reasoningSummary: "auto",
          reasoningEffort: "low",
          parallelToolCalls: false,
        },
      },
    });

    return result.toUIMessageStreamResponse({ sendReasoning: true });
  } catch (err) {
    console.error("[chat] normal-mode streaming error:", err);
    const stream = createUIMessageStream({
      execute({ writer }) {
        const textId = "fallback-response";
        writer.write({ type: "start" });
        writer.write({ type: "text-start", id: textId });
        writer.write({
          type: "text-delta",
          id: textId,
          delta: "Sorry — I'm having trouble generating a reply right now. Please try again in a few seconds.",
        });
        writer.write({ type: "text-end", id: textId });
        writer.write({ type: "finish" });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }
}
