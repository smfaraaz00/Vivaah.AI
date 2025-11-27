// components/messages/assistant-message.tsx
"use client";
import React from "react";
import type { UIMessage } from "ai";

type AssistantMessageProps = {
  message: UIMessage;
  status?: string;
  isLastMessage?: boolean;
  durations?: Record<string, number>;
  onDurationChange?: (key: string, duration: number) => void;
  // Additional props used by MessageWall
  text?: string;
  toolResult?: any;
};

export const AssistantMessage: React.FC<AssistantMessageProps> = ({
  message,
  text,
  toolResult,
}) => {
  // Derive plain text from message parts if text prop not provided
  const derivedText =
    text ??
    (Array.isArray(message.parts)
      ? message.parts.map((p: any) => (p.type === "text" ? p.text : "")).join("")
      : "");

  // Helper renderers for common toolResult types
  const renderVendorHits = (items: any[]) => {
    if (!Array.isArray(items)) return null;
    return (
      <div className="vendor-hits space-y-4">
        {items.map((it: any, i: number) => {
          const name = it.name ?? it.title ?? it.vendor_name ?? "Vendor";
          const short = it.short_description ?? it.description ?? "";
          const city = it.city ?? "";
          const price =
            it.price_min || it.price_max
              ? `${it.price_min ?? "NA"} - ${it.price_max ?? "NA"}`
              : it.price_range ?? "";
          const id = it.id ?? `vendor-${i}`;
          return (
            <div
              key={id}
              className="vendor-card border rounded-lg p-4 flex gap-4 items-start bg-white shadow-sm"
            >
              <div className="vendor-thumb w-20 h-20 bg-gray-100 rounded-md flex items-center justify-center text-sm text-gray-500">
                No image
              </div>
              <div className="flex-1">
                <div className="font-semibold text-primary mb-1">{name}</div>
                <div className="text-xs text-muted mb-2">
                  {it.category ?? "caterer"} {city ? `• ${city}` : ""}
                </div>
                {short ? <div className="text-sm mb-3">{short}</div> : null}
                <div className="flex gap-3 items-center">
                  {price ? (
                    <div className="text-sm text-muted">Approx: {price}</div>
                  ) : null}
                  <div className="ml-auto flex gap-2">
                    <button className="px-4 py-1 rounded-full text-sm bg-[#cfa02b] text-white">More details</button>
                    <button className="px-4 py-1 rounded-full text-sm bg-[#cfa02b] text-white">Reviews</button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderVendorDetails = (payload: any) => {
    const name = payload?.name ?? "Vendor details";
    return (
      <div className="vendor-details border rounded-lg p-4 bg-white">
        <div className="font-semibold text-lg mb-2">{name}</div>
        {payload?.refined_short_description ? (
          <div className="mb-2 text-sm">{payload.refined_short_description}</div>
        ) : null}
        {payload?.price_range ? (
          <div className="text-sm mb-2">Price: {payload.price_range}</div>
        ) : null}
        {payload?.avg_rating ? (
          <div className="text-sm mb-2">Rating: {payload.avg_rating} ({payload.review_count ?? 0})</div>
        ) : null}
        {Array.isArray(payload?.top_reviews) && payload.top_reviews.length ? (
          <div className="mt-3">
            <div className="font-medium mb-1">Recent reviews</div>
            <ul className="list-disc ml-5 text-sm">
              {payload.top_reviews.slice(0, 3).map((r: any, i: number) => (
                <li key={i}>
                  <strong>{r.rating ?? "N/A"}/5</strong> {r.title ? `- ${r.title}` : ""}{" "}
                  <div className="text-muted text-sm">{r.body ?? ""}</div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    );
  };

  const renderVendorReviews = (payload: any) => {
    const reviews = Array.isArray(payload?.reviews) ? payload.reviews : [];
    if (!reviews.length) return null;
    return (
      <div className="vendor-reviews border rounded-lg p-4 bg-white">
        <div className="font-semibold mb-2">Reviews for {payload.vendor_name ?? ""}</div>
        <ul className="space-y-2">
          {reviews.slice(0, 6).map((r: any, i: number) => (
            <li key={i} className="text-sm">
              <div>
                <strong>{r.rating ?? "N/A"}/5</strong> {r.reviewer_name ? `by ${r.reviewer_name}` : ""}
              </div>
              <div className="text-muted">{r.title ? `${r.title} — ` : ""}{r.body ?? ""}</div>
            </li>
          ))}
        </ul>
      </div>
    );
  };

  // Decide how to render toolResult (support a few known shapes)
  const renderToolResult = (tr: any) => {
    if (!tr) return null;
    // toolResult might be passed as the final object or wrapped inside { type, result }
    const t = tr.type ? tr : tr; // already object
    const type = tr.type ?? tr.toolType ?? tr.kind ?? null;

    // If the object looks like vendor_hits (array) or structured list
    if (Array.isArray(tr) || tr?.[0]?.name) {
      // treat as vendor hits array
      return renderVendorHits(Array.isArray(tr) ? tr : []);
    }

    if (type === "vendor_hits") {
      return renderVendorHits(tr.result ?? tr);
    }
    if (type === "vendor_details") {
      return renderVendorDetails(tr.result ?? tr);
    }
    if (type === "vendor_reviews") {
      return renderVendorReviews(tr.result ?? tr);
    }

    // fallback: if it contains 'vendors' or 'sections'
    if (tr.vendors || tr.sections) {
      if (tr.vendors) return renderVendorHits(tr.vendors);
      if (tr.sections) {
        // flatten sections to vendor hits
        const flat: any[] = [];
        (tr.sections || []).forEach((s: any) => {
          (s.vendors || []).forEach((v: any) => flat.push(v));
        });
        return renderVendorHits(flat);
      }
    }

    // last resort: show a sanitized text summary (no raw JSON dump)
    const short = typeof tr === "string" ? tr : tr.title ?? tr.name ?? null;
    if (short) {
      return <div className="p-3 border rounded-md bg-white text-sm">{short}</div>;
    }

    return null;
  };

  return (
    <div className="assistant-message my-4">
      <div className="prose max-w-none">
        {derivedText ? (
          <div className="assistant-text text-base leading-relaxed whitespace-pre-wrap">{derivedText}</div>
        ) : null}
      </div>

      <div className="mt-3">
        {toolResult ? (
          <div className="tool-result-renderer space-y-3">{renderToolResult(toolResult)}</div>
        ) : null}
      </div>
    </div>
  );
};

export default AssistantMessage;
