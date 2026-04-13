/**
 * Product URL Discovery Pipeline
 *
 * 3-stage pipeline:
 *   1) Exa search (domain-scoped when vendorWebsite is provided)
 *   2) Firecrawl scrape (fetch real page content for candidates)
 *   3) LLM verify (confirm product match and return buyer notes)
 */
 
import OpenAI from "openai";
 
// ─── Client Initialisation ────────────────────────────────────────────────────
 
const EXA_API_KEY = process.env.EXA_API_KEY;
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o";
 
if (!EXA_API_KEY) throw new Error("EXA_API_KEY is required");
if (!FIRECRAWL_API_KEY) throw new Error("FIRECRAWL_API_KEY is required");
if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
 
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
 
// ─── Types ────────────────────────────────────────────────────────────────────
 
export interface VendorProductUrlNotesParams {
  itemDescription: string;
  manufacturer: string | null;
  quantity: number;
  vendorCompanyName?: string;
  /** Full URL or bare domain, e.g. "https://www.grainger.com" or "grainger.com" */
  vendorWebsite?: string;
}
 
export interface VendorProductUrlNotesResult {
  success: boolean;
  productUrl?: string | null;
  notes?: string | null;
  /** 0–1, how confident the LLM is in the match */
  confidenceScore?: number;
  /** Which stage produced the final result or where the pipeline failed */
  stage?: "exa" | "firecrawl_scrape" | "llm_verify" | "failed";
}
 
interface CandidateUrl {
  url: string;
  title?: string;
  snippet?: string;
  source: "exa";
}
 
interface ScrapedPage {
  url: string;
  markdown: string;
  title?: string;
}
 
interface VerificationResult {
  url: string | null;
  isMatch: boolean;
  confidence: number;
  notes: string | null;
  reason: string;
}
 
// ─── Helpers ──────────────────────────────────────────────────────────────────
 
function extractDomain(url: string): string {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
 
function buildSearchQuery(params: VendorProductUrlNotesParams): string {
  const parts: string[] = [];
  if (params.manufacturer) parts.push(params.manufacturer);
  parts.push(params.itemDescription);
  return parts.join(" ");
}
 
// ─── Stage 1: Exa search ──────────────────────────────────────────────────────
 
/**
 * Primary search using Exa neural search.
 * When vendorWebsite is set the search is domain-scoped.
 */
async function searchWithExa(
  params: VendorProductUrlNotesParams,
  maxResults = 5
): Promise<CandidateUrl[]> {
  const { vendorWebsite, vendorCompanyName } = params;
  let query = buildSearchQuery(params);
 
  const requestBody: Record<string, unknown> = {
    numResults: maxResults,
    type: "neural",
    useAutoprompt: true,
    contents: { text: { maxCharacters: 400 } },
  };
 
  if (vendorWebsite) {
    const domain = extractDomain(vendorWebsite);
    requestBody.includeDomains = [domain];
    requestBody.query = query;
    console.log(`[Stage 1 – Exa] 🔍 Domain-scoped search on ${domain}`);
  } else {
    // No vendor site: bias toward the right vendor using their company name
    query = `${vendorCompanyName ? vendorCompanyName + " " : ""}${query} product page`;
    requestBody.query = query;
    console.log(`[Stage 1 – Exa] 🔍 Open search: "${query}"`);
  }
 
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": EXA_API_KEY!,
    },
    body: JSON.stringify(requestBody),
  });
 
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Exa search failed (${response.status}): ${err}`);
  }
 
  const data = (await response.json()) as {
    results: Array<{ url: string; title: string; score: number; text?: string }>;
  };
 
  const candidates: CandidateUrl[] = (data.results ?? []).map((r) => ({
    url: r.url,
    title: r.title,
    snippet: r.text,
    source: "exa" as const,
  }));
 
  console.log(
    `[Exa] ✅ ${candidates.length} candidates:`,
    candidates.map((c) => c.url)
  );
 
  return candidates;
}
 
// ─── Stage 1 orchestration ────────────────────────────────────────────────────

async function findCandidateUrls(params: VendorProductUrlNotesParams): Promise<{
  candidates: CandidateUrl[];
  searchStage: "exa";
}> {
  const exaResults = await searchWithExa(params, 5);
  return { candidates: exaResults, searchStage: "exa" };
}
 
// ─── Stage 2: Firecrawl scrape ────────────────────────────────────────────────
 
/**
 * Scrapes the top N candidate pages in parallel and returns clean markdown.
 */
async function scrapePages(
  candidates: CandidateUrl[],
  maxPages = 3
): Promise<ScrapedPage[]> {
  const targets = candidates.slice(0, maxPages);
  console.log(`[Stage 2 – Firecrawl Scrape] 🕷️  Scraping ${targets.length} page(s)...`);
 
  const settled = await Promise.allSettled(targets.map((c) => scrapeOnePage(c.url)));
 
  const pages: ScrapedPage[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) pages.push(r.value);
  }
 
  console.log(
    `[Stage 2 – Firecrawl Scrape] ✅ ${pages.length}/${targets.length} scraped successfully`
  );
  return pages;
}
 
async function scrapeOnePage(url: string): Promise<ScrapedPage | null> {
  try {
    const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,   // strip nav / footer / sidebar noise
        waitFor: 2000,           // wait for JS-rendered product data to appear
        timeout: 20000,
      }),
    });
 
    if (!response.ok) {
      console.warn(`[Stage 2 – Firecrawl Scrape] ⚠️  ${url} — HTTP ${response.status}`);
      return null;
    }
 
    const data = (await response.json()) as {
      success: boolean;
      data?: { markdown?: string; metadata?: { title?: string } };
    };
 
    if (!data.success || !data.data?.markdown) {
      console.warn(`[Stage 2 – Firecrawl Scrape] ⚠️  No content for ${url}`);
      return null;
    }
 
    // 4 000 chars covers any product page without bloating the LLM prompt
    return {
      url,
      markdown: data.data.markdown.slice(0, 4000),
      title: data.data.metadata?.title,
    };
  } catch (err) {
    console.error(`[Stage 2 – Firecrawl Scrape] ❌ ${url}:`, err);
    return null;
  }
}
 
// ─── Stage 3: LLM verification ────────────────────────────────────────────────
 
/**
 * The LLM acts as a judge — not a finder.
 * It evaluates real scraped content and decides if any page is the right product.
 */
async function verifyWithLlm(
  params: VendorProductUrlNotesParams,
  pages: ScrapedPage[]
): Promise<VerificationResult> {
  if (pages.length === 0) {
    return { url: null, isMatch: false, confidence: 0, notes: null, reason: "No pages scraped" };
  }
 
  const { itemDescription, manufacturer, quantity } = params;
 
  const pagesBlock = pages
    .map(
      (p, i) => `
=== Page ${i + 1} ===
URL: ${p.url}
Title: ${p.title ?? "n/a"}
---
${p.markdown}
`
    )
    .join("\n");
 
  const prompt = `You are a meticulous procurement specialist. Your only job is to verify \
whether any of the scraped product pages below match the required item. You are NOT searching \
the web — judge solely from the content provided.
 
## Required item
- Description : ${itemDescription}
- Manufacturer: ${manufacturer ?? "any / unknown"}
- Quantity     : ${quantity}
 
## Scraped pages
${pagesBlock}
 
## Instructions
1. Find the single best-matching page. It MUST be a genuine product detail page \
   (not a category listing, search results page, homepage, or blog post).
2. The part number, brand, and key specs on the page must align with the required item.
3. Assign a confidence score 0.0–1.0:
   - 0.9–1.0 : Part number explicitly confirmed on page
   - 0.7–0.89: Brand + description match well, specs align
   - 0.5–0.69: Description roughly matches but key identifiers missing
   - < 0.5   : Too uncertain — set isMatch false
4. If isMatch is true, write concise buyer notes (≤ 200 chars): include part #, \
   pack size, or lead-time hint if visible on the page.
 
Return ONLY valid JSON — no markdown fences:
{
  "bestPageIndex": <0-based integer, or -1 if no match>,
  "isMatch": <true | false>,
  "confidence": <0.0–1.0>,
  "notes": "<string or null>",
  "reason": "<one sentence>"
}`;
 
  console.log(`[Stage 3 – LLM Verify] 🤖 Verifying ${pages.length} page(s)...`);
 
  const response = await (openai as any).responses.create({
    model: OPENAI_MODEL,
    input: prompt,
  });
 
  const rawText: string = (response as any).output_text ?? "";
 
  let parsed: {
    bestPageIndex: number;
    isMatch: boolean;
    confidence: number;
    notes: string | null;
    reason: string;
  };
 
  try {
    const cleaned = rawText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    console.error("[Stage 3 – LLM Verify] ❌ Unparseable response:", rawText);
    return { url: null, isMatch: false, confidence: 0, notes: null, reason: "LLM returned unparseable response" };
  }
 
  console.log(
    `[Stage 3 – LLM Verify] ✅ isMatch=${parsed.isMatch} | confidence=${parsed.confidence} | "${parsed.reason}"`
  );
 
  const bestUrl =
    parsed.isMatch && parsed.bestPageIndex >= 0
      ? (pages[parsed.bestPageIndex]?.url ?? null)
      : null;
 
  return {
    url: bestUrl,
    isMatch: parsed.isMatch,
    confidence: parsed.confidence,
    notes: parsed.notes,
    reason: parsed.reason,
  };
}
 
// ─── Orchestrator ─────────────────────────────────────────────────────────────
 
const CONFIDENCE_THRESHOLD = 0.7;
 
/**
 * Main entry point — drop-in replacement for `discoverVendorProductUrlAndNotesAi`.
 */
export async function discoverVendorProductUrlAndNotes(
  params: VendorProductUrlNotesParams
): Promise<VendorProductUrlNotesResult> {
  const tag = "[Product URL Discovery]";
  console.log(
    `${tag} 🚀 "${params.itemDescription}" | vendor: ${params.vendorWebsite ?? params.vendorCompanyName ?? "unknown"}`
  );
 
  // Stage 1: Find candidate URLs
  let candidates: CandidateUrl[];
  let searchStage: "exa";
  try {
    ({ candidates, searchStage } = await findCandidateUrls(params));
  } catch (err) {
    console.error(`${tag} ❌ Search stage failed:`, err);
    return { success: false, notes: "Search stage failed", stage: "failed" };
  }
 
  if (candidates.length === 0) {
    console.warn(`${tag} ⚠️  No candidates found`);
    return { success: false, notes: "No candidate product pages found", stage: searchStage! };
  }
 
  // Stage 2: Scrape page content
  let pages: ScrapedPage[];
  try {
    pages = await scrapePages(candidates, 3);
  } catch (err) {
    console.error(`${tag} ❌ Scrape stage failed:`, err);
    return { success: false, notes: "Scrape stage failed", stage: "failed" };
  }
 
  if (pages.length === 0) {
    console.warn(`${tag} ⚠️  All candidate pages failed to scrape`);
    return {
      success: false,
      notes: "Could not retrieve content from any candidate page",
      stage: "firecrawl_scrape",
    };
  }
 
  // Stage 3: LLM verification
  let verification: VerificationResult;
  try {
    verification = await verifyWithLlm(params, pages);
  } catch (err) {
    console.error(`${tag} ❌ LLM verification failed:`, err);
    return { success: false, notes: "Verification stage failed", stage: "failed" };
  }
 
  if (!verification.isMatch || verification.confidence < CONFIDENCE_THRESHOLD) {
    console.warn(
      `${tag} ⚠️  No confident match. confidence=${verification.confidence} | ${verification.reason}`
    );
    return {
      success: false,
      productUrl: null,
      notes: `No confident match found. ${verification.reason}`,
      confidenceScore: verification.confidence,
      stage: "llm_verify",
    };
  }
 
  console.log(`${tag} ✅ ${verification.url} (confidence=${verification.confidence})`);
 
  return {
    success: true,
    productUrl: verification.url,
    notes: verification.notes,
    confidenceScore: verification.confidence,
    stage: "llm_verify",
  };
}