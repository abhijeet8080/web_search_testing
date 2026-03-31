import { exa } from "./exaClient.js";
import type { DeepObjectOutputSchema } from "exa-js";

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

const LOG_PREFIX = "[test_exa]";

function logStage(stage: string, message: string, details?: unknown): void {
  const line = `${LOG_PREFIX} [${stage}] ${message}`;
  if (details === undefined) {
    console.error(line);
    return;
  }
  console.error(`${line}\n${JSON.stringify(details, null, 2)}`);
}

const partNumber = process.env.PART_NUMBER ?? "TEKTON SHA04101 1/4 INCH DRIVE (F) X 3/8 INCH (M) ADAPTER";
const manufacturerName = process.env.MANUFACTURER_NAME ?? "TEKTON";
const productQuery = `${partNumber} ${manufacturerName}`.trim();

logStage("init", "Pipeline started", {
  partNumber,
  manufacturerName,
  productQuery,
});

const manufacturerSchema: DeepObjectOutputSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    website: { type: "string" },
    email: { type: "string" },
    phone: { type: "string" },
    HQ: { type: "string" },
  },
  required: ["name", "website", "email", "phone", "HQ"],
};

const distributorsSchema: DeepObjectOutputSchema = {
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
};

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

async function deepSearchObject(
  query: string,
  options: {
    category?: "company";
    includeDomains?: string[];
    systemPrompt?: string;
    outputSchema: DeepObjectOutputSchema;
  },
): Promise<Record<string, unknown>> {
  logStage("search", "Executing deep search request", {
    query,
    options: {
      category: options.category ?? "",
      includeDomains: options.includeDomains ?? [],
      systemPrompt: options.systemPrompt ?? "",
      outputSchema: options.outputSchema,
    },
  });

  const response = await exa.search(query, {
    type: "deep",
    category: options.category,
    includeDomains: options.includeDomains,
    systemPrompt: options.systemPrompt,
    outputSchema: options.outputSchema,
    numResults: 10,
    contents: { text: true },
  });
  const maybeOutput = (response as { output?: { content?: unknown } }).output?.content;
  const output = isRecord(maybeOutput) ? maybeOutput : {};
  logStage("search", "Deep search response received", {
    resultCount: Array.isArray((response as { results?: unknown[] }).results)
      ? (response as { results?: unknown[] }).results?.length ?? 0
      : 0,
    hasOutputContent: isRecord(maybeOutput),
    outputKeys: Object.keys(output),
  });
  return output;
}

async function enrichDistributor(distributor: Distributor): Promise<EnrichedDistributor> {
  logStage("enrich", "Starting distributor enrichment", {
    name: distributor.name,
    website: distributor.website,
  });
  const urls = contactUrlCandidates(distributor.website);
  if (urls.length === 0) {
    logStage("enrich", "Skipping enrichment: no valid URLs", {
      name: distributor.name,
    });
    return { ...distributor, address: "", enrichmentSources: [] };
  }

  let extractedEmail = distributor.email;
  let extractedPhone = distributor.phone;
  let extractedAddress = "";

  try {
    const contentResponse = await exa.getContents(urls, { text: { maxCharacters: 5000 } });
    const results = (contentResponse as { results?: Array<{ url?: string; text?: string }> })
      .results;
    const enrichmentSources: string[] = [];

    for (const item of results ?? []) {
      const text = asString(item.text);
      const sourceUrl = asString(item.url);
      if (sourceUrl) enrichmentSources.push(sourceUrl);
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
  } catch {
    logStage("enrich", "Distributor enrichment failed; returning base data", {
      name: distributor.name,
      urls,
    });
    return { ...distributor, address: "", enrichmentSources: [] };
  }
}

logStage("manufacturer", "Resolving manufacturer information");
const manufacturerRaw = await deepSearchObject(
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
logStage("manufacturer", "Manufacturer resolved", {
  manufacturer,
  manufacturerDomain,
});

logStage("manufacturer_site_distributors", "Searching manufacturer-site distributors");
const fromManufacturerSiteRaw = await deepSearchObject(
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
  `For part ${productQuery}, find authorized distributors worldwide.`,
  {
    category: "company",
    systemPrompt:
      "authorized only, email mandatory. Exclude gray market, marketplaces, and unverified resellers.",
    outputSchema: distributorsSchema,
  },
);

const fromManufacturerSite =
  (Array.isArray(fromManufacturerSiteRaw.distributors)
    ? fromManufacturerSiteRaw.distributors
    : []
  )
    .map(sanitizeDistributor)
    .filter((d): d is Distributor => d !== null);
logStage("manufacturer_site_distributors", "Parsed distributors", {
  count: fromManufacturerSite.length,
});

const fromOpenWeb = (Array.isArray(fromOpenWebRaw.distributors) ? fromOpenWebRaw.distributors : [])
  .map(sanitizeDistributor)
  .filter((d): d is Distributor => d !== null);
logStage("open_web_distributors", "Parsed distributors", {
  count: fromOpenWeb.length,
});

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

logStage("enrich", "Starting enrichment for merged distributors", {
  count: merged.length,
});
const enrichedMerged = await Promise.all(merged.map(enrichDistributor));
logStage("enrich", "Completed enrichment for merged distributors", {
  count: enrichedMerged.length,
});

const output: PipelineOutput = {
  input: {
    partNumber,
    manufacturerName,
  },
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

console.log(JSON.stringify(output, null, 2));

