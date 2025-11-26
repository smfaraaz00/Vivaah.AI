// app/api/chat/tools/search-vector-database.ts
// @ts-nocheck
/**
 * Pinecone search tool (no Supabase fallback).
 * - Safe at import time (no throws)
 * - Lazy/adaptive Pinecone init (supports multiple SDK shapes)
 * - Returns { matches, vendors }
 */

import OpenAI from "openai";
import * as PineconePkg from "@pinecone-database/pinecone";

// ---------- Safe env reads ----------
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const PINECONE_API_KEY = process.env.PINECONE_API_KEY ?? "";
const PINECONE_ENV = process.env.PINECONE_ENV ?? process.env.PINECONE_ENVIRONMENT ?? "";
const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME ?? process.env.PINECONE_INDEX ?? "";
const PINECONE_CONTROLLER_HOST = process.env.PINECONE_CONTROLLER_HOST ?? "";

if (!OPENAI_API_KEY) console.warn("[search-tool] WARNING: OPENAI_API_KEY not set.");
if (!PINECONE_API_KEY) console.warn("[search-tool] WARNING: PINECONE_API_KEY not set.");
if (!PINECONE_INDEX_NAME) console.warn("[search-tool] WARNING: PINECONE_INDEX_NAME not set.");

// ---------- Clients (lazy) ----------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

let pineClient = null;
let pineIndexHandle = null;
let pineInitAttempted = false;

async function embedText(text) {
  if (!text) return null;
  if (!OPENAI_API_KEY) {
    console.warn("[search-tool] embedText: OPENAI_API_KEY missing.");
    return null;
  }
  try {
    const resp = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: text });
    return resp?.data?.[0]?.embedding ?? null;
  } catch (err) {
    console.error("[search-tool] embedding error:", err);
    throw err;
  }
}

function normalizeMatchToVendor(obj) {
  const md = obj?.metadata ?? {};
  return {
    id: obj?.id ?? null,
    _score: obj?.score ?? obj?.similarity ?? null,
    name: md.name ?? md.title ?? md.vendor_name ?? "",
    location: md.location ?? md.city ?? "",
    category: md.category ?? md.vendor_type ?? "",
    price_range: md.price_range ?? md.price ?? "",
    description: md.description ?? md.desc ?? "",
    raw_metadata: md,
  };
}

// ---------- Adaptive Pinecone init (lazy) ----------
async function ensurePineInit() {
  if (pineClient && pineIndexHandle) return { pineClient, pineIndexHandle };

  // Avoid noisy repeated attempts
  if (pineInitAttempted) return { pineClient: pineClient ?? null, pineIndexHandle: pineIndexHandle ?? null };
  pineInitAttempted = true;

  if (!PINECONE_API_KEY) {
    console.warn("[search-tool] ensurePineInit: PINECONE_API_KEY not set.");
    return { pineClient: null, pineIndexHandle: null };
  }
  if (!PINECONE_INDEX_NAME) {
    console.warn("[search-tool] ensurePineInit: PINECONE_INDEX_NAME not set.");
    return { pineClient: null, pineIndexHandle: null };
  }

  try {
    // 1) Try modern PineconeClient if exported
    const PineconeClientClass = PineconePkg?.PineconeClient ?? PineconePkg?.Pinecone;
    if (PineconeClientClass && typeof PineconeClientClass === "function") {
      // Try init() path first (modern)
      try {
        const maybeClient = new PineconeClientClass();
        if (typeof maybeClient.init === "function") {
          try {
            // prefer environment-based init; controller host will be used by SDK if needed
            await maybeClient.init({ apiKey: PINECONE_API_KEY, environment: PINECONE_ENV || undefined });
            pineClient = maybeClient;
            pineIndexHandle = typeof pineClient.Index === "function" ? pineClient.Index(PINECONE_INDEX_NAME) : (pineClient.index ? pineClient.index(PINECONE_INDEX_NAME) : null);
            console.log("[search-tool] Pinecone init path: PineconeClient + init()");
            return { pineClient, pineIndexHandle };
          } catch (e) {
            console.warn("[search-tool] PineconeClient.init() attempt failed:", e);
          }
        }
      } catch (e) {
        console.warn("[search-tool] PineconeClientClass new attempt failed:", e);
      }

      // Try constructor taking controllerHostUrl or apiKey
      try {
        const controllerHostUrl = PINECONE_CONTROLLER_HOST || (PINECONE_ENV ? `https://controller.${PINECONE_ENV}.pinecone.io` : undefined);
        const maybeClient2 = new PineconeClientClass({ apiKey: PINECONE_API_KEY, controllerHostUrl });
        pineClient = maybeClient2;
        pineIndexHandle = pineClient.index ? pineClient.index(PINECONE_INDEX_NAME) : (pineClient.Index ? pineClient.Index(PINECONE_INDEX_NAME) : null);
        console.log("[search-tool] Pinecone init path: constructor({apiKey,controllerHostUrl})");
        return { pineClient, pineIndexHandle };
      } catch (e2) {
        console.warn("[search-tool] Pinecone constructor({}) attempt failed:", e2);
      }
    }

    // 2) Try default export shapes (object with .PineconeClient etc.)
    const defaultExport = PineconePkg?.default ?? PineconePkg;
    if (defaultExport && typeof defaultExport === "object") {
      const C = defaultExport.PineconeClient ?? defaultExport.Pinecone;
      if (C && typeof C === "function") {
        try {
          const instance = new C();
          if (typeof instance.init === "function") {
            try {
              await instance.init({ apiKey: PINECONE_API_KEY, environment: PINECONE_ENV || undefined });
              pineClient = instance;
              pineIndexHandle = typeof pineClient.Index === "function" ? pineClient.Index(PINECONE_INDEX_NAME) : (pineClient.index ? pineClient.index(PINECONE_INDEX_NAME) : null);
              console.log("[search-tool] Pinecone init path: defaultExport.PineconeClient + init()");
              return { pineClient, pineIndexHandle };
            } catch (ie) {
              console.warn("[search-tool] instance.init() failed:", ie);
            }
          }
        } catch (ex) {
          console.warn("[search-tool] defaultExport.PineconeClient new() failed:", ex);
        }
      }
    }

    console.warn("[search-tool] ensurePineInit: unable to initialize Pinecone client with detected SDK; returning null handles.");
    return { pineClient: null, pineIndexHandle: null };
  } catch (fatal) {
    console.error("[search-tool] ensurePineInit fatal:", fatal);
    return { pineClient: null, pineIndexHandle: null };
  }
}

// ---------- Main function ----------
export const vectorDatabaseSearch = {
  async execute({ query, topK = 5 } = {}) {
    const q = String(query ?? "").trim();
    console.log("[search-tool] execute called. query:", q.slice(0, 300), "topK:", topK);
    if (!q) return { matches: [], vendors: [] };

    // 1) create embedding
    let embedding = null;
    try {
      embedding = await embedText(q);
      if (!embedding) {
        console.warn("[search-tool] embedding missing; aborting Pinecone query.");
      } else {
        console.log("[search-tool] embedding length:", embedding.length);
      }
    } catch (e) {
      console.error("[search-tool] embedding failed:", e);
      // proceed — we will treat as no Pinecone attempt
    }

    // 2) attempt Pinecone query if init successful and embedding present
    try {
      const { pineClient: pc, pineIndexHandle: idx } = await ensurePineInit();
      if (pc && idx && embedding) {
        try {
          let pineRes;
          if (typeof idx.query === "function") {
            pineRes = await idx.query({
              vector: embedding,
              topK,
              includeMetadata: true,
              includeValues: false,
            });
          } else if (typeof idx.fetch === "function") {
            pineRes = await idx.fetch({ topK });
          } else {
            throw new Error("Index object has no query method.");
          }

          try {
            console.log("[search-tool] pinecone.raw:", JSON.stringify(pineRes, null, 2).slice(0, 20000));
          } catch (jerr) {
            console.log("[search-tool] pinecone.raw (non-serializable):", pineRes);
          }

          const raw = pineRes?.matches ?? pineRes?.results ?? [];
          const matches = (Array.isArray(raw) ? raw : []).map((m) => ({
            id: m.id,
            score: m.score ?? m.similarity ?? null,
            metadata: m.metadata ?? {},
          }));

          const vendors = matches.map((m) => normalizeMatchToVendor({ id: m.id, metadata: m.metadata, score: m.score }));
          return { matches, vendors };
        } catch (qerr) {
          console.error("[search-tool] index.query failed:", qerr);
          // return empty result (no fallback per request)
          return { matches: [], vendors: [] };
        }
      } else {
        console.log("[search-tool] Pinecone not available or missing embedding; returning empty result.");
        return { matches: [], vendors: [] };
      }
    } catch (err) {
      console.error("[search-tool] Unexpected error during Pinecone attempt:", err);
      return { matches: [], vendors: [] };
    }
  },
};

export default async function vectorDatabaseSearchFn(query, topK = 5) {
  return vectorDatabaseSearch.execute({ query, topK });
}
