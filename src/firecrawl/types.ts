// ─── Input ──────────────────────────────────────────────────────────────────

export interface ProcurementInput {
  partNumber: string;
  manufacturerName: string;
}

// ─── Layer 0 ─────────────────────────────────────────────────────────────────

export interface NormalizedInput {
  partNumber: string;
  manufacturerName: string;
  manufacturerDomain: string;
  queryVariants: string[];
}

// ─── Layer 1 + 2 ─────────────────────────────────────────────────────────────

export interface ScoredUrl {
  url: string;
  score: number;
  source: "search" | "manufacturer_known" | "manufacturer_map";
}

// ─── Layer 3 ─────────────────────────────────────────────────────────────────

export interface RawDistributor {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  website?: unknown;
  region?: unknown;
  country?: unknown;
  isAuthorized?: unknown;
  stockAvailable?: unknown;
}

// ─── Layer 6 → Output ────────────────────────────────────────────────────────

export interface Distributor {
  name: string;
  email: string;
  phone: string;
  website: string;
  region: string;
  isAuthorized: boolean;
  stockAvailable: boolean;
  authorizedConfidence: "high" | "medium" | "low";
  dataCompleteness: number;
  sourceLayer: string;
}

export interface ManufacturerInfo {
  name: string;
  website: string;
  email: string;
  phone: string;
}

// ─── Final output ─────────────────────────────────────────────────────────────

export interface ProcurementOutput {
  partNumber: string;
  manufacturer: ManufacturerInfo | null;
  distributors: Distributor[];
  metadata: {
    sourcesSearched: number;
    extractionTimeMs: number;
    layersUsed: string[];
    warnings: string[];
  };
}

// ─── Internal pipeline state passed between layers ────────────────────────────

export interface PipelineState {
  input: NormalizedInput;
  layer1Urls: ScoredUrl[];
  layer2Urls: ScoredUrl[];
  allUrls: ScoredUrl[];
  rawDistributors: RawDistributor[];
  sourcesSearched: number;
  layersUsed: string[];
  warnings: string[];
}

// ─── Distributor JSON schema (reused across layers) ───────────────────────────

export const DISTRIBUTOR_SCHEMA = {
  type: "object",
  properties: {
    distributors: {
      type: "array",
      description: "List of authorized distributors or resellers found on the page.",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Company name of the distributor or reseller.",
          },
          email: {
            type: ["string", "null"],
            description:
              "Contact email address. Check mailto: links and sales@ patterns. Return null if not found.",
          },
          phone: {
            type: ["string", "null"],
            description: "Phone number including country code. Return null if not found.",
          },
          website: {
            type: ["string", "null"],
            description: "Company website URL. Return null if not found.",
          },
          region: {
            type: ["string", "null"],
            description: "Countries or geographic regions served. Return null if not found.",
          },
          isAuthorized: {
            type: ["boolean", "null"],
            description:
              "Whether this is explicitly listed as an authorized/official distributor. Return null if unclear.",
          },
          stockAvailable: {
            type: ["boolean", "null"],
            description: "Whether the part appears to be in stock. Return null if unknown.",
          },
        },
        required: ["name"],
      },
    },
  },
  required: ["distributors"],
} as const;

export const EXTRACT_PROMPT =
  "Extract all authorized distributors or resellers mentioned on this page. " +
  "For each, find their email address (including mailto: links and patterns like sales@company.com), " +
  "phone number, website URL, and geographic regions they serve. " +
  "If an email is not in plain text, look for contact form references, mailto: href attributes, " +
  "or sales@/info@/contact@ patterns. Include stockAvailable if clearly stated.";
