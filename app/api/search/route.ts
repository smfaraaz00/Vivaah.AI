// app/api/search/route.ts

import { NextResponse } from "next/server";
import { openai, EMBEDDING_MODEL } from "../../../lib/openai";
import { vendorIndex } from "../../../lib/pinecone-vendors";
import { supabaseAdmin } from "../../../lib/supabase";

type ReqBody = {
  q: string;
  category?: string;
  city?: string;
  topK?: number;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ReqBody;
    const q = (body.q || "").trim();

    if (!q) {
      return NextResponse.json({ error: "q is required" }, { status: 400 });
    }

    const category = body.category;
    const city = body.city;
    const topK = body.topK ?? 5;

    // 1) Create embedding for the user's query
    const embResp = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: q,
    });

    const queryVector = embResp.data[0].embedding as number[];

    // 2) Build metadata filter for Pinecone
    const filter: Record<string, any> = {};
    if (category) filter.category = { $eq: category };
    if (city) filter.city = { $eq: city };

    // 3) Query Pinecone vendor vector index
    const pineResp = await vendorIndex.query({
      vector: queryVector,
      topK,
      includeMetadata: true,
      filter: Object.keys(filter).length ? filter : undefined,
    });

    const matches = pineResp.matches || [];

    // Extract vendor IDs from Pinecone ranking
    const ids = matches
      .map((m: any) => m.metadata?.vendor_id)
      .filter(Boolean);

    if (!ids.length) {
      return NextResponse.json({ results: [], matches });
    }

    // 4) Fetch actual vendor rows from Supabase
    const { data: vendors } = await supabaseAdmin
      .from("vendors")
      .select("*")
      .in("id", ids);

    // 5) Preserve Pinecone ranking order
    const byId = new Map((vendors || []).map((v: any) => [v.id, v]));
    const results = ids.map((id: string) => byId.get(id)).filter(Boolean);

    return NextResponse.json({ results, matches });
  } catch (err: any) {
    console.error("api/search error:", err);
    return NextResponse.json(
      { error: err?.message || "Unknown server error" },
      { status: 500 }
    );
  }
}

