/**
 * AI Procurement Assistant — Main Orchestrator
 *
 * Executes the 7-layer pipeline:
 *   Layer 0 → Normalize input
 *   Layer 1 → Parallel web search (Firecrawl /search)
 *   Layer 2 → Manufacturer site mapping (Firecrawl /map)
 *   Layer 3 → Structured extraction on top URLs (Firecrawl /scrape JSON mode)
 *   Layer 4 → Deep scrape for missing emails (Firecrawl /map + /scrape)
 *   Layer 5 → Autonomous agent fallback (Firecrawl /agent)
 *   Layer 6 → Validation, deduplication, scoring (pure TypeScript)
 *
 * Usage:
 *   const result = await runProcurementPipeline({ partNumber, manufacturerName });
 */

import { firecrawl, getDomain, makeLogger } from "./firecrawlClient.js";
import type { Logger } from "./firecrawlClient.js";
import { buildQueryVariants, normalize } from "./layer0_normalize.js";
import { runLayer1Search } from "./layer1_search.js";
import { runLayer2Map } from "./layer2_map.js";
import { runLayer3Extract } from "./layer3_extract.js";
import { runLayer4Scrape } from "./layer4_scrape.js";
import { runLayer5Agent, MIN_DISTRIBUTORS_WITH_EMAIL } from "./layer5_agent.js";
import { runLayer6Validate, parseDistributor } from "./layer6_validate.js";
import type {
  ProcurementInput,
  ProcurementOutput,
  Distributor,
  ManufacturerInfo,
  RawDistributor,
  ScoredUrl,
} from "./types.js";

// ─── Options ──────────────────────────────────────────────────────────────────

export interface ProcurementOptions {
  /** Custom logger — defaults to stderr logger with [procurement] prefix */
  log?: Logger;
  /** Skip Layer 5 agent even if distributor count is low (saves credits) */
  skipAgent?: boolean;
  /** Skip Layer 4 deep scrape for missing emails */
  skipDeepScrape?: boolean;
  /** Max total URLs to pass to Layer 3 extraction */
  maxUrlsForExtraction?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mergeAndRankUrls(layer1: ScoredUrl[], layer2: ScoredUrl[]): ScoredUrl[] {
  const seen = new Set<string>();
  const combined: ScoredUrl[] = [];

  // Layer 2 (manufacturer site) URLs take precedence
  for (const u of [...layer2, ...layer1]) {
    if (!seen.has(u.url)) {
      seen.add(u.url);
      combined.push(u);
    }
  }

  return combined.sort((a, b) => b.score - a.score);
}

function extractManufacturerInfo(
  distributors: Distributor[],
  normalizedName: string,
  normalizedDomain: string,
): ManufacturerInfo | null {
  // Try to find the manufacturer itself in the distributor list
  const mfg = distributors.find(
    (d) =>
      d.name.toLowerCase().includes(normalizedName.toLowerCase()) ||
      (normalizedDomain && d.website.toLowerCase().includes(normalizedDomain)),
  );

  if (mfg) {
    return {
      name: mfg.name,
      website: mfg.website,
      email: mfg.email,
      phone: mfg.phone,
    };
  }

  // Return a skeleton from what we know
  if (normalizedName) {
    return {
      name: normalizedName,
      website: normalizedDomain ? `https://${normalizedDomain}` : "",
      email: "",
      phone: "",
    };
  }

  return null;
}

interface ManufacturerSearchItem {
  url?: unknown;
  title?: unknown;
  description?: unknown;
}

function pickSearchItems(result: unknown): ManufacturerSearchItem[] {
  if (!result || typeof result !== "object") return [];
  const directWeb = (result as { web?: unknown }).web;
  if (Array.isArray(directWeb)) return directWeb as ManufacturerSearchItem[];

  const wrapped = (result as { data?: unknown }).data;
  if (wrapped && typeof wrapped === "object") {
    const wrappedWeb = (wrapped as { web?: unknown }).web;
    if (Array.isArray(wrappedWeb)) return wrappedWeb as ManufacturerSearchItem[];
  }
  if (Array.isArray(wrapped)) return wrapped as ManufacturerSearchItem[];
  return [];
}

const BLOCKED_RESOLUTION_DOMAINS = new Set([
  "wikipedia.org",
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "youtube.com",
  "bloomberg.com",
  "reuters.com",
  "crunchbase.com",
]);

function maybeExtractCanonicalName(rawTitle: string): string {
  const cleaned = rawTitle
    .replace(/\s+/g, " ")
    .trim()
    .split(/\||-|—|:/)[0]
    ?.trim();
  if (!cleaned) return "";
  if (!/[A-Za-z]/.test(cleaned)) return "";
  if (cleaned.length > 70) return "";
  return cleaned;
}

async function resolveManufacturerIdentity(
  manufacturerName: string,
  log: Logger,
): Promise<{ name: string; domain: string } | null> {
  const query = `"${manufacturerName}" official website`;
  try {
    const result = await firecrawl.search(query, { limit: 7 });
    const items = pickSearchItems(result);
    if (items.length === 0) return null;

    const nameTokens = manufacturerName
      .toLowerCase()
      .split(/[\s\-_.]+/)
      .filter(Boolean);

    let best:
      | {
          domain: string;
          canonicalName: string;
          score: number;
        }
      | null = null;

    for (const item of items) {
      if (typeof item.url !== "string") continue;
      const domain = getDomain(item.url).toLowerCase();
      if (!domain) continue;
      if ([...BLOCKED_RESOLUTION_DOMAINS].some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`))) {
        continue;
      }

      const title = typeof item.title === "string" ? item.title : "";
      const desc = typeof item.description === "string" ? item.description : "";
      const canonicalName = maybeExtractCanonicalName(title) || manufacturerName;

      let score = 0;
      const titleAndDesc = `${title} ${desc}`.toLowerCase();
      const tokenHits = nameTokens.filter((t) => titleAndDesc.includes(t)).length;
      score += tokenHits * 3;
      if (nameTokens.some((t) => domain.includes(t))) score += 4;
      if (domain.split(".").length <= 3) score += 1;
      if (titleAndDesc.includes("official")) score += 2;

      if (!best || score > best.score) {
        best = { domain, canonicalName, score };
      }
    }

    if (!best) return null;
    return {
      name: best.canonicalName || manufacturerName,
      domain: best.domain,
    };
  } catch (err) {
    log("normalize", "Manufacturer identity resolution failed", { error: String(err) });
    return null;
  }
}

// ─── Pipeline entry point ─────────────────────────────────────────────────────

export async function runProcurementPipeline(
  input: ProcurementInput,
  options: ProcurementOptions = {},
): Promise<ProcurementOutput> {
  const log: Logger = options.log ?? makeLogger("procurement");
  const startTime = Date.now();
  const layersUsed: string[] = [];
  const warnings: string[] = [];

  log("pipeline", "Starting procurement pipeline", {
    partNumber: input.partNumber,
    manufacturerName: input.manufacturerName,
  });

  // ── Layer 0 ────────────────────────────────────────────────────────────────
  let normalizedInput = normalize(input);
  layersUsed.push("normalize");
  log("pipeline", "Layer 0 complete", {
    partNumber: normalizedInput.partNumber,
    manufacturerName: normalizedInput.manufacturerName,
    manufacturerDomain: normalizedInput.manufacturerDomain,
    queryVariants: normalizedInput.queryVariants,
  });

  // Optional Layer 0 fallback: infer manufacturer official domain/name from web.
  if (!normalizedInput.manufacturerDomain) {
    const resolved = await resolveManufacturerIdentity(normalizedInput.manufacturerName, log);
    if (resolved?.domain) {
      normalizedInput = {
        ...normalizedInput,
        manufacturerName: resolved.name || normalizedInput.manufacturerName,
        manufacturerDomain: resolved.domain,
        queryVariants: buildQueryVariants(normalizedInput.partNumber, resolved.name || normalizedInput.manufacturerName),
      };
      layersUsed.push("normalize_resolve");
      log("pipeline", "Layer 0 fallback resolved manufacturer identity", {
        manufacturerName: normalizedInput.manufacturerName,
        manufacturerDomain: normalizedInput.manufacturerDomain,
      });
    } else {
      log("pipeline", "Layer 0 fallback could not resolve manufacturer identity", {
        manufacturerName: normalizedInput.manufacturerName,
      });
    }
  }

  // ── Layer 1 ────────────────────────────────────────────────────────────────
  let layer1Urls: ScoredUrl[] = [];
  try {
    layer1Urls = await runLayer1Search(normalizedInput, log);
    layersUsed.push("search");
  } catch (err) {
    warnings.push(`Layer 1 search failed: ${String(err)}`);
    log("pipeline", "Layer 1 failed — continuing with empty results", { error: String(err) });
  }

  // ── Layer 2 ────────────────────────────────────────────────────────────────
  let layer2Urls: ScoredUrl[] = [];
  try {
    layer2Urls = await runLayer2Map(normalizedInput, log);
    if (layer2Urls.length > 0) layersUsed.push("map");
  } catch (err) {
    warnings.push(`Layer 2 map failed: ${String(err)}`);
    log("pipeline", "Layer 2 failed — continuing without map results", { error: String(err) });
  }

  // ── Merge URLs ─────────────────────────────────────────────────────────────
  const maxUrls = options.maxUrlsForExtraction ?? 14;
  const allUrls = mergeAndRankUrls(layer1Urls, layer2Urls).slice(0, maxUrls);
  const sourcesSearched = allUrls.length;

  log("pipeline", "URLs ready for extraction", {
    layer1Count: layer1Urls.length,
    layer2Count: layer2Urls.length,
    totalAfterMerge: allUrls.length,
    urls: allUrls.slice(0, 8).map((u) => `[${u.score}] ${u.url}`),
  });

  if (allUrls.length === 0) {
    warnings.push("No URLs found — returning empty result");
    return {
      partNumber: normalizedInput.partNumber,
      manufacturer: extractManufacturerInfo([], normalizedInput.manufacturerName, normalizedInput.manufacturerDomain),
      distributors: [],
      metadata: {
        sourcesSearched: 0,
        extractionTimeMs: Date.now() - startTime,
        layersUsed,
        warnings,
      },
    };
  }

  // ── Layer 3 ────────────────────────────────────────────────────────────────
  let rawDistributors: Array<RawDistributor & { _sourceUrl?: string; _sourceLayer?: string }> = [];
  try {
    const layer3Result = await runLayer3Extract(allUrls, log);
    rawDistributors = layer3Result.rawDistributors;
    layersUsed.push("extract");
  } catch (err) {
    warnings.push(`Layer 3 extraction failed: ${String(err)}`);
    log("pipeline", "Layer 3 failed — continuing", { error: String(err) });
  }

  // ── Layer 6 first pass (validate what we have) ─────────────────────────────
  let distributors = runLayer6Validate(rawDistributors, log);
  const withEmailAfterL3 = distributors.filter((d) => d.email).length;

  log("pipeline", "After Layer 3", {
    total: distributors.length,
    withEmail: withEmailAfterL3,
  });

  // ── Layer 4 ────────────────────────────────────────────────────────────────
  if (!options.skipDeepScrape && distributors.some((d) => !d.email)) {
    try {
      distributors = await runLayer4Scrape(distributors, log);
      layersUsed.push("deep_scrape");
    } catch (err) {
      warnings.push(`Layer 4 deep scrape failed: ${String(err)}`);
      log("pipeline", "Layer 4 failed — continuing", { error: String(err) });
    }
  }

  const withEmailAfterL4 = distributors.filter((d) => d.email).length;
  log("pipeline", "After Layer 4", {
    total: distributors.length,
    withEmail: withEmailAfterL4,
  });

  // ── Layer 5 ────────────────────────────────────────────────────────────────
  if (!options.skipAgent) {
    try {
      const agentResult = await runLayer5Agent(normalizedInput, withEmailAfterL4, log);
      if (agentResult.triggered && agentResult.distributors.length > 0) {
        // Parse agent results and merge into existing set
        const agentParsed = agentResult.distributors
          .map((d) => parseDistributor({ ...d, _sourceLayer: "agent" }))
          .filter((d): d is Distributor => d !== null);

        // Merge: add only if not already present by email or name
        const existingEmails = new Set(distributors.map((d) => d.email.toLowerCase()));
        const existingNames = new Set(
          distributors.map((d) => d.name.toLowerCase().replace(/[^a-z0-9]/g, "")),
        );

        for (const d of agentParsed) {
          const emailKey = d.email.toLowerCase();
          const nameKey = d.name.toLowerCase().replace(/[^a-z0-9]/g, "");
          if (
            (d.email && !existingEmails.has(emailKey)) ||
            (!d.email && !existingNames.has(nameKey))
          ) {
            distributors.push(d);
          }
        }

        layersUsed.push("agent");
        log("pipeline", "Agent merged results", {
          agentFound: agentParsed.length,
          newAdded: distributors.length - withEmailAfterL4,
        });
      }
    } catch (err) {
      warnings.push(`Layer 5 agent failed: ${String(err)}`);
      log("pipeline", "Layer 5 failed — continuing", { error: String(err) });
    }
  } else {
    log("pipeline", "Layer 5 skipped (skipAgent=true)");
  }

  // ── Layer 6 final pass ────────────────────────────────────────────────────
  const finalDistributors = runLayer6Validate(
    distributors.map((d) => ({
      name: d.name,
      email: d.email,
      phone: d.phone,
      website: d.website,
      region: d.region,
      isAuthorized: d.isAuthorized,
      stockAvailable: d.stockAvailable,
      _sourceLayer: d.sourceLayer,
      _sourceUrl: "",
    })),
    log,
  );
  layersUsed.push("validate");

  const manufacturer = extractManufacturerInfo(
    finalDistributors,
    normalizedInput.manufacturerName,
    normalizedInput.manufacturerDomain,
  );

  const extractionTimeMs = Date.now() - startTime;

  log("pipeline", "Pipeline complete", {
    totalDistributors: finalDistributors.length,
    withEmail: finalDistributors.filter((d) => d.email).length,
    sourcesSearched,
    layersUsed,
    extractionTimeMs,
    warnings: warnings.length > 0 ? warnings : undefined,
  });

  return {
    partNumber: normalizedInput.partNumber,
    manufacturer,
    distributors: finalDistributors,
    metadata: {
      sourcesSearched,
      extractionTimeMs,
      layersUsed,
      warnings,
    },
  };
}
