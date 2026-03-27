/**
 * Layer 2 — Manufacturer Site Mapping
 * Maps the manufacturer's official domain to discover internal URLs like
 * /distributors, /find-a-reseller, /where-to-buy, /sales-contact.
 * These manufacturer-sourced pages carry the highest confidence for
 * authorized distributor data.
 */

import { firecrawl } from "./firecrawlClient.js";
import type { Logger } from "./firecrawlClient.js";
import type { NormalizedInput, ScoredUrl } from "./types.js";

const MAP_SEARCH_HINT =
  "distributor OR reseller OR where to buy OR buy now OR find a reseller OR sales contact OR authorized partner";

const RESELLER_URL_KEYWORDS = [
  "distributor",
  "reseller",
  "where-to-buy",
  "wheretobuy",
  "find-a-",
  "buy-now",
  "buy-online",
  "sales",
  "authorized",
  "partner",
  "channel",
];

function isRelevantUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return RESELLER_URL_KEYWORDS.some((kw) => lower.includes(kw));
}

interface MapLinkItem {
  url?: unknown;
  title?: unknown;
  description?: unknown;
}

export async function runLayer2Map(
  input: NormalizedInput,
  log: Logger,
): Promise<ScoredUrl[]> {
  const domain = input.manufacturerDomain;
  if (!domain) {
    log("layer2", "No manufacturer domain available — skipping map");
    return [];
  }

  const mfgUrl = `https://${domain}`;
  log("layer2", "Mapping manufacturer domain for distributor pages", { url: mfgUrl });

  try {
    const mapResult = await firecrawl.map(mfgUrl, {
      search: MAP_SEARCH_HINT,
      limit: 40,
    });

    const links = (mapResult as { links?: MapLinkItem[] }).links ?? [];
    log("layer2", `Map returned ${links.length} links`);

    // Prefer URLs with reseller/distributor keywords, take up to 5
    const validLinks = links.filter(
      (l): l is MapLinkItem & { url: string } => typeof l.url === "string",
    );

    const relevant = validLinks.filter((l) => isRelevantUrl(l.url)).slice(0, 5);
    const fallback = validLinks.filter((l) => !isRelevantUrl(l.url)).slice(0, 2);
    const selected = relevant.length > 0 ? relevant : [...fallback];

    const scored: ScoredUrl[] = selected.map((l) => ({
      url: l.url,
      score: 8,
      source: "manufacturer_map" as const,
    }));

    log("layer2", "Selected manufacturer pages for extraction", {
      count: scored.length,
      urls: scored.map((u) => u.url),
    });
    return scored;
  } catch (err) {
    log("layer2", "Map failed", { error: String(err) });
    return [];
  }
}
