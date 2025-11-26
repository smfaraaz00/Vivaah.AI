// app/api/vendor/[id]/route.ts
import { NextResponse } from "next/server";
// correct relative path to lib
import { supabaseAdmin } from "../../../../lib/supabase";

/**
 * GET /api/vendor/:id
 * Returns canonical vendor row plus images, offers and recent reviews.
 *
 * Notes:
 * - We type `context` as `any` to avoid strict compile-time mismatches across Next versions.
 * - We always `await` Promise.resolve(context?.params) to handle both plain-object and Promise params.
 */
export async function GET(req: Request, context: any) {
  // context.params may be an object or a Promise depending on Next version/runtime.
  const params = await Promise.resolve(context?.params || {});
  const id = params?.id;

  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  try {
    // 1) Fetch vendor main record
    const { data: vendor, error: vendorErr } = await supabaseAdmin
      .from("vendors")
      .select("*")
      .eq("id", id)
      .single();

    if (vendorErr || !vendor) {
      return NextResponse.json({ error: vendorErr?.message || "vendor not found" }, { status: 404 });
    }

    // 2) Fetch related content in parallel
    const [imagesRes, offersRes, reviewsRes] = await Promise.all([
      supabaseAdmin
        .from("vendor_images")
        .select("*")
        .eq("vendor_id", id)
        .order("uploaded_at", { ascending: false })
        .limit(12),
      supabaseAdmin
        .from("vendor_offers")
        .select("*")
        .eq("vendor_id", id)
        .order("updated_at", { ascending: false })
        .limit(10),
      supabaseAdmin
        .from("vendor_reviews")
        .select("*")
        .eq("vendor_id", id)
        .order("scraped_at", { ascending: false })
        .limit(8),
    ]);

    return NextResponse.json({
      vendor,
      images: imagesRes.data || [],
      offers: offersRes.data || [],
      reviews: reviewsRes.data || [],
    });
  } catch (err: any) {
    console.error("api/vendor error:", err);
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}
