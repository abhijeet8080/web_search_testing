import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import OpenAI from "openai";
import { requiredEnv } from "./utils/env.js";

type ManufacturerInfo = {
  name: string;
  website: string;
  email: string;
  phone: string;
  HQ: string;
};

type Distributor = {
  name: string;
  email: string;
  website: string;
  phone: string;
  region: string;
  source?: string;
};

type EnrichedDistributor = Distributor & {
  address: string;
  enrichmentSources: string[];
};

type PipelineOutput = {
  input: {
    partNumber: string;
    manufacturerName: string;
  };
  manufacturer: ManufacturerInfo | null;
  manufacturerDomain: string;
  distributors: {
    fromManufacturerSite: Distributor[];
    fromOpenWeb: Distributor[];
    merged: EnrichedDistributor[];
  };
};

type ItemResult =
  | { success: true; output: PipelineOutput }
  | {
      success: false;
      input: { partNumber: string; manufacturerName: string };
      error: string;
    };

type ResultsFile = {
  generatedAt: string;
  updatedAt: string;
  itemsFile: string;
  resultsJsonPath: string;
  results: ItemResult[];
};

const LOG_PREFIX = "[test_openai_web_search]";

function logStage(stage: string, message: string, details?: unknown): void {
  const line = `${LOG_PREFIX} [${stage}] ${message}`;
  if (details === undefined) {
    console.error(line);
    return;
  }
  console.error(`${line}\n${JSON.stringify(details, null, 2)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeDistributor(value: unknown): Distributor | null {
  if (!isRecord(value)) return null;
  const name = asString(value.name);
  const email = asString(value.email);
  const website = asString(value.website);
  if (!name || !email || !website) return null;
  return {
    name,
    email,
    website,
    phone: asString(value.phone),
    region: asString(value.region),
    source: asString(value.source),
  };
}

function getDomain(input: string): string {
  const raw = asString(input);
  if (!raw) return "";
  try {
    const withProtocol = raw.startsWith("http") ? raw : `https://${raw}`;
    return new URL(withProtocol).hostname.replace(/^www\./, "");
  } catch {
    return raw.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  }
}

function extractJsonFromText(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return {};
  const candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return {};
  }
}

function extractEmail(text: string): string {
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  return match?.[0] ?? "";
}

function extractPhone(text: string): string {
  const match = text.match(/(?:\+?\d[\d().\-\s]{7,}\d)/g);
  return match?.[0]?.trim() ?? "";
}

function extractAddress(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const patterns = [
    /\b\d{1,6}\s+[A-Za-z0-9.\-'\s]{4,80}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Parkway|Pkwy)\b[^.]{0,120}/i,
    /\bP\.?\s?O\.?\s?Box\s+\d+\b[^.]{0,120}/i,
  ];
  for (const pattern of patterns) {
    const match = compact.match(pattern);
    if (match?.[0]) return match[0].trim();
  }
  return "";
}

function contactUrlCandidates(website: string): string[] {
  const candidates: string[] = [];
  try {
    const base = new URL(website.startsWith("http") ? website : `https://${website}`);
    candidates.push(base.toString());
    candidates.push(new URL("/contact", base).toString());
    candidates.push(new URL("/contact-us", base).toString());
  } catch {
    // If website cannot be parsed, skip /contents enrichment for this distributor.
  }
  return Array.from(new Set(candidates));
}

function htmlToText(html: string): string {
  // Lightweight HTML -> text conversion; good enough for email/phone extraction.
  const withoutScripts = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ");
  const withoutStyles = withoutScripts.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ");
  const withNewlines = withoutStyles.replace(/<\/(p|div|br|li|tr|h1|h2|h3|table)>/gi, "\n");
  const stripped = withNewlines.replace(/<[^>]+>/g, " ");
  return stripped.replace(/\s+/g, " ").trim();
}

async function fetchText(url: string, maxChars: number): Promise<string> {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "user-agent": "Mozilla/5.0 (compatible; exa-search-test)" },
    });
    if (!res.ok) return "";
    const html = await res.text();
    const text = htmlToText(html);
    return text.slice(0, maxChars);
  } catch {
    return "";
  }
}

async function deepSearchObject(
  openai: OpenAI,
  query: string,
  options: {
    category?: "company";
    includeDomains?: string[];
    systemPrompt?: string;
    outputSchema: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  logStage("search", "Executing web_search deep extraction request", {
    query,
    options: {
      category: options.category ?? "",
      includeDomains: options.includeDomains ?? [],
      systemPrompt: options.systemPrompt ?? "",
      outputSchema: options.outputSchema,
    },
  });

  const includeDomains = options.includeDomains?.filter(Boolean) ?? [];
  const tool: Record<string, unknown> = { type: "web_search" };

  // Domain hint in the prompt — OpenAI's web_search tool does not support domain filters.
  const domainHint =
    includeDomains.length > 0
      ? `Search ONLY on these domains: ${includeDomains.join(", ")}.`
      : "";

  const input = [
    "You have access to the `web_search` tool.",
    "Use it to search the web for the answer.",
    domainHint,
    options.systemPrompt ? `SYSTEM INSTRUCTIONS:\n${options.systemPrompt}` : "",
    `SEARCH QUERY:\n${query}`,
    "Return ONLY valid JSON that matches this schema (no markdown, no backticks, no extra keys):",
    JSON.stringify(options.outputSchema),
  ]
    .filter(Boolean)
    .join("\n\n");

  const response = await (openai as any).responses.create({
    model: process.env.OPENAI_MODEL ?? "gpt-4o",
    input,
    tools: [tool],
  });

  const text: string = (response as any).output_text ?? "";
  const output = isRecord(extractJsonFromText(text)) ? (extractJsonFromText(text) as Record<string, unknown>) : {};

  logStage("search", "Web search deep extraction response received", {
    hasOutput: isRecord(output),
    outputKeys: isRecord(output) ? Object.keys(output) : [],
  });

  return output;
}

async function enrichDistributor(
  openai: OpenAI,
  distributor: Distributor,
): Promise<EnrichedDistributor> {
  // `openai` is currently unused here, but we keep the signature so the file mirrors the Exa version.
  // Enrichment is done by fetching contact-ish pages and extracting email/phone/address via regex.
  logStage("enrich", "Starting distributor enrichment", {
    name: distributor.name,
    website: distributor.website,
  });

  const urls = contactUrlCandidates(distributor.website);
  if (urls.length === 0) {
    logStage("enrich", "Skipping enrichment: no valid URLs", { name: distributor.name });
    return { ...distributor, address: "", enrichmentSources: [] };
  }

  let extractedEmail = distributor.email;
  let extractedPhone = distributor.phone;
  let extractedAddress = "";
  const enrichmentSources: string[] = [];

  for (const url of urls) {
    enrichmentSources.push(url);
    const text = await fetchText(url, 5000);
    if (!text) continue;

    if (!extractedEmail) extractedEmail = extractEmail(text);
    if (!extractedPhone) extractedPhone = extractPhone(text);
    if (!extractedAddress) extractedAddress = extractAddress(text);
  }

  logStage("enrich", "Distributor enrichment complete", {
    name: distributor.name,
    resolvedEmail: extractedEmail,
    resolvedPhone: extractedPhone,
    resolvedAddress: extractedAddress,
    sourceCount: enrichmentSources.length,
  });

  return {
    ...distributor,
    email: extractedEmail,
    phone: extractedPhone,
    address: extractedAddress,
    enrichmentSources: Array.from(new Set(enrichmentSources)),
  };
}

const manufacturerSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    website: { type: "string" },
    email: { type: "string" },
    phone: { type: "string" },
    HQ: { type: "string" },
  },
  required: ["name", "website", "email", "phone", "HQ"],
} satisfies Record<string, unknown>;

const distributorsSchema = {
  type: "object",
  properties: {
    distributors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string" },
          website: { type: "string" },
          phone: { type: "string" },
          region: { type: "string" },
        },
        required: ["name", "email", "website", "phone", "region"],
      },
    },
  },
  required: ["distributors"],
} satisfies Record<string, unknown>;

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
      logStage("parse", "Odd number of non-empty lines; last part has no manufacturer row", {
        partNumber,
      });
      break;
    }
    pairs.push({ partNumber, manufacturerName });
  }
  return pairs;
}

const openai = new OpenAI({ apiKey: requiredEnv("OPENAI_API_KEY") });

async function runPipeline(
  partNumber: string,
  manufacturerName: string,
): Promise<PipelineOutput> {
  const productQuery = `${partNumber} ${manufacturerName}`.trim();

  logStage("init", "Pipeline started", {
    partNumber,
    manufacturerName,
    productQuery,
  });

  logStage("manufacturer", "Resolving manufacturer information");
  const manufacturerRaw = await deepSearchObject(
    openai,
    `Find official manufacturer company details for part ${partNumber} from ${manufacturerName}. Return only the actual manufacturer company.`,
    {
      category: "company",
      outputSchema: manufacturerSchema,
    },
  );

  const manufacturer: ManufacturerInfo | null =
    asString(manufacturerRaw.name) || asString(manufacturerRaw.website)
      ? {
          name: asString(manufacturerRaw.name),
          website: asString(manufacturerRaw.website),
          email: asString(manufacturerRaw.email),
          phone: asString(manufacturerRaw.phone),
          HQ: asString(manufacturerRaw.HQ),
        }
      : null;

  const manufacturerDomain = getDomain(manufacturer?.website ?? manufacturerName);
  logStage("manufacturer", "Manufacturer resolved", { manufacturer, manufacturerDomain });

  logStage("manufacturer_site_distributors", "Searching manufacturer-site distributors");
  const fromManufacturerSiteRaw = await deepSearchObject(
    openai,
    `For part ${productQuery}, find authorized distributors listed by the manufacturer. Only include authorized distributors with email.`,
    {
      includeDomains: manufacturerDomain ? [manufacturerDomain] : undefined,
      systemPrompt:
        "Use only manufacturer-owned pages. Include authorized distributors only. Email is mandatory.",
      outputSchema: distributorsSchema,
    },
  );

  logStage("open_web_distributors", "Searching open-web distributors");
  const fromOpenWebRaw = await deepSearchObject(
    openai,
    `For part ${productQuery}, find authorized distributors worldwide.`,
    {
      category: "company",
      systemPrompt:
        "authorized only, email mandatory. Exclude gray market, marketplaces, and unverified resellers.",
      outputSchema: distributorsSchema,
    },
  );

  const fromManufacturerSite = (
    Array.isArray((fromManufacturerSiteRaw as { distributors?: unknown }).distributors)
      ? (fromManufacturerSiteRaw as { distributors: unknown[] }).distributors
      : []
  )
    .map(sanitizeDistributor)
    .filter((d): d is Distributor => d !== null);
  logStage("manufacturer_site_distributors", "Parsed distributors", {
    count: fromManufacturerSite.length,
  });

  const fromOpenWeb = (
    Array.isArray((fromOpenWebRaw as { distributors?: unknown }).distributors)
      ? (fromOpenWebRaw as { distributors: unknown[] }).distributors
      : []
  )
    .map(sanitizeDistributor)
    .filter((d): d is Distributor => d !== null);
  logStage("open_web_distributors", "Parsed distributors", { count: fromOpenWeb.length });

  const mergedMap = new Map<string, Distributor>();
  for (const distributor of [...fromManufacturerSite, ...fromOpenWeb]) {
    const key = `${distributor.name.toLowerCase()}|${getDomain(distributor.website)}`;
    if (!mergedMap.has(key)) mergedMap.set(key, distributor);
  }

  const merged = Array.from(mergedMap.values());
  logStage("merge", "Merged distributor set", {
    mergedCount: merged.length,
    manufacturerSiteCount: fromManufacturerSite.length,
    openWebCount: fromOpenWeb.length,
  });

  logStage("enrich", "Starting enrichment for merged distributors", { count: merged.length });
  const enrichedMerged = await Promise.all(merged.map((d) => enrichDistributor(openai, d)));
  logStage("enrich", "Completed enrichment for merged distributors", { count: enrichedMerged.length });

  const output: PipelineOutput = {
    input: { partNumber, manufacturerName },
    manufacturer,
    manufacturerDomain,
    distributors: {
      fromManufacturerSite,
      fromOpenWeb,
      merged: enrichedMerged,
    },
  };

  logStage("done", "Pipeline complete", {
    manufacturerFound: output.manufacturer !== null,
    manufacturerDomain: output.manufacturerDomain,
    fromManufacturerSite: output.distributors.fromManufacturerSite.length,
    fromOpenWeb: output.distributors.fromOpenWeb.length,
    merged: output.distributors.merged.length,
  });

  return output;
}

const itemsPath = process.env.ITEMS_FILE ?? join(process.cwd(), "items.txt");
const resultsPath = process.env.RESULTS_JSON ?? join(process.cwd(), "openai-web-search-results.json");

let items: Array<{ partNumber: string; manufacturerName: string }>;
try {
  const raw = await readFile(itemsPath, "utf8");
  items = parseItemsTxt(raw);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  logStage("init", `Could not read ${itemsPath}: ${message}. Falling back to env defaults.`);
  items = [
    {
      partNumber: process.env.PART_NUMBER ?? "ALTECH CBF12-S88S0-05BPUR CABLE",
      manufacturerName: process.env.MANUFACTURER_NAME ?? "ALTECH",
    },
  ];
}

if (items.length === 0) {
  logStage("init", "No items parsed from file; using env defaults.");
  items = [
    {
      partNumber: process.env.PART_NUMBER ?? "ALTECH CBF12-S88S0-05BPUR CABLE",
      manufacturerName: process.env.MANUFACTURER_NAME ?? "ALTECH",
    },
  ];
}

const generatedAt = new Date().toISOString();
const results: ItemResult[] = [];

async function persistResultsToJson(): Promise<void> {
  const payload: ResultsFile = {
    generatedAt,
    updatedAt: new Date().toISOString(),
    itemsFile: itemsPath,
    resultsJsonPath: resultsPath,
    results,
  };
  await writeFile(resultsPath, JSON.stringify(payload, null, 2), "utf8");
}

logStage("init", "Pipeline batch started", {
  itemCount: items.length,
  itemsFile: itemsPath,
  resultsJsonPath: resultsPath,
});

for (let i = 0; i < items.length; i++) {
  const { partNumber, manufacturerName } = items[i]!;
  const label = `${i + 1}/${items.length}`;
  logStage("item", `[${label}] Starting`, { partNumber, manufacturerName });
  try {
    const output = await runPipeline(partNumber, manufacturerName);
    results.push({ success: true, output });
    logStage("item", `[${label}] Complete`, {
      manufacturerFound: output.manufacturer !== null,
      merged: output.distributors.merged.length,
    });
    console.log(JSON.stringify(output, null, 2));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logStage("item", `[${label}] Failed`, { partNumber, manufacturerName, error });
    results.push({
      success: false,
      input: { partNumber, manufacturerName },
      error,
    });
  }
  await persistResultsToJson();
  logStage("persist", `Wrote ${results.length} result(s) to ${resultsPath}`);
}

logStage("done", "Batch complete", {
  successes: results.filter((r) => r.success).length,
  failures: results.filter((r) => !r.success).length,
});

