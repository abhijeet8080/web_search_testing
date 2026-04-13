# Firecrawl Pipeline Architecture

This project implements a **7-layer Firecrawl-driven procurement pipeline** that finds authorized distributors for a given part number and manufacturer, then validates and ranks the results.

## High-Level Flow

1. Input enters `runProcurementPipeline()` in `src/firecrawl/procurement.ts`.
2. Input is normalized and enriched (Layer 0).
3. Candidate URLs are gathered from:
   - web search (Layer 1), and
   - manufacturer site mapping (Layer 2).
4. Top URLs are scraped in structured JSON mode (Layer 3).
5. Missing contact fields are enriched via targeted contact-page scraping (Layer 4).
6. If coverage is still weak, autonomous browsing agent is triggered (Layer 5).
7. Final validation, deduplication, confidence scoring, and sorting are applied (Layer 6).
8. Pipeline returns `ProcurementOutput` with metadata, warnings, and ranked distributors.

---

## Architecture by Layer

## Layer 0 - Normalize and Prepare Queries
**File:** `src/firecrawl/layer0_normalize.ts`  
**Type:** Pure TypeScript (no API calls)

### Responsibility
- Sanitize raw inputs (`partNumber`, `manufacturerName`).
- Normalize manufacturer aliases (example: `TI` -> `Texas Instruments`).
- Resolve known official manufacturer domains from an internal mapping.
- Build query variants used by search in Layer 1.

### Why this layer exists
- Reduces search noise by standardizing naming.
- Improves recall by generating multiple intent-focused query forms.
- Gives later layers a stable, canonical input contract (`NormalizedInput`).

---

## Layer 1 - Parallel Web Search
**File:** `src/firecrawl/layer1_search.ts`  
**Firecrawl API:** `search`

### Responsibility
- Run multiple Firecrawl search queries in parallel (from Layer 0 query variants).
- Collect returned URLs, deduplicate, and assign relevance scores by domain quality.
- Boost known high-signal distributor domains (Octopart, Findchips, DigiKey, Mouser, etc.).
- Ensure manufacturer homepage is included if known.

### Why this layer exists
- Creates broad discovery coverage quickly.
- Prioritizes trusted sources before expensive extraction.

---

## Layer 2 - Manufacturer Domain Mapping
**File:** `src/firecrawl/layer2_map.ts`  
**Firecrawl API:** `map`

### Responsibility
- Crawl/map the manufacturer official domain using distributor-oriented search hints.
- Prefer URLs likely to contain authorized channel data (`/distributor`, `/where-to-buy`, `/partner`, etc.).
- Return a small high-confidence list of manufacturer-owned pages.

### Why this layer exists
- Manufacturer-hosted channel pages usually carry the strongest authorization signal.
- Complements Layer 1 by finding pages search engines may under-rank.

---

## Layer 3 - Structured Extraction from Top URLs
**File:** `src/firecrawl/layer3_extract.ts`  
**Firecrawl API:** `scrape` with JSON schema mode

### Responsibility
- Take top-scored URLs (merged from Layers 1 and 2).
- Scrape each URL in parallel batches (bounded concurrency).
- Use JSON schema + extraction prompt to return structured distributor records.
- Attach provenance metadata (`_sourceUrl`, `_sourceLayer`) for later scoring.

### Why this layer exists
- Converts unstructured pages into a consistent typed dataset.
- Preserves source lineage for trust/confidence decisions in Layer 6.

---

## Layer 4 - Deep Contact Enrichment
**File:** `src/firecrawl/layer4_scrape.ts`  
**Firecrawl APIs:** `map` + `scrape` (markdown + links)

### Responsibility
- Only for distributors missing email after Layer 3.
- Map each distributor domain to find likely contact/about/sales pages.
- Scrape content and links, then extract:
  - email from text and `mailto:` links,
  - phone from page text patterns.
- Merge enriched contact data back into distributor list.

### Why this layer exists
- Optimizes cost by enriching only incomplete records.
- Improves practical usability of output (contactability).

---

## Layer 5 - Autonomous Agent Fallback
**File:** `src/firecrawl/layer5_agent.ts`  
**Firecrawl API:** `agent`

### Responsibility
- Trigger only when distributor-email coverage is below threshold (`MIN_DISTRIBUTORS_WITH_EMAIL`).
- Ask agent to autonomously navigate manufacturer/distributor locator flows.
- Extract distributors via schema-guided output and merge non-duplicate results.

### Why this layer exists
- Handles JS-heavy, click-driven, or dynamically gated pages.
- Used as **last resort** due to higher cost/credit usage.

---

## Layer 6 - Validation, Deduplication, and Ranking
**File:** `src/firecrawl/layer6_validate.ts`  
**Type:** Pure TypeScript (no API calls)

### Responsibility
- Parse raw records into strict `Distributor` objects.
- Validate and filter email quality (remove placeholder/generic emails).
- Deduplicate using:
  1. email key (primary),
  2. normalized name key (fallback).
- Merge partial duplicates to keep best combined data.
- Compute completeness score and authorization confidence.
- Sort output for best-first downstream usage.

### Why this layer exists
- Ensures output quality and consistency before return.
- Converts noisy multi-source extractions into production-ready records.

---

## Orchestration Layer (Pipeline Controller)
**File:** `src/firecrawl/procurement.ts`

### Responsibility
- Controls layer ordering and optional fallbacks.
- Handles non-fatal failures per layer and accumulates warnings.
- Merges/scopes URL candidates before extraction.
- Performs intermediate and final validation passes.
- Builds final `ProcurementOutput` including:
  - `manufacturer`,
  - sorted `distributors`,
  - `metadata` (`sourcesSearched`, `layersUsed`, `warnings`, `extractionTimeMs`).

---

## Supporting Components

## Firecrawl Client Wrapper
**File:** `src/firecrawl/firecrawlClient.ts`
- Instantiates Firecrawl SDK using `FIRECRAWL_API_KEY`.
- Provides common utility helpers (`getDomain`, coercion helpers, logger type).
- Central place for Firecrawl client lifecycle and shared parsing utilities.

## Shared Contracts
**File:** `src/firecrawl/types.ts`
- Defines all cross-layer interfaces (`NormalizedInput`, `ScoredUrl`, `RawDistributor`, `Distributor`, `ProcurementOutput`).
- Houses shared schema and extraction prompt (`DISTRIBUTOR_SCHEMA`, `EXTRACT_PROMPT`) used in structured scraping and agent outputs.

---

## Data Flow Summary

`ProcurementInput`  
-> **Layer 0** (`NormalizedInput`)  
-> **Layer 1 + 2** (`ScoredUrl[]`)  
-> merge/rank/top-N selection  
-> **Layer 3** (`RawDistributor[]` + source metadata)  
-> **Layer 6 pass 1** (`Distributor[]`)  
-> **Layer 4** enrichment (optional)  
-> **Layer 5** agent fallback (conditional)  
-> **Layer 6 final** validation/ranking  
-> `ProcurementOutput`

---

## Design Principles in This Implementation

- **Progressive cost model:** cheap deterministic layers first, expensive autonomous layer last.
- **Graceful degradation:** each layer can fail independently without collapsing the whole pipeline.
- **Source-aware confidence:** provenance influences trust ranking.
- **Selective enrichment:** deep scraping is targeted only at incomplete records.
- **Deterministic finalization:** strict validation/dedup layer always runs before output.
