/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  AI Procurement Assistant — Firecrawl Test Harness
 *  Run: npm run test_firecrawl
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  CHANGE THESE PARAMETERS TO TEST DIFFERENT PARTS:
 */

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║                       ★ CHANGE THESE TO TEST ★                         ║
// ╠══════════════════════════════════════════════════════════════════════════╣

const PART_NUMBER = "TEKTON SHA04101 1/4 INCH DRIVE (F) X 3/8 INCH (M) ADAPTER";
const MANUFACTURER_NAME = "TEKTON";

/** Set to true to skip the autonomous agent (Layer 5) and save credits */
const SKIP_AGENT = process.env.SKIP_AGENT === "true" ? true : false;

/** Set to true to skip the deep contact-page scrape (Layer 4) */
const SKIP_DEEP_SCRAPE = process.env.SKIP_DEEP_SCRAPE === "true" ? true : false;

/**
 * Maximum number of URLs to pass into Layer 3 extraction.
 * Lower = faster & cheaper. Higher = more coverage.
 * Recommended: 10–16
 */
const MAX_URLS = Number(process.env.MAX_URLS ?? "12");

// ╚══════════════════════════════════════════════════════════════════════════╝

import { runProcurementPipeline } from "./firecrawl/procurement.js";
import type { Logger } from "./firecrawl/firecrawlClient.js";
import type { Distributor } from "./firecrawl/types.js";

const LOG_PREFIX = "[test_firecrawl]";

type LayerDetailSnapshot = {
  layer0?: {
    normalizedPartNumber: string;
    normalizedManufacturer: string;
    manufacturerDomain: string;
    queryVariants: string[];
  };
  layer1?: {
    querySummaries: Array<{ query: string; results: number; topUrls: string[] }>;
    mergedUniqueUrls: string[];
  };
  layer2?: {
    manufacturerMapLinks: string[];
    selectedPages: string[];
  };
  layer3?: {
    extractionInputUrls: string[];
    scrapeSummaries: Array<{ url: string; source: string; distributorsFound: number }>;
    rawDistributorCount: number;
    afterValidate: { total: number; withEmail: number };
  };
  layer4?: {
    enrichmentRuns: Array<{ distributor: string; domain?: string; contactUrl?: string }>;
    enrichmentSummaries: Array<{ distributor: string; foundEmail: string; foundPhone: string }>;
    afterLayer4: { total: number; withEmail: number };
  };
  layer5?: {
    triggered: boolean;
    reason?: string;
    seedUrls: string[];
    promptPreview?: string;
    agentRawCount?: number;
    mergedAdded?: number;
  };
  layer6?: {
    parsedCount?: number;
    topScores?: string[];
  };
};

const layerDetails: LayerDetailSnapshot = {
  layer1: { querySummaries: [], mergedUniqueUrls: [] },
  layer2: { manufacturerMapLinks: [], selectedPages: [] },
  layer3: { extractionInputUrls: [], scrapeSummaries: [], rawDistributorCount: 0, afterValidate: { total: 0, withEmail: 0 } },
  layer4: { enrichmentRuns: [], enrichmentSummaries: [], afterLayer4: { total: 0, withEmail: 0 } },
  layer5: { triggered: false, seedUrls: [] },
  layer6: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => asString(item)).filter(Boolean) : [];
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function captureLayerDetails(stage: string, message: string, data?: unknown): void {
  if (stage === "pipeline" && message === "Layer 0 complete" && isRecord(data)) {
    layerDetails.layer0 = {
      normalizedPartNumber: asString(data.partNumber),
      normalizedManufacturer: asString(data.manufacturerName),
      manufacturerDomain: asString(data.manufacturerDomain),
      queryVariants: asStringArray(data.queryVariants),
    };
    return;
  }

  if (stage === "layer1" && message.startsWith("Query ") && message.includes(" returned ") && isRecord(data)) {
    const query = asString(data.query);
    const topUrls = asStringArray(data.topUrls);
    const results = Number(message.match(/returned (\d+) results/)?.[1] ?? "0");
    layerDetails.layer1?.querySummaries.push({ query, results, topUrls });
    return;
  }

  if (stage === "layer1" && message === "Search complete" && isRecord(data)) {
    layerDetails.layer1 = {
      querySummaries: layerDetails.layer1?.querySummaries ?? [],
      mergedUniqueUrls: asStringArray(data.topUrls),
    };
    return;
  }

  if (stage === "layer2" && message === "Map returned" && isRecord(data)) {
    layerDetails.layer2 = {
      manufacturerMapLinks: asStringArray(data.previewLinks),
      selectedPages: layerDetails.layer2?.selectedPages ?? [],
    };
    return;
  }

  if (stage === "layer2" && message === "Selected manufacturer pages for extraction" && isRecord(data)) {
    layerDetails.layer2 = {
      manufacturerMapLinks: layerDetails.layer2?.manufacturerMapLinks ?? [],
      selectedPages: asStringArray(data.urls),
    };
    return;
  }

  if (stage === "pipeline" && message === "URLs ready for extraction" && isRecord(data)) {
    layerDetails.layer3 = {
      extractionInputUrls: asStringArray(data.urls),
      scrapeSummaries: layerDetails.layer3?.scrapeSummaries ?? [],
      rawDistributorCount: layerDetails.layer3?.rawDistributorCount ?? 0,
      afterValidate: layerDetails.layer3?.afterValidate ?? { total: 0, withEmail: 0 },
    };
    return;
  }

  if (stage === "layer3" && message.startsWith("Scraped ") && isRecord(data)) {
    const match = message.match(/^Scraped (.+) → (\d+) distributors$/);
    layerDetails.layer3?.scrapeSummaries.push({
      url: match?.[1] ?? "",
      source: asString(data.source),
      distributorsFound: Number(match?.[2] ?? "0"),
    });
    return;
  }

  if (stage === "layer3" && message === "Extraction complete" && isRecord(data)) {
    layerDetails.layer3 = {
      extractionInputUrls: layerDetails.layer3?.extractionInputUrls ?? [],
      scrapeSummaries: layerDetails.layer3?.scrapeSummaries ?? [],
      rawDistributorCount: asNumber(data.rawDistributorCount),
      afterValidate: layerDetails.layer3?.afterValidate ?? { total: 0, withEmail: 0 },
    };
    return;
  }

  if (stage === "pipeline" && message === "After Layer 3" && isRecord(data)) {
    layerDetails.layer3 = {
      extractionInputUrls: layerDetails.layer3?.extractionInputUrls ?? [],
      scrapeSummaries: layerDetails.layer3?.scrapeSummaries ?? [],
      rawDistributorCount: layerDetails.layer3?.rawDistributorCount ?? 0,
      afterValidate: {
        total: asNumber(data.total),
        withEmail: asNumber(data.withEmail),
      },
    };
    return;
  }

  if (stage === "layer4" && message.startsWith("Enriching ") && isRecord(data)) {
    layerDetails.layer4?.enrichmentRuns.push({
      distributor: message.replace("Enriching ", ""),
      domain: asString(data.domain),
    });
    return;
  }

  if (stage === "layer4" && message.startsWith("Contact URL for ") && isRecord(data)) {
    const distributor = message.replace("Contact URL for ", "");
    const last = layerDetails.layer4?.enrichmentRuns.find((entry) => entry.distributor === distributor);
    if (last) last.contactUrl = asString(data.contactUrl);
    return;
  }

  if (stage === "layer4" && message.startsWith("Enrichment result for ") && isRecord(data)) {
    layerDetails.layer4?.enrichmentSummaries.push({
      distributor: message.replace("Enrichment result for ", ""),
      foundEmail: asString(data.foundEmail),
      foundPhone: asString(data.foundPhone),
    });
    return;
  }

  if (stage === "pipeline" && message === "After Layer 4" && isRecord(data)) {
    layerDetails.layer4 = {
      enrichmentRuns: layerDetails.layer4?.enrichmentRuns ?? [],
      enrichmentSummaries: layerDetails.layer4?.enrichmentSummaries ?? [],
      afterLayer4: {
        total: asNumber(data.total),
        withEmail: asNumber(data.withEmail),
      },
    };
    return;
  }

  if (stage === "layer5" && message === "Triggering autonomous agent" && isRecord(data)) {
    layerDetails.layer5 = {
      triggered: true,
      reason: asString(data.reason),
      seedUrls: asStringArray(data.urls),
      promptPreview: asString(data.promptPreview),
      agentRawCount: layerDetails.layer5?.agentRawCount,
      mergedAdded: layerDetails.layer5?.mergedAdded,
    };
    return;
  }

  if (stage === "layer5" && message === "Sufficient distributors found — agent not needed" && isRecord(data)) {
    layerDetails.layer5 = {
      triggered: false,
      reason: `Count ${asNumber(data.count)} >= threshold ${asNumber(data.threshold)}`,
      seedUrls: [],
    };
    return;
  }

  if (stage === "layer5" && message === "Agent complete" && isRecord(data)) {
    layerDetails.layer5 = {
      triggered: layerDetails.layer5?.triggered ?? true,
      reason: layerDetails.layer5?.reason,
      seedUrls: layerDetails.layer5?.seedUrls ?? [],
      promptPreview: layerDetails.layer5?.promptPreview,
      agentRawCount: asNumber(data.rawCount),
      mergedAdded: layerDetails.layer5?.mergedAdded,
    };
    return;
  }

  if (stage === "pipeline" && message === "Agent merged results" && isRecord(data)) {
    layerDetails.layer5 = {
      triggered: layerDetails.layer5?.triggered ?? true,
      reason: layerDetails.layer5?.reason,
      seedUrls: layerDetails.layer5?.seedUrls ?? [],
      promptPreview: layerDetails.layer5?.promptPreview,
      agentRawCount: layerDetails.layer5?.agentRawCount,
      mergedAdded: asNumber(data.newAdded),
    };
    return;
  }

  if (stage === "layer6" && message.startsWith("Parsed: ")) {
    const parsed = Number(message.match(/^Parsed: (\d+) valid records$/)?.[1] ?? "0");
    layerDetails.layer6 = {
      parsedCount: parsed,
      topScores: layerDetails.layer6?.topScores,
    };
    return;
  }

  if (stage === "layer6" && message === "Validation complete" && isRecord(data)) {
    layerDetails.layer6 = {
      parsedCount: layerDetails.layer6?.parsedCount,
      topScores: asStringArray(data.topScores),
    };
  }
}

function pickDistributors(distributors: Distributor[], limit: number): Array<Record<string, unknown>> {
  return distributors.slice(0, limit).map((d) => ({
    name: d.name,
    email: d.email,
    phone: d.phone,
    website: d.website,
    region: d.region,
    sourceLayer: d.sourceLayer,
    authorizedConfidence: d.authorizedConfidence,
    dataCompleteness: d.dataCompleteness,
  }));
}

/** Stage-aware logger that outputs to stderr (keeps stdout clean for JSON) */
const log: Logger = (stage: string, message: string, data?: unknown) => {
  captureLayerDetails(stage, message, data);
  const line = `${LOG_PREFIX} [${stage}] ${message}`;
  if (data === undefined) {
    console.error(line);
  } else {
    console.error(`${line}\n${JSON.stringify(data, null, 2)}`);
  }
};

// ─── Banner ───────────────────────────────────────────────────────────────────

console.error("─".repeat(72));
console.error(`${LOG_PREFIX} AI Procurement Assistant — Firecrawl Pipeline`);
console.error("─".repeat(72));
log("init", "Test parameters", {
  PART_NUMBER,
  MANUFACTURER_NAME,
  SKIP_AGENT,
  SKIP_DEEP_SCRAPE,
  MAX_URLS,
});
console.error("─".repeat(72));

// ─── Run pipeline ─────────────────────────────────────────────────────────────

const result = await runProcurementPipeline(
  {
    partNumber: PART_NUMBER,
    manufacturerName: MANUFACTURER_NAME,
  },
  {
    log,
    skipAgent: SKIP_AGENT,
    skipDeepScrape: SKIP_DEEP_SCRAPE,
    maxUrlsForExtraction: MAX_URLS,
  },
);

// ─── Summary to stderr ───────────────────────────────────────────────────────

console.error("─".repeat(72));
log("layer_details", "Detailed results found in each layer", {
  layer0: layerDetails.layer0,
  layer1: layerDetails.layer1,
  layer2: layerDetails.layer2,
  layer3: layerDetails.layer3,
  layer4: layerDetails.layer4,
  layer5: layerDetails.layer5,
  layer6: layerDetails.layer6,
  final: {
    partNumber: result.partNumber,
    manufacturer: result.manufacturer,
    topDistributors: pickDistributors(result.distributors, 10),
    warnings: result.metadata.warnings,
  },
});
console.error("─".repeat(72));
log("result", "Pipeline finished", {
  partNumber: result.partNumber,
  manufacturer: result.manufacturer?.name ?? "(not found)",
  totalDistributors: result.distributors.length,
  withEmail: result.distributors.filter((d) => d.email).length,
  withPhone: result.distributors.filter((d) => d.phone).length,
  highConfidence: result.distributors.filter((d) => d.authorizedConfidence === "high").length,
  layersUsed: result.metadata.layersUsed,
  sourcesSearched: result.metadata.sourcesSearched,
  extractionTimeMs: result.metadata.extractionTimeMs,
  warnings: result.metadata.warnings.length > 0 ? result.metadata.warnings : undefined,
});
console.error("─".repeat(72));

// ─── Full JSON output to stdout ───────────────────────────────────────────────

console.log(JSON.stringify(result, null, 2));
