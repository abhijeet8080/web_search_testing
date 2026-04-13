/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  AI Procurement Assistant — Firecrawl Test Harness
 *  Run: npm run test_firecrawl
 *
 *  Reads part + manufacturer pairs from items.txt (item line, then manufacturer line;
 *  blank lines ignored). Override path with ITEMS_FILE. Results append to
 *  firecrawl-results.json after each item (override with RESULTS_JSON).
 *
 *  Layer 5 (autonomous agent) runs when fewer than 3 distributors have emails after
 *  Layer 4 and can take a very long time or appear stuck. For multiple items from
 *  items.txt, Layer 5 is skipped by default so the batch always advances. Override:
 *    SKIP_AGENT=false  — run the agent for every item (may be slow)
 *    SKIP_AGENT=true   — always skip the agent
 *  With a single item (or env fallback), the default is to allow the agent unless
 *  SKIP_AGENT=true.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { runProcurementPipeline } from "./firecrawl/procurement.js";
import type { Logger } from "./firecrawl/firecrawlClient.js";
import type { Distributor, ProcurementOutput } from "./firecrawl/types.js";

/** Set to true to skip the deep contact-page scrape (Layer 4) */
const SKIP_DEEP_SCRAPE = process.env.SKIP_DEEP_SCRAPE === "true" ? true : false;

/**
 * Maximum number of URLs to pass into Layer 3 extraction.
 * Lower = faster & cheaper. Higher = more coverage.
 * Recommended: 10–16
 */
const MAX_URLS = Number(process.env.MAX_URLS ?? "12");

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

type FirecrawlItemResult =
  | {
      success: true;
      input: { partNumber: string; manufacturerName: string };
      output: ProcurementOutput;
      layerDetails: LayerDetailSnapshot;
    }
  | {
      success: false;
      input: { partNumber: string; manufacturerName: string };
      error: string;
    };

type FirecrawlResultsFile = {
  generatedAt: string;
  updatedAt: string;
  itemsFile: string;
  resultsJsonPath: string;
  results: FirecrawlItemResult[];
};

function emptyLayerSnapshot(): LayerDetailSnapshot {
  return {
    layer1: { querySummaries: [], mergedUniqueUrls: [] },
    layer2: { manufacturerMapLinks: [], selectedPages: [] },
    layer3: {
      extractionInputUrls: [],
      scrapeSummaries: [],
      rawDistributorCount: 0,
      afterValidate: { total: 0, withEmail: 0 },
    },
    layer4: { enrichmentRuns: [], enrichmentSummaries: [], afterLayer4: { total: 0, withEmail: 0 } },
    layer5: { triggered: false, seedUrls: [] },
    layer6: {},
  };
}

/**
 * After stripping empty lines, lines go [item, mfg, item, mfg, ...].
 */
function parseItemsTxt(content: string): Array<{ partNumber: string; manufacturerName: string }> {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const pairs: Array<{ partNumber: string; manufacturerName: string }> = [];
  for (let i = 0; i < lines.length; i += 2) {
    const partNumber = lines[i]!;
    const manufacturerName = lines[i + 1];
    if (manufacturerName === undefined) {
      console.error(
        `${LOG_PREFIX} [parse] Odd number of non-empty lines; last part has no manufacturer row`,
        partNumber,
      );
      break;
    }
    pairs.push({ partNumber, manufacturerName });
  }
  return pairs;
}

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

function captureLayerDetails(snapshot: LayerDetailSnapshot, stage: string, message: string, data?: unknown): void {
  if (stage === "pipeline" && message === "Layer 0 complete" && isRecord(data)) {
    snapshot.layer0 = {
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
    snapshot.layer1?.querySummaries.push({ query, results, topUrls });
    return;
  }

  if (stage === "layer1" && message === "Search complete" && isRecord(data)) {
    snapshot.layer1 = {
      querySummaries: snapshot.layer1?.querySummaries ?? [],
      mergedUniqueUrls: asStringArray(data.topUrls),
    };
    return;
  }

  if (stage === "layer2" && message === "Map returned" && isRecord(data)) {
    snapshot.layer2 = {
      manufacturerMapLinks: asStringArray(data.previewLinks),
      selectedPages: snapshot.layer2?.selectedPages ?? [],
    };
    return;
  }

  if (stage === "layer2" && message === "Selected manufacturer pages for extraction" && isRecord(data)) {
    snapshot.layer2 = {
      manufacturerMapLinks: snapshot.layer2?.manufacturerMapLinks ?? [],
      selectedPages: asStringArray(data.urls),
    };
    return;
  }

  if (stage === "pipeline" && message === "URLs ready for extraction" && isRecord(data)) {
    snapshot.layer3 = {
      extractionInputUrls: asStringArray(data.urls),
      scrapeSummaries: snapshot.layer3?.scrapeSummaries ?? [],
      rawDistributorCount: snapshot.layer3?.rawDistributorCount ?? 0,
      afterValidate: snapshot.layer3?.afterValidate ?? { total: 0, withEmail: 0 },
    };
    return;
  }

  if (stage === "layer3" && message.startsWith("Scraped ") && isRecord(data)) {
    const match = message.match(/^Scraped (.+) → (\d+) distributors$/);
    snapshot.layer3?.scrapeSummaries.push({
      url: match?.[1] ?? "",
      source: asString(data.source),
      distributorsFound: Number(match?.[2] ?? "0"),
    });
    return;
  }

  if (stage === "layer3" && message === "Extraction complete" && isRecord(data)) {
    snapshot.layer3 = {
      extractionInputUrls: snapshot.layer3?.extractionInputUrls ?? [],
      scrapeSummaries: snapshot.layer3?.scrapeSummaries ?? [],
      rawDistributorCount: asNumber(data.rawDistributorCount),
      afterValidate: snapshot.layer3?.afterValidate ?? { total: 0, withEmail: 0 },
    };
    return;
  }

  if (stage === "pipeline" && message === "After Layer 3" && isRecord(data)) {
    snapshot.layer3 = {
      extractionInputUrls: snapshot.layer3?.extractionInputUrls ?? [],
      scrapeSummaries: snapshot.layer3?.scrapeSummaries ?? [],
      rawDistributorCount: snapshot.layer3?.rawDistributorCount ?? 0,
      afterValidate: {
        total: asNumber(data.total),
        withEmail: asNumber(data.withEmail),
      },
    };
    return;
  }

  if (stage === "layer4" && message.startsWith("Enriching ") && isRecord(data)) {
    snapshot.layer4?.enrichmentRuns.push({
      distributor: message.replace("Enriching ", ""),
      domain: asString(data.domain),
    });
    return;
  }

  if (stage === "layer4" && message.startsWith("Contact URL for ") && isRecord(data)) {
    const distributor = message.replace("Contact URL for ", "");
    const last = snapshot.layer4?.enrichmentRuns.find((entry) => entry.distributor === distributor);
    if (last) last.contactUrl = asString(data.contactUrl);
    return;
  }

  if (stage === "layer4" && message.startsWith("Enrichment result for ") && isRecord(data)) {
    snapshot.layer4?.enrichmentSummaries.push({
      distributor: message.replace("Enrichment result for ", ""),
      foundEmail: asString(data.foundEmail),
      foundPhone: asString(data.foundPhone),
    });
    return;
  }

  if (stage === "pipeline" && message === "After Layer 4" && isRecord(data)) {
    snapshot.layer4 = {
      enrichmentRuns: snapshot.layer4?.enrichmentRuns ?? [],
      enrichmentSummaries: snapshot.layer4?.enrichmentSummaries ?? [],
      afterLayer4: {
        total: asNumber(data.total),
        withEmail: asNumber(data.withEmail),
      },
    };
    return;
  }

  if (stage === "layer5" && message === "Triggering autonomous agent" && isRecord(data)) {
    snapshot.layer5 = {
      triggered: true,
      reason: asString(data.reason),
      seedUrls: asStringArray(data.urls),
      promptPreview: asString(data.promptPreview),
      agentRawCount: snapshot.layer5?.agentRawCount,
      mergedAdded: snapshot.layer5?.mergedAdded,
    };
    return;
  }

  if (stage === "layer5" && message === "Sufficient distributors found — agent not needed" && isRecord(data)) {
    snapshot.layer5 = {
      triggered: false,
      reason: `Count ${asNumber(data.count)} >= threshold ${asNumber(data.threshold)}`,
      seedUrls: [],
    };
    return;
  }

  if (stage === "layer5" && message === "Agent complete" && isRecord(data)) {
    snapshot.layer5 = {
      triggered: snapshot.layer5?.triggered ?? true,
      reason: snapshot.layer5?.reason,
      seedUrls: snapshot.layer5?.seedUrls ?? [],
      promptPreview: snapshot.layer5?.promptPreview,
      agentRawCount: asNumber(data.rawCount),
      mergedAdded: snapshot.layer5?.mergedAdded,
    };
    return;
  }

  if (stage === "pipeline" && message === "Agent merged results" && isRecord(data)) {
    snapshot.layer5 = {
      triggered: snapshot.layer5?.triggered ?? true,
      reason: snapshot.layer5?.reason,
      seedUrls: snapshot.layer5?.seedUrls ?? [],
      promptPreview: snapshot.layer5?.promptPreview,
      agentRawCount: snapshot.layer5?.agentRawCount,
      mergedAdded: asNumber(data.newAdded),
    };
    return;
  }

  if (stage === "pipeline" && message === "Layer 5 skipped — fewer than minimum distributors" && isRecord(data)) {
    snapshot.layer5 = {
      triggered: false,
      reason: `Only ${asNumber(data.total)} distributor(s); minimum ${asNumber(data.minimumRequired)} required for agent`,
      seedUrls: [],
    };
    return;
  }

  if (stage === "layer6" && message.startsWith("Parsed: ")) {
    const parsed = Number(message.match(/^Parsed: (\d+) valid records$/)?.[1] ?? "0");
    snapshot.layer6 = {
      parsedCount: parsed,
      topScores: snapshot.layer6?.topScores,
    };
    return;
  }

  if (stage === "layer6" && message === "Validation complete" && isRecord(data)) {
    snapshot.layer6 = {
      parsedCount: snapshot.layer6?.parsedCount,
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

function createPipelineLogger(snapshot: LayerDetailSnapshot): Logger {
  return (stage: string, message: string, data?: unknown) => {
    captureLayerDetails(snapshot, stage, message, data);
    const line = `${LOG_PREFIX} [${stage}] ${message}`;
    if (data === undefined) {
      console.error(line);
    } else {
      console.error(`${line}\n${JSON.stringify(data, null, 2)}`);
    }
  };
}

const itemsPath = process.env.ITEMS_FILE ?? join(process.cwd(), "items.txt");
const resultsPath = process.env.RESULTS_JSON ?? join(process.cwd(), "firecrawl-results.json");

let items: Array<{ partNumber: string; manufacturerName: string }>;
try {
  const raw = await readFile(itemsPath, "utf8");
  items = parseItemsTxt(raw);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${LOG_PREFIX} [init] Could not read ${itemsPath}: ${message}. Falling back to env defaults.`);
  items = [
    {
      partNumber:
        process.env.PART_NUMBER ?? "TEKTON SHA04101 1/4 INCH DRIVE (F) X 3/8 INCH (M) ADAPTER",
      manufacturerName: process.env.MANUFACTURER_NAME ?? "TEKTON",
    },
  ];
}

if (items.length === 0) {
  console.error(`${LOG_PREFIX} [init] No items parsed; using env defaults.`);
  items = [
    {
      partNumber:
        process.env.PART_NUMBER ?? "TEKTON SHA04101 1/4 INCH DRIVE (F) X 3/8 INCH (M) ADAPTER",
      manufacturerName: process.env.MANUFACTURER_NAME ?? "TEKTON",
    },
  ];
}

/**
 * When SKIP_AGENT is unset: skip Layer 5 for multi-item batches only (avoids long agent runs).
 * SKIP_AGENT=true → always skip; SKIP_AGENT=false → always run agent when eligible.
 */
function resolveSkipAgent(itemCount: number): boolean {
  if (process.env.SKIP_AGENT === "false") return false;
  if (process.env.SKIP_AGENT === "true") return true;
  return itemCount > 1;
}

const skipAgent = resolveSkipAgent(items.length);

const generatedAt = new Date().toISOString();
const results: FirecrawlItemResult[] = [];

async function persistResultsToJson(): Promise<void> {
  const payload: FirecrawlResultsFile = {
    generatedAt,
    updatedAt: new Date().toISOString(),
    itemsFile: itemsPath,
    resultsJsonPath: resultsPath,
    results,
  };
  await writeFile(resultsPath, JSON.stringify(payload, null, 2), "utf8");
}

// ─── Banner ───────────────────────────────────────────────────────────────────

console.error("─".repeat(72));
console.error(`${LOG_PREFIX} AI Procurement Assistant — Firecrawl Pipeline`);
console.error("─".repeat(72));
console.error(
  `${LOG_PREFIX} [init] Batch`,
  JSON.stringify(
    {
      itemCount: items.length,
      itemsFile: itemsPath,
      resultsJsonPath: resultsPath,
      skipAgent,
      SKIP_AGENT_env: process.env.SKIP_AGENT ?? "(unset)",
      SKIP_DEEP_SCRAPE,
      MAX_URLS,
    },
    null,
    2,
  ),
);
console.error("─".repeat(72));

// ─── Run pipeline per item; write JSON after each item completes ───────────────

for (let i = 0; i < items.length; i++) {
  const { partNumber, manufacturerName } = items[i]!;
  const label = `${i + 1}/${items.length}`;
  const layerSnapshot = emptyLayerSnapshot();
  const log = createPipelineLogger(layerSnapshot);

  log("init", `[${label}] Starting`, { partNumber, manufacturerName });

  try {
    const result = await runProcurementPipeline(
      { partNumber, manufacturerName },
      {
        log,
        skipAgent,
        skipDeepScrape: SKIP_DEEP_SCRAPE,
        maxUrlsForExtraction: MAX_URLS,
      },
    );

    console.error("─".repeat(72));
    log("layer_details", "Detailed results found in each layer", {
      layer0: layerSnapshot.layer0,
      layer1: layerSnapshot.layer1,
      layer2: layerSnapshot.layer2,
      layer3: layerSnapshot.layer3,
      layer4: layerSnapshot.layer4,
      layer5: layerSnapshot.layer5,
      layer6: layerSnapshot.layer6,
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

    results.push({
      success: true,
      input: { partNumber, manufacturerName },
      output: result,
      layerDetails: layerSnapshot,
    });

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} [${label}] Failed`, error);
    results.push({
      success: false,
      input: { partNumber, manufacturerName },
      error,
    });
  }

  await persistResultsToJson();
  console.error(`${LOG_PREFIX} [persist] Wrote ${results.length} result(s) to ${resultsPath}`);
}

console.error(`${LOG_PREFIX} [done] Batch complete. ${results.filter((r) => r.success).length} ok, ${results.filter((r) => !r.success).length} failed.`);
