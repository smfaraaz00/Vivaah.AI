// @ts-nocheck

import { tool } from 'ai';
import { z } from 'zod';
import { OpenAI } from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';

// ---------- Clients ----------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY as string,
});

const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY as string,
});

const index = pinecone.index(process.env.PINECONE_INDEX_NAME as string);

// ---------- Tool ----------
export const vectorDatabaseSearch = tool({
  description:
    'Search the Pinecone vendor database and return the most relevant wedding vendors based on the user query.',

  parameters: z.object({
    query: z.string().describe('User query about wedding vendors'),
    topK: z.number().min(1).max(10).optional().default(5),
  }),

  async execute({ query, topK }) {
    try {
      const k = topK ?? 5;

      // 1. Create embedding for user query
      const embeddingResponse = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: query,
      });

      const embedding = embeddingResponse.data[0].embedding;

      // 2. Query Pinecone
      const pineconeResponse = await index.query({
        vector: embedding,
        topK: k,
        includeMetadata: true,
      });

      // 3. Format results
      const vendors =
        pineconeResponse.matches?.map((match) => ({
          id: match.id,
          score: match.score,
          name: (match.metadata?.name as string) || '',
          location: (match.metadata?.location as string) || '',
          category: (match.metadata?.category as string) || '',
          price_range: (match.metadata?.price_range as string) || '',
          description: (match.metadata?.description as string) || '',
        })) ?? [];

      return { vendors };
    } catch (error) {
      console.error('Vector DB Search Error:', error);
      return { vendors: [] };
    }
  },
});
