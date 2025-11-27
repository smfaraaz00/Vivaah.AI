import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

// This function fetches ALL info needed for "More details"
// It is minimal, scalable, and optimized using indexes we created.
export async function getVendorDetails(vendorId: string) {
  // 1. Fetch vendor core data
  const { data: vendor, error: vendorError } = await supabase
    .from('vendors')
    .select(`
      id, name, category, sub_category,
      short_description, long_description,
      address, city, latitude, longitude,
      phone, email, website,
      min_price, max_price, currency,
      capacity, avg_rating, rating_count
    `)
    .eq('id', vendorId)
    .single();

  if (vendorError || !vendor) {
    console.error('Vendor fetch error:', vendorError);
    return null;
  }

  // 2. Fetch up to 10 images (main first)
  const { data: images } = await supabase
    .from('vendor_images')
    .select('id, url, caption, is_main')
    .eq('vendor_id', vendorId)
    .order('is_main', { ascending: false })
    .order('uploaded_at', { ascending: false })
    .limit(10);

  // 3. Fetch vendor offers
  const { data: offers } = await supabase
    .from('vendor_offers')
    .select('id, title, description, price, currency, min_persons, max_persons')
    .eq('vendor_id', vendorId)
    .order('price', { ascending: true })
    .limit(10);

  // 4. Fetch TOP 5 reviews (sorted by rating > recent)
  const { data: reviews } = await supabase
    .from('vendor_reviews')
    .select('id, reviewer_name, rating, title, body, review_date, source')
    .eq('vendor_id', vendorId)
    .order('rating', { ascending: false })
    .order('review_ts', { ascending: false })
    .limit(5);

  // 5. Stats via inline aggregate (fast because we indexed vendor_id)
  const { data: statsRow } = await supabase
    .from('vendor_reviews')
    .select('rating', { count: 'exact' })
    .eq('vendor_id', vendorId);

  // Inline compute basic stats
  const review_count = statsRow?.length ?? 0;
  const avg_rating =
    reviews && reviews.length > 0
      ? Number(
          (
            reviews.reduce((a, r) => a + (r.rating || 0), 0) / reviews.length
          ).toFixed(2)
        )
      : vendor.avg_rating || 0;

  return {
    vendor,
    images: images || [],
    offers: offers || [],
    top_reviews: reviews || [],
    stats: {
      review_count,
      avg_rating,
    },
  };
}
