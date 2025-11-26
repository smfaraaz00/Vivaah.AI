// lib/supabase.ts — server-side Supabase client (use only in server code)
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env var");

export const supabaseAdmin = createClient(url, key, {
  auth: { persistSession: false },
});
