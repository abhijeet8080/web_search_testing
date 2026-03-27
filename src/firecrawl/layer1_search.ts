/**
 * Layer 1 — Web Search
 * Fires 2–3 parallel Firecrawl /search queries using query variants from Layer 0.
 * Collects all URLs, deduplicates, and scores them by domain priority.
 */

import { firecrawl } from "./firecrawlClient.js";
import type { Logger } from "./firecrawlClient.js";
import type { NormalizedInput, ScoredUrl } from "./types.js";

// Higher-priority distributor aggregator domains
const PRIORITY_DOMAINS: ReadonlyMap<string, number> = new Map([
  ["octopart.com", 9],
  ["findchips.com", 8],
  ["nexar.com", 8],
  ["digikey.com", 7],
  ["mouser.com", 7],
  ["arrow.com", 7],
  ["avnet.com", 7],
  ["rs-online.com", 6],
  ["uk.rs-online.com", 6],
  ["element14.com", 6],
  ["newark.com", 6],
  ["farnell.com", 6],
  ["futureelectronics.com", 5],
  ["tme.eu", 5],
  ["rutronik.com", 5],
  ["distrelec.com", 5],
  ["wuerth-elektronik.com", 4],
]);

function scoreDomain(url: string): number {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    // Exact domain match
    for (const [domain, score] of PRIORITY_DOMAINS) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) return score;
    }
    // Partial match on common distributor keywords
    if (
      hostname.includes("distributor") ||
      hostname.includes("reseller") ||
      hostname.includes("electronics")
    ) {
      return 3;
    }
    return 1;
  } catch {
    return 0;
  }
}

interface SearchResultItem {
  url?: unknown;
  title?: unknown;
  description?: unknown;
}

function pickSearchItems(result: unknown): SearchResultItem[] {
  if (!result || typeof result !== "object") return [];

  // Firecrawl JS SDK typically returns the data object directly:
  // { web: [...], images: [...], news: [...] }
  const directWeb = (result as { web?: unknown }).web;
  if (Array.isArray(directWeb)) return directWeb as SearchResultItem[];

  // Fallback for wrapper-style payloads:
  // { data: { web: [...] } } or legacy { data: [...] }
  const wrapped = (result as { data?: unknown }).data;
  if (wrapped && typeof wrapped === "object") {
    const wrappedWeb = (wrapped as { web?: unknown }).web;
    if (Array.isArray(wrappedWeb)) return wrappedWeb as SearchResultItem[];
  }
  if (Array.isArray(wrapped)) return wrapped as SearchResultItem[];

  return [];
}

export async function runLayer1Search(
  input: NormalizedInput,
  log: Logger,
): Promise<ScoredUrl[]> {
  log("layer1", "Firing parallel search queries", { queries: input.queryVariants });

  const searchTasks = input.queryVariants.map(async (query, idx): Promise<ScoredUrl[]> => {
    try {
      const result = await firecrawl.search(query, { limit: 7 });
      const items = pickSearchItems(result);
      log("layer1", `Query ${idx + 1} returned ${items.length} results`, {
        query: query.slice(0, 80),
      });
      return items
        .filter((item): item is SearchResultItem & { url: string } => typeof item.url === "string")
        .map((item) => ({
          url: item.url,
          score: scoreDomain(item.url),
          source: "search" as const,
        }));
    } catch (err) {
      log("layer1", `Query ${idx + 1} failed`, { error: String(err) });
      return [];
    }
  });

  const allResults = (await Promise.all(searchTasks)).flat();

  // Deduplicate by URL
  const seen = new Set<string>();
  const unique: ScoredUrl[] = [];
  for (const item of allResults) {
    if (!seen.has(item.url)) {
      seen.add(item.url);
      unique.push(item);
    }
  }

  // Ensure manufacturer's known domain is present with top priority
  if (input.manufacturerDomain) {
    const mfgUrl = `https://${input.manufacturerDomain}`;
    if (!seen.has(mfgUrl)) {
      unique.unshift({ url: mfgUrl, score: 10, source: "manufacturer_known" });
    }
  }

  const sorted = unique.sort((a, b) => b.score - a.score);
  log("layer1", "Search complete", {
    totalUrls: sorted.length,
    topUrls: sorted.slice(0, 6).map((u) => `[${u.score}] ${u.url}`),
  });
  return sorted;
}
