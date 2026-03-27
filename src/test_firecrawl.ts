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

const PART_NUMBER = process.env.PART_NUMBER ?? "6314-2ZJEM C3 BEARING RIGID W/ROW OF BALL 150MM O.D X 70MM I.D X 35 MM WIDTH";
const MANUFACTURER_NAME = process.env.MANUFACTURER_NAME ?? "SKF";

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

const LOG_PREFIX = "[test_firecrawl]";

/** Stage-aware logger that outputs to stderr (keeps stdout clean for JSON) */
const log: Logger = (stage: string, message: string, data?: unknown) => {
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
