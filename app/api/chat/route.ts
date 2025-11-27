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
import { getVendorDetails } from "@/lib/db/getVendorDetails";

/**
 * Chat route with:
 * - vendor mode (vector search + DB enrichment)
 * - "More details" and "Reviews"
 * - GUIDE flow for curated guides (structured events + pretty text)
 */

// Safe supabase getter — avoid creating client at module load time (prevents build error)
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SERVICE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    null;

  if (!url || !key) {
    // return null when not configured — route should gracefully handle null supabase
    return null;
  }

  return createClient(url, key);
}

export const maxDuration = 30;

// Toggle to enable raw JSON sentinels in the text stream (for debugging). Default: off.
const EMIT_JSON_SENTINELS = process.env.EMIT_JSON_SENTINELS === "1";

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
    "best caterers",
    "top caterers",
    "guide",
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

function isGuideQuery(text: string | null) {
  if (!text) return false;
  const t = text.toLowerCase();
  return /\b(guide|best|top|recommend|who should i|find me|best caterers|top caterers|guide to)\b/.test(t)
    && /\bcaterer|caterers|vendors|venues\b/.test(t);
}

// Normalizes many possible vector DB shapes into a flat list of objects
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
        _score: (m.score ?? m.similarity) ?? undefined,
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

// Safe wrapper to call OpenAI Chat Completions directly via fetch (optional)
async function callOpenAIChat(prompt: string, opts: { model?: string; max_tokens?: number } = {}) {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const model = opts.model || "gpt-4o-mini";
    const body = {
      model,
      messages: [
        { role: "system", content: "You are a strict editor. Do not hallucinate. Use only provided facts." },
        { role: "user", content: prompt },
      ],
      max_tokens: opts.max_tokens ?? 800,
      temperature: 0.0,
    };
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn("[openai] non-ok response:", res.status, txt);
      return null;
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content ?? null;
    return content;
  } catch (e) {
    console.warn("[openai] call failed:", e);
    return null;
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

  // initialize supabase client at runtime
  const supabase = getSupabase();

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

          // ---------- GUIDE flow ----------
          if (isGuideQuery(composedQuery)) {
            try {
              const category = parseCategory(composedQuery) || "caterer";
              // Determine city if present in query, default to Mumbai
              const cityMatch = composedQuery.match(/\b(mumbai|bombay)\b/i);
              const city = cityMatch ? cityMatch[1] : "Mumbai";

              // Fetch curated vendor lists (lightweight queries)
              // Note: These are heuristics — you can refine later to use ranking function
              const luxuryQ = supabase
                ? supabase
                    .from("vendors")
                    .select("id, name, short_description, min_price, max_price, currency, city, category, avg_rating, rating_count")
                    .eq("category", category)
                    .ilike("city", `%${city}%`)
                    .order("avg_rating", { ascending: false })
                    .limit(6)
                : { data: [] };
              const vegQ = supabase
                ? supabase
                    .from("vendors")
                    .select("id, name, short_description, min_price, max_price, currency, city, category, avg_rating, rating_count")
                    .eq("category", category)
                    .ilike("city", `%${city}%`)
                    .ilike("short_description", "%veg%")
                    .order("avg_rating", { ascending: false })
                    .limit(6)
                : { data: [] };
              const regionalQ = supabase
                ? supabase
                    .from("vendors")
                    .select("id, name, short_description, min_price, max_price, currency, city, category, avg_rating, rating_count")
                    .eq("category", category)
                    .ilike("city", `%${city}%`)
                    .order("rating_count", { ascending: false })
                    .limit(8)
                : { data: [] };
              const budgetQ = supabase
                ? supabase
                    .from("vendors")
                    .select("id, name, short_description, min_price, max_price, currency, city, category, avg_rating, rating_count")
                    .eq("category", category)
                    .ilike("city", `%${city}%`)
                    .order("min_price", { ascending: true })
                    .limit(8)
                : { data: [] };

              const [luxRes, vegRes, regRes, budRes] = await Promise.all([luxuryQ, vegQ, regionalQ, budgetQ]);

              const luxury = (luxRes?.data || []).slice(0, 6);
              const veg = (vegRes?.data || []).slice(0, 6);
              const regional = (regRes?.data || []).slice(0, 6);
              const budget = (budRes?.data || []).slice(0, 6);

              // Build factual JSON facts (minimal)
              const facts = {
                city,
                category,
                buckets: {
                  ultra_luxury: luxury.map((v: any) => ({
                    id: v.id,
                    name: v.name,
                    short_description: v.short_description,
                    min_price: v.min_price,
                    max_price: v.max_price,
                    currency: v.currency,
                    avg_rating: v.avg_rating,
                    rating_count: v.rating_count,
                  })),
                  pure_veg: veg.map((v: any) => ({
                    id: v.id,
                    name: v.name,
                    short_description: v.short_description,
                    min_price: v.min_price,
                    max_price: v.max_price,
                    currency: v.currency,
                    avg_rating: v.avg_rating,
                    rating_count: v.rating_count,
                  })),
                  regional: regional.map((v: any) => ({
                    id: v.id,
                    name: v.name,
                    short_description: v.short_description,
                    min_price: v.min_price,
                    max_price: v.max_price,
                    currency: v.currency,
                    avg_rating: v.avg_rating,
                    rating_count: v.rating_count,
                  })),
                  budget: budget.map((v: any) => ({
                    id: v.id,
                    name: v.name,
                    short_description: v.short_description,
                    min_price: v.min_price,
                    max_price: v.max_price,
                    currency: v.currency,
                    avg_rating: v.avg_rating,
                    rating_count: v.rating_count,
                  })),
                },
              };

              // Build prompt for polishing but warn model not to hallucinate
              const prompt = `
You are an editor. Use ONLY the factual vendor data in the JSON block below to create a concise, human-friendly guide titled "Top wedding ${category}s in ${city}".
- Produce sections: Ultra-Luxury Tier, Pure Vegetarian, Regional Specialties, Mid-range / Affordable.
- For each vendor include: Name (bold), 1-sentence refined descriptor derived strictly from short_description, and an Estimated Price (min-max + currency). If price fields missing, write "Price not provided".
- After sections, provide 3 brief insider tips (no more than 1 sentence each).
- Do NOT add facts not present in the JSON. If a field is missing, write "Details not provided".
- Output two pieces concatenated, separated by the sentinel line: "___GUIDE_JSON___" then a JSON object:
{
  "title": "...",
  "sections": [
    {"name":"Ultra-Luxury Tier","vendors":[ { "name":"", "descriptor":"", "price":"", "id":"" }, ... ] },
    ...
  ],
  "insider_tips": ["...", "...", "..."]
}
- After that sentinel, output the human-readable guide as plain text for display.

FACTS:
${JSON.stringify(facts)}
`;

              // Call OpenAI if key present, else fallback to DB-only formatted text
              const llmResp = await callOpenAIChat(prompt, { model: "gpt-4o-mini", max_tokens: 900 });

              // Helper: emit human text and structured guide event separately
              const emitGuideHumanAndJson = async (humanText: string | null, guideJson: any) => {
                // Write human text first (if present)
                if (humanText && humanText.trim()) {
                  writer.write({ type: "text-delta", id: textId, delta: humanText.trim() });
                } else {
                  // if no human text, write a simple header
                  writer.write({ type: "text-delta", id: textId, delta: `Top wedding ${category}s in ${city}` });
                }

                // Emit structured guide event so client can render cards/UI (not visible as chat text)
                try {
                  writer.write({
                    type: "tool-result",
                    id: textId,
                    tool: "guide",
                    result: guideJson,
                  });
                } catch (e) {
                  console.warn("[guide] failed to emit structured guide:", e);
                }

                // Emit raw JSON sentinel into chat only if debug flag enabled
                if (EMIT_JSON_SENTINELS) {
                  try {
                    writer.write({
                      type: "text-delta",
                      id: textId,
                      delta: `\n\n___GUIDE_JSON___${JSON.stringify(guideJson)}___END_GUIDE_JSON___`,
                    });
                  } catch (e) {
                    console.warn("[guide] failed to emit guide JSON sentinel:", e);
                  }
                }
              };

              if (llmResp) {
                // If LLM returned the sentinel + text, split and emit separately
                const sentinelIndex = llmResp.indexOf("___GUIDE_JSON___");
                if (sentinelIndex >= 0) {
                  const humanPart = llmResp.slice(0, sentinelIndex).trim();
                  const jsonPartRaw = llmResp.slice(sentinelIndex);
                  // Attempt to extract JSON substring
                  const start = jsonPartRaw.indexOf("___GUIDE_JSON___");
                  const end = jsonPartRaw.indexOf("___END_GUIDE_JSON___");
                  let guideJsonObj = null;
                  if (start >= 0 && end >= 0) {
                    const jsonStr = jsonPartRaw.slice(start + "___GUIDE_JSON___".length, end).trim();
                    try {
                      guideJsonObj = JSON.parse(jsonStr);
                    } catch (e) {
                      guideJsonObj = null;
                    }
                  }
                  // Emit human and structured guide event (with fallback)
                  await emitGuideHumanAndJson(humanPart || null, guideJsonObj || {
                    title: `Top wedding ${category}s in ${city}`,
                    sections: [
                      { name: "Ultra-Luxury Tier", vendors: luxury.map((v: any) => ({ id: v.id, name: v.name, descriptor: v.short_description || "Details not provided", price: v.min_price ? `${v.min_price} - ${v.max_price ?? ""} ${v.currency ?? ""}` : "Price not provided" })) },
                      { name: "Pure Vegetarian", vendors: veg.map((v: any) => ({ id: v.id, name: v.name, descriptor: v.short_description || "Details not provided", price: v.min_price ? `${v.min_price} - ${v.max_price ?? ""} ${v.currency ?? ""}` : "Price not provided" })) },
                      { name: "Regional Specialties", vendors: regional.map((v: any) => ({ id: v.id, name: v.name, descriptor: v.short_description || "Details not provided", price: v.min_price ? `${v.min_price} - ${v.max_price ?? ""} ${v.currency ?? ""}` : "Price not provided" })) },
                      { name: "Mid-range / Affordable", vendors: budget.map((v: any) => ({ id: v.id, name: v.name, descriptor: v.short_description || "Details not provided", price: v.min_price ? `${v.min_price} - ${v.max_price ?? ""} ${v.currency ?? ""}` : "Price not provided" })) },
                    ],
                    insider_tips: ["Ask for floating crowd adjustments.", "Use live stations to boost perceived quality.", "Check venue tie-ups before confirming outside caterers."],
                  });
                } else {
                  // LLM returned only human text (no sentinel). Emit human text, then structured guide event
                  const guideJson = {
                    title: `Top wedding ${category}s in ${city}`,
                    sections: [
                      { name: "Ultra-Luxury Tier", vendors: luxury.map((v: any) => ({ id: v.id, name: v.name, descriptor: v.short_description || "Details not provided", price: v.min_price ? `${v.min_price} - ${v.max_price ?? ""} ${v.currency ?? ""}` : "Price not provided" })) },
                      { name: "Pure Vegetarian", vendors: veg.map((v: any) => ({ id: v.id, name: v.name, descriptor: v.short_description || "Details not provided", price: v.min_price ? `${v.min_price} - ${v.max_price ?? ""} ${v.currency ?? ""}` : "Price not provided" })) },
                      { name: "Regional Specialties", vendors: regional.map((v: any) => ({ id: v.id, name: v.name, descriptor: v.short_description || "Details not provided", price: v.min_price ? `${v.min_price} - ${v.max_price ?? ""} ${v.currency ?? ""}` : "Price not provided" })) },
                      { name: "Mid-range / Affordable", vendors: budget.map((v: any) => ({ id: v.id, name: v.name, descriptor: v.short_description || "Details not provided", price: v.min_price ? `${v.min_price} - ${v.max_price ?? ""} ${v.currency ?? ""}` : "Price not provided" })) },
                    ],
                    insider_tips: ["Ask for floating crowd adjustments.", "Use live stations to boost perceived quality.", "Check venue tie-ups before confirming outside caterers."],
                  };
                  await emitGuideHumanAndJson(llmResp, guideJson);
                }
              } else {
                // fallback: deterministic textual guide built from facts (human text)
                const fallback = [];
                fallback.push(`Top wedding ${category}s in ${city}\n`);
                fallback.push("Ultra-Luxury Tier:");
                luxury.forEach((v: any) =>
                  fallback.push(`- **${v.name}** — ${v.short_description || "Details not provided"}. Price: ${v.min_price ?? "Price not provided"} - ${v.max_price ?? ""} ${v.currency ?? ""}`)
                );
                fallback.push("\nPure Vegetarian:");
                veg.forEach((v: any) =>
                  fallback.push(`- **${v.name}** — ${v.short_description || "Details not provided"}. Price: ${v.min_price ?? "Price not provided"} - ${v.max_price ?? ""} ${v.currency ?? ""}`)
                );
                fallback.push("\nRegional Specialties:");
                regional.forEach((v: any) =>
                  fallback.push(`- **${v.name}** — ${v.short_description || "Details not provided"}. Price: ${v.min_price ?? "Price not provided"} - ${v.max_price ?? ""} ${v.currency ?? ""}`)
                );
                fallback.push("\nMid-range / Affordable:");
                budget.forEach((v: any) =>
                  fallback.push(`- **${v.name}** — ${v.short_description || "Details not provided"}. Price: ${v.min_price ?? "Price not provided"} - ${v.max_price ?? ""} ${v.currency ?? ""}`)
                );
                fallback.push("\nInsider tips:\n- Ask for floating crowd adjustments.\n- Use live stations to boost perceived quality.\n- Check venue tie-ups with your venue first.");

                const guideJson = {
                  title: `Top wedding ${category}s in ${city}`,
                  sections: [
                    { name: "Ultra-Luxury Tier", vendors: luxury.map((v: any) => ({ id: v.id, name: v.name, descriptor: v.short_description || "Details not provided", price: v.min_price ? `${v.min_price} - ${v.max_price ?? ""} ${v.currency ?? ""}` : "Price not provided" })) },
                    { name: "Pure Vegetarian", vendors: veg.map((v: any) => ({ id: v.id, name: v.name, descriptor: v.short_description || "Details not provided", price: v.min_price ? `${v.min_price} - ${v.max_price ?? ""} ${v.currency ?? ""}` : "Price not provided" })) },
                    { name: "Regional Specialties", vendors: regional.map((v: any) => ({ id: v.id, name: v.name, descriptor: v.short_description || "Details not provided", price: v.min_price ? `${v.min_price} - ${v.max_price ?? ""} ${v.currency ?? ""}` : "Price not provided" })) },
                    { name: "Mid-range / Affordable", vendors: budget.map((v: any) => ({ id: v.id, name: v.name, descriptor: v.short_description || "Details not provided", price: v.min_price ? `${v.min_price} - ${v.max_price ?? ""} ${v.currency ?? ""}` : "Price not provided" })) },
                  ],
                  insider_tips: ["Ask for floating crowd adjustments.", "Use live stations to boost perceived quality.", "Check venue tie-ups before confirming outside caterers."],
                };

                // Emit human and structured guide event
                await emitGuideHumanAndJson(fallback.join("\n\n"), guideJson);
              }

              writer.write({ type: "text-end", id: textId });
              writer.write({ type: "finish" });
              return;
            } catch (e) {
              console.warn("[guide] failure:", e);
              writer.write({ type: "text-delta", id: textId, delta: "Sorry — I couldn't assemble the guide right now. Try again." });
              writer.write({ type: "text-end", id: textId });
              writer.write({ type: "finish" });
              return;
            }
          }

          // ---------- MORE DETAILS flow ----------
          if (isMoreDetailsQuery(composedQuery)) {
            const vendorName = extractVendorNameFromMoreDetails(composedQuery);
            if (!vendorName) {
              writer.write({ type: "text-delta", id: textId, delta: "Which vendor would you like more details for? Please say 'More details on <name>'." });
              writer.write({ type: "text-end", id: textId });
              writer.write({ type: "finish" });
              return;
            }

            // vector-search tolerant lookup
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

            let details = null;
            try {
              const vid = vectCandidates.map((v) => v.vendor_id || v._id || v.id).find(Boolean);
              if (vid) {
                details = await getVendorDetails(String(vid));
              }
              if (!details && supabase) {
                const { data: found } = await supabase.from("vendors").select("id, name").ilike("name", `%${vendorName}%`).limit(1).maybeSingle();
                if (found && found.id) details = await getVendorDetails(String(found.id));
              }
            } catch (e) {
              console.warn("[chat] getVendorDetails lookup failed:", e);
            }

            if (details && details.vendor) {
              const v = details.vendor || {};
              const parts = [];

              // Title
              parts.push(`**${v.name || "Vendor"}**`);

              // Description (prefer short_description)
              if (v.short_description) parts.push(v.short_description);
              else if (v.long_description) parts.push(v.long_description);

              // Price line: from offers or vendor columns
              try {
                let priceLine = "";
                if (details.offers && details.offers.length) {
                  const offer = details.offers[0];
                  const p = offer.price ? `${offer.price} ${offer.currency || details.vendor.currency || "INR"}` : null;
                  if (p) priceLine = `Example offer: ${offer.title || ""} — ${p}`;
                } else {
                  const mn = v.min_price ?? v.minPrice ?? null;
                  const mx = v.max_price ?? v.maxPrice ?? null;
                  if (mn || mx) priceLine = `Price range: ${mn ?? "NA"} - ${mx ?? "NA"} ${v.currency ?? "INR"}`;
                }
                if (priceLine) parts.push(priceLine);
              } catch (e) {}

              // City, category, capacity, contact
              if (v.city) parts.push(`City: ${v.city}`);
              if (v.category) parts.push(`Category: ${v.category}`);
              if (v.capacity) parts.push(`Capacity: ${v.capacity}`);
              if (v.phone) parts.push(`Contact: ${v.phone}`);

              // Images (list urls)
              if (details.images && details.images.length) {
                const imgs = details.images.slice(0, 5).map((i: any) => i.url).filter(Boolean);
                if (imgs.length) parts.push(`Images: ${imgs.join(", ")}`);
              }

              // Stats
              if (details.stats) {
                const avg = details.stats.avg_rating ?? v.avg_rating ?? v.avgRating ?? null;
                const cnt = details.stats.review_count ?? v.rating_count ?? v.ratingCount ?? null;
                if (avg !== null || cnt !== null) parts.push(`Rating: ${avg ?? "N/A"} / 5 (${cnt ?? 0} reviews)`);
              }

              // Top reviews
              if (details.top_reviews && details.top_reviews.length) {
                parts.push("Recent reviews:");
                for (const r of details.top_reviews.slice(0, 3)) {
                  const body = r.body ?? r.text ?? "";
                  parts.push(`- ${r.rating ?? "N/A"}/5 ${r.reviewer_name ? `by ${r.reviewer_name}: ` : ""}${(r.title ? r.title + " - " : "")}${body}`);
                }
              }

              // Emit human readable text (no raw JSON in chat)
              writer.write({ type: "text-delta", id: textId, delta: parts.join("\n\n") });

              // Emit structured vendor_details event for client UI rendering
              try {
                const payload = {
                  type: "vendor_details",
                  vendor_id: v.id ?? null,
                  name: v.name ?? null,
                  refined_short_description: v.short_description ?? null,
                  price_range:
                    (v.min_price || v.max_price) ? `${v.min_price ?? "NA"} - ${v.max_price ?? "NA"} ${v.currency ?? "INR"}` : null,
                  city: v.city ?? null,
                  avg_rating: details.stats?.avg_rating ?? v.avg_rating ?? null,
                  review_count: details.stats?.review_count ?? v.rating_count ?? null,
                  top_reviews: (details.top_reviews || []).slice(0, 5).map((r: any) => ({ rating: r.rating, title: r.title, body: r.body ?? r.text, reviewer_name: r.reviewer_name })),
                  images: (details.images || []).slice(0, 10).map((i: any) => ({ url: i.url, caption: i.caption, is_main: i.is_main })),
                  offers: (details.offers || []).slice(0, 10).map((of: any) => ({ title: of.title, description: of.description, price: of.price, currency: of.currency, min_persons: of.min_persons, max_persons: of.max_persons })),
                };
                writer.write({
                  type: "tool-result",
                  id: textId,
                  tool: "vendor_details",
                  result: payload,
                });
              } catch (e) {
                console.warn("[chat] failed to emit structured vendor details:", e);
              }

              // Emit raw JSON into chat text only if debug flag enabled
              if (EMIT_JSON_SENTINELS) {
                try {
                  const payload = {
                    type: "vendor_details",
                    vendor_id: v.id ?? null,
                    name: v.name ?? null,
                    refined_short_description: v.short_description ?? null,
                    price_range:
                      (v.min_price || v.max_price) ? `${v.min_price ?? "NA"} - ${v.max_price ?? "NA"} ${v.currency ?? "INR"}` : null,
                    city: v.city ?? null,
                    avg_rating: details.stats?.avg_rating ?? v.avg_rating ?? null,
                    review_count: details.stats?.review_count ?? v.rating_count ?? null,
                    top_reviews: (details.top_reviews || []).slice(0, 5).map((r: any) => ({ rating: r.rating, title: r.title, body: r.body ?? r.text, reviewer_name: r.reviewer_name })),
                    images: (details.images || []).slice(0, 10).map((i: any) => ({ url: i.url, caption: i.caption, is_main: i.is_main })),
                    offers: (details.offers || []).slice(0, 10).map((of: any) => ({ title: of.title, description: of.description, price: of.price, currency: of.currency, min_persons: of.min_persons, max_persons: of.max_persons })),
                  };
                  writer.write({
                    type: "text-delta",
                    id: textId,
                    delta: `\n\n__VENDOR_DETAILS_JSON__${JSON.stringify(payload)}__END_VENDOR_DETAILS_JSON__`,
                  });
                } catch (e) {
                  console.warn("[chat] failed to emit vendor details JSON sentinel:", e);
                }
              } else {
                // intentionally not emitting raw JSON sentinel into chat UI
              }

            } else {
              // fallback web search
              const webRes = await webSearch(vendorName, { limit: 3 }).catch(() => null);
              if (webRes && webRes.length) {
                const summary = webRes.slice(0, 3).map((r: any, i: number) => `${i + 1}. ${r.title || r.name}\n${r.snippet || r.summary || ""}\n${r.url || ""}`).join("\n\n");
                writer.write({ type: "text-delta", id: textId, delta: `Couldn't find this vendor in the internal DB. Here's what I found on the web:\n\n${summary}` });
              } else {
                writer.write({ type: "text-delta", id: textId, delta: `I couldn't find details for "${vendorName}".` });
              }
            }

            writer.write({ type: "text-end", id: textId });
            writer.write({ type: "finish" });
            return;
          }

          // ---------- REVIEWS flow ----------
          if (isReviewsQuery(composedQuery)) {
            let vendorName = extractVendorNameFromReviews(composedQuery);
            if (!vendorName) {
              const previousAssistant = messages?.slice().reverse().find((m) => m.role === "assistant");
              if (previousAssistant) {
                const txt = (previousAssistant.parts || []).map((p: any) => p.text || "").join(" ");
                const m = txt.match(/^\s*1\.\s*([^\n–-]+)/m);
                if (m && m[1]) vendorName = m[1].trim();
              }
            }
            if (!vendorName) {
              writer.write({ type: "text-delta", id: textId, delta: "Which vendor would you like reviews for? Please say 'Reviews for <vendor name>'." });
              writer.write({ type: "text-end", id: textId });
              writer.write({ type: "finish" });
              return;
            }

            try {
              if (supabase) {
                const { data: v } = await supabase.from("vendors").select("id, name").ilike("name", `%${vendorName}%`).limit(1).maybeSingle();
                if (v && v.id) {
                  // use helper if available to fetch top reviews
                  let revs = null;
                  try {
                    const details = await getVendorDetails(String(v.id));
                    if (details && details.top_reviews && details.top_reviews.length) revs = details.top_reviews;
                  } catch (e) {
                    // ignore
                  }
                  if (!revs) {
                    const { data: revsDirect } = await supabase.from("vendor_reviews").select("rating, title, body, reviewer_name, review_ts").eq("vendor_id", v.id).order("review_ts", { ascending: false }).limit(50);
                    revs = revsDirect || [];
                  }
                  if (revs && revs.length) {
                    const lines = revs.map((r: any) => `- ${r.rating}/5 ${r.reviewer_name ? `by ${r.reviewer_name}: ` : ""}${(r.title ? r.title + " - " : "")}${r.body ?? r.text ?? ""}`);
                    // emit human readable reviews first
                    writer.write({ type: "text-delta", id: textId, delta: `Recent reviews for ${v.name}:\n\n${lines.join("\n")}` });

                    // Emit structured vendor_reviews event so client can render reviews panel
                    try {
                      const payload = {
                        type: "vendor_reviews",
                        vendor_id: v.id,
                        vendor_name: v.name,
                        reviews: (revs || []).slice(0, 20).map((r: any) => ({ rating: r.rating, title: r.title, body: r.body ?? r.text, reviewer_name: r.reviewer_name, review_ts: r.review_ts })),
                      };
                      writer.write({
                        type: "tool-result",
                        id: textId,
                        tool: "vendor_reviews",
                        result: payload,
                      });

                      // Emit raw JSON sentinel into chat text only if debug flag enabled
                      if (EMIT_JSON_SENTINELS) {
                        writer.write({
                          type: "text-delta",
                          id: textId,
                          delta: `\n\n__VENDOR_REVIEWS_JSON__${JSON.stringify(payload)}__END_VENDOR_REVIEWS_JSON__`,
                        });
                      }
                    } catch (e) {
                      console.warn("[chat] failed to emit structured vendor reviews:", e);
                    }

                    writer.write({ type: "text-end", id: textId });
                    writer.write({ type: "finish" });
                    return;
                  }
                }
              }
            } catch (e) {
              console.warn("[chat] reviews DB fetch failed:", e);
            }

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

          // ---------- GENERIC vendor search (semantic) ----------
          const budgetVal = parseBudget(composedQuery);
          const categoryVal = parseCategory(composedQuery);
          const looksSpecific = Boolean(budgetVal || categoryVal || /\b(powai|bandra|andheri|khar|juhu|thane|navi mumbai|lower parel|colaba|churchgate)\b/i.test(composedQuery));

          if (!looksSpecific) {
            writer.write({ type: "text-delta", id: textId, delta: "Sure — do you have a category (caterers, decorators, venues), a budget, neighbourhoods, or a style in mind?" });
            writer.write({ type: "text-end", id: textId });
            writer.write({ type: "finish" });
            return;
          }

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

          const vendorIds = (vectResults || []).map((v: any) => v.vendor_id || v._id || v.id || (v.metadata && (v.metadata.vendor_id || v.metadata.id))).filter(Boolean);

          let dbRows = [];
          if (supabase && vendorIds.length) {
            try {
              const { data } = await supabase.from("vendors").select("*").in("id", vendorIds);
              dbRows = data || [];
            } catch (e) {
              console.warn("[chat] supabase fetch by ids failed:", e);
            }
          }

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
            const seen = new Set();
            dbRows = dbRows.filter((r: any) => {
              if (seen.has(r.id)) return false;
              seen.add(r.id);
              return true;
            });
          }

          const idToRow: any = {};
          for (const r of dbRows) idToRow[r.id] = r;
          const merged = [];
          for (const v of vectResults) {
            const id = v.vendor_id || v._id || v.id || (v.metadata && (v.metadata.vendor_id || v.metadata.id));
            if (id && idToRow[id]) merged.push({ ...idToRow[id], _score: v._score ?? v.score ?? v.similarity });
            else merged.push({ ...(v.metadata ?? v), name: v.name ?? v.title ?? v.vendor_name ?? v.provider ?? v.text ?? "Vendor", _score: v._score ?? v.score });
          }
          if (merged.length === 0 && dbRows.length) merged.push(...dbRows);

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

          // Emit human-readable results
          writer.write({ type: "text-delta", id: textId, delta: conversational });

          // Build structured payload for UI (preserve ranking)
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
            // Emit structured vendor hits event so client can render cards (not visible as chat text)
            writer.write({
              type: "tool-result",
              id: textId,
              tool: "vendor_hits",
              result: structured,
            });

            // Emit raw hits JSON into chat only if debug flag enabled
            if (EMIT_JSON_SENTINELS) {
              writer.write({
                type: "text-delta",
                id: textId,
                delta: `\n\n__VENDOR_HITS_JSON__${JSON.stringify(structured)}__END_VENDOR_HITS_JSON__`,
              });
            }
          } catch (e) {
            console.warn("[chat] failed to write structured vendor hits:", e);
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
