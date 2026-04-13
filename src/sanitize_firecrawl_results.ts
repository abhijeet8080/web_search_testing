/**
 * Reads firecrawl-results.json and writes a slim JSON with item + manufacturer +
 * distributor contact details (no layerDetails, no per-layer telemetry).
 *
 * Usage: npx tsx src/sanitize_firecrawl_results.ts [input.json] [output.json]
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";

type DistributorOut = {
  name: string;
  email: string;
  phone: string;
  website: string;
  region: string;
  isAuthorized: boolean;
  stockAvailable: boolean;
  authorizedConfidence: string;
  dataCompleteness: number;
  sourceLayer: string;
};

type ItemOk = {
  item: string;
  manufacturer: string;
  manufacturerResolved: {
    name: string;
    website: string;
    email: string;
    phone: string;
  } | null;
  distributorCount: number;
  distributors: DistributorOut[];
  metadata: {
    sourcesSearched: number;
    extractionTimeMs: number;
    layersUsed: string[];
    warnings: string[];
  };
};

type ItemErr = {
  item: string;
  manufacturer: string;
  success: false;
  error: string;
};

type SanitizedFile = {
  source: string;
  sourceGeneratedAt?: string;
  sourceUpdatedAt?: string;
  sanitizedAt: string;
  items: Array<ItemOk | ItemErr>;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function mapDistributor(raw: unknown): DistributorOut | null {
  if (!isRecord(raw)) return null;
  return {
    name: asString(raw.name),
    email: asString(raw.email),
    phone: asString(raw.phone),
    website: asString(raw.website),
    region: asString(raw.region),
    isAuthorized: raw.isAuthorized === true,
    stockAvailable: raw.stockAvailable === true,
    authorizedConfidence: asString(raw.authorizedConfidence) || "unknown",
    dataCompleteness: typeof raw.dataCompleteness === "number" ? raw.dataCompleteness : 0,
    sourceLayer: asString(raw.sourceLayer) || "unknown",
  };
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const inputPath = process.argv[2] ?? join(cwd, "firecrawl-results.json");
  const outputPath = process.argv[3] ?? join(cwd, "firecrawl-results-sanitized.json");

  const rawText = await readFile(inputPath, "utf8");
  const raw = JSON.parse(rawText) as unknown;
  if (!isRecord(raw) || !Array.isArray(raw.results)) {
    throw new Error(`Expected { results: [] } in ${inputPath}`);
  }

  const items: Array<ItemOk | ItemErr> = [];

  for (const entry of raw.results) {
    if (!isRecord(entry)) continue;
    const input = entry.input;
    const inp = isRecord(input) ? input : {};
    const partNumber = asString(inp.partNumber);
    const manufacturerName = asString(inp.manufacturerName);

    if (entry.success === false) {
      items.push({
        item: partNumber,
        manufacturer: manufacturerName,
        success: false,
        error: asString(entry.error) || "Unknown error",
      });
      continue;
    }

    const output = entry.output;
    if (!isRecord(output)) {
      items.push({
        item: partNumber,
        manufacturer: manufacturerName,
        success: false,
        error: "Missing output",
      });
      continue;
    }

    const distributorsRaw = output.distributors;
    const list = Array.isArray(distributorsRaw) ? distributorsRaw : [];
    const distributors = list.map(mapDistributor).filter((d): d is DistributorOut => d !== null);

    const mfg = output.manufacturer;
    let manufacturerResolved: ItemOk["manufacturerResolved"] = null;
    if (isRecord(mfg)) {
      manufacturerResolved = {
        name: asString(mfg.name),
        website: asString(mfg.website),
        email: asString(mfg.email),
        phone: asString(mfg.phone),
      };
    }

    const meta = output.metadata;
    let metadata: ItemOk["metadata"] = {
      sourcesSearched: 0,
      extractionTimeMs: 0,
      layersUsed: [],
      warnings: [],
    };
    if (isRecord(meta)) {
      metadata = {
        sourcesSearched: typeof meta.sourcesSearched === "number" ? meta.sourcesSearched : 0,
        extractionTimeMs: typeof meta.extractionTimeMs === "number" ? meta.extractionTimeMs : 0,
        layersUsed: Array.isArray(meta.layersUsed)
          ? meta.layersUsed.filter((x): x is string => typeof x === "string")
          : [],
        warnings: Array.isArray(meta.warnings)
          ? meta.warnings.filter((x): x is string => typeof x === "string")
          : [],
      };
    }

    items.push({
      item: asString(output.partNumber) || partNumber,
      manufacturer: manufacturerName,
      manufacturerResolved,
      distributorCount: distributors.length,
      distributors,
      metadata,
    });
  }

  const out: SanitizedFile = {
    source: inputPath,
    sourceGeneratedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : undefined,
    sourceUpdatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    sanitizedAt: new Date().toISOString(),
    items,
  };

  await writeFile(outputPath, JSON.stringify(out, null, 2), "utf8");
  console.error(`Wrote ${items.length} item(s) to ${outputPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
