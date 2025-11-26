// app/api/chat/tools/search-vector-database.ts
// @ts-nocheck

import OpenAI from "openai";
import { PineconeClient } from "@pinecone-database/pinecone";

/**
 * Robust Pinecone search helper (lazy init for serverless)
 *
 * Exports:
 * - export const vectorDatabaseSearch = { execute: async ({query, topK}) => {...} }
 * - export default async function vectorDatabaseSearchFn(query, topK) { ... }
 */

// Config (match with your Vercel env var names)
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_ENV = process.env.PINECONE_ENV || process.env.PINECONE_ENVIRONMENT;
const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME || process.env.PINECONE_INDEX || "vendors";

if (!OPENAI_API_KEY) console.error("[search-tool] MISSING OPENAI_API_KEY");
if (!PINECONE_API_KEY) console.error("[search-tool] MISSING PINECONE_API_KEY");
if (!PINECONE_ENV) console.error("[search-tool] MISSING PINECONE_ENV (eg. 'us-west1-gcp')");
if (!PINECONE_INDEX_NAME) console.error("[search-tool] MISSING PINECONE_INDEX_NAME");

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Lazy Pinecone client init
let pineconeClient = null;
async function ensurePineconeInit() {
  if (pineconeClient) return pineconeClient;
  try {
    pineconeClient = new PineconeClient();
    // init accepts { apiKey, environment } for PineconeClient
    await pineconeClient.init({
      apiKey: PINECONE_API_KEY,
      environment: PINECONE_ENV,
    });
    return pineconeClient;
  } catch (err) {
    // If your installed Pinecone package expects `controllerHostUrl` instead of `environment`,
    // this will surface a clearer error. We'll log it and rethrow.
    console.error("[search-tool] Pinecone init error:", err);
    throw err;
  }
}

function normalizeMatch(m) {
  return {
    id: m.id,
    _score: m.score ?? m.similarity ?? null,
    name: m.metadata?.name ?? m.metadata?.title ?? m.metadata?.vendor_name ?? "",
    location: m.metadata?.location ?? m.metadata?.city ?? "",
    category: m.metadata?.category ?? m.metadata?.vendor_type ?? "",
    price_range: m.metadata?.price_range ?? m.metadata?.price ?? "",
    description: m.metadata?.description ?? m.metadata?.desc ?? "",
    raw_metadata: m.metadata ?? {},
  };
}

async function embedText(text) {
  if (!text) return null;
  try {
    const res = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text,
    });
    const emb = res?.data?.[0]?.embedding;
    if (!emb) {
      console.warn("[search-tool] embedding response missing vector");
    }
    return emb;
  } catch (err) {
    console.error("[search-tool] embedding error:", err);
    throw err;
  }
}

export const vectorDatabaseSearch = {
  async execute({ query, topK = 8 } = {}) {
    console.log("[search-tool] execute called. query:", String(query || "").slice(0, 300), "topK:", topK);

    if (!query) return { matches: [], vendors: [] };

    // init pinecone client lazily
    const client = await ensurePineconeInit();
    const index = client.Index(PINECONE_INDEX_NAME);

    try {
      const embedding = await embedText(query);
      if (!embedding) {
        console.warn("[search-tool] no embedding -> return empty");
        return { matches: [], vendors: [] };
      }
      console.log("[search-tool] embedding length:", embedding.length);

      const pineRes = await index.query({
        vector: embedding,
        topK,
        includeMetadata: true,
        includeValues: false,
      });

      try {
        console.log("[search-tool] pinecone.raw:", JSON.stringify(pineRes, null, 2).slice(0, 20000));
      } catch (serr) {
        console.log("[search-tool] pinecone.raw (non-serializable)", pineRes);
      }

      const matches = (pineRes?.matches ?? []).map((m) => ({
        id: m.id,
        score: m.score ?? m.similarity ?? null,
        metadata: m.metadata ?? {},
      }));

      const vendors = matches.map((m) => {
        const norm = normalizeMatch({ id: m.id, metadata: m.metadata, score: m.score });
        return {
          ...norm,
          _id: m.id,
          _score: m.score ?? null,
        };
      });

      return { matches, vendors };
    } catch (err) {
      console.error("[search-tool] query error:", err);
      return { matches: [], vendors: [] };
    }
  },
};

export default async function vectorDatabaseSearchFn(query, topK = 8) {
  return vectorDatabaseSearch.execute({ query, topK });
}
