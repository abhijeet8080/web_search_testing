/**
 * Layer 3 — Structured Extraction
 * Takes the top scored URLs from Layers 1 & 2 and scrapes each with
 * Firecrawl JSON mode to extract structured distributor data.
 * Runs in parallel (up to MAX_CONCURRENT at once) for speed.
 */

import { firecrawl } from "./firecrawlClient.js";
import type { Logger } from "./firecrawlClient.js";
import type { RawDistributor, ScoredUrl } from "./types.js";
import { DISTRIBUTOR_SCHEMA, EXTRACT_PROMPT } from "./types.js";

const MAX_URLS = 14;
const MAX_CONCURRENT = 6;

// Chunk an array into batches of size n
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

interface ScrapeJsonResult {
  distributors?: unknown[];
}

function parseDistributors(json: unknown): RawDistributor[] {
  if (typeof json !== "object" || json === null) return [];
  const obj = json as Record<string, unknown>;
  const arr = Array.isArray(obj["distributors"]) ? obj["distributors"] : [];
  return arr.filter((d): d is RawDistributor => typeof d === "object" && d !== null);
}

async function scrapeUrlForDistributors(
  url: string,
  source: string,
  log: Logger,
): Promise<{ url: string; source: string; distributors: RawDistributor[] }> {
  try {
    const result = await (firecrawl as unknown as {
      scrape: (
        url: string,
        opts: {
          formats: Array<string | { type: string; schema: unknown; prompt: string }>;
          onlyMainContent: boolean;
          timeout: number;
        },
      ) => Promise<{ json?: unknown; data?: { json?: unknown } }>;
    }).scrape(url, {
      formats: [
        {
          type: "json",
          schema: DISTRIBUTOR_SCHEMA,
          prompt: EXTRACT_PROMPT,
        },
      ],
      onlyMainContent: true,
      timeout: 30000,
    });

    // SDK may return result.json directly or nested under result.data.json
    const jsonData: unknown =
      (result as { json?: unknown }).json ??
      (result as { data?: { json?: unknown } }).data?.json ??
      null;

    const distributors = parseDistributors(jsonData);
    log("layer3", `Scraped ${url} → ${distributors.length} distributors`, {
      source,
    });
    return { url, source, distributors };
  } catch (err) {
    log("layer3", `Scrape failed for ${url}`, { error: String(err) });
    return { url, source, distributors: [] };
  }
}

export interface Layer3Result {
  rawDistributors: Array<RawDistributor & { _sourceUrl: string; _sourceLayer: string }>;
  urlsScraped: number;
}

export async function runLayer3Extract(
  scoredUrls: ScoredUrl[],
  log: Logger,
): Promise<Layer3Result> {
  const topUrls = scoredUrls.slice(0, MAX_URLS);
  log("layer3", "Starting structured extraction", {
    urlCount: topUrls.length,
    concurrency: MAX_CONCURRENT,
    urls: topUrls.map((u) => `[${u.score}] ${u.url}`),
  });

  const allDistributors: Array<RawDistributor & { _sourceUrl: string; _sourceLayer: string }> = [];
  let urlsScraped = 0;

  // Process in batches to stay within concurrency
  for (const batch of chunk(topUrls, MAX_CONCURRENT)) {
    const batchResults = await Promise.all(
      batch.map((u) => scrapeUrlForDistributors(u.url, u.source, log)),
    );
    for (const res of batchResults) {
      urlsScraped++;
      for (const d of res.distributors) {
        allDistributors.push({
          ...d,
          _sourceUrl: res.url,
          _sourceLayer: res.source,
        });
      }
    }
  }

  log("layer3", "Extraction complete", {
    urlsScraped,
    rawDistributorCount: allDistributors.length,
  });

  return { rawDistributors: allDistributors, urlsScraped };
}
