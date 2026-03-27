/**
 * Layer 6 — Validation & Deduplication
 * Pure TypeScript, zero API calls.
 *
 * Steps:
 *   1. Parse raw distributor objects into typed Distributors
 *   2. Validate emails (regex)
 *   3. Deduplicate: first by email (primary key), then by normalized name
 *   4. Score each distributor by data completeness
 *   5. Assign authorizedConfidence based on source layer
 *   6. Sort by score descending
 */

import { asString, asBool } from "./firecrawlClient.js";
import type { Distributor, RawDistributor } from "./types.js";

// ─── Email validation ─────────────────────────────────────────────────────────

const EMAIL_REGEX = /^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$/i;

function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email.trim());
}

// Generic/placeholder emails that are too broad to be useful
const EXCLUDED_EMAIL_PATTERNS = [
  "noreply",
  "no-reply",
  "donotreply",
  "unsubscribe",
  "webmaster",
  "postmaster",
];

function isUsableEmail(email: string): boolean {
  if (!isValidEmail(email)) return false;
  const lower = email.toLowerCase();
  return !EXCLUDED_EMAIL_PATTERNS.some((p) => lower.includes(p));
}

// ─── Phone normalization ──────────────────────────────────────────────────────

function normalizePhone(raw: string): string {
  const cleaned = raw.replace(/[^\d+\-\s().]/g, "").trim();
  return cleaned.length >= 7 ? cleaned : "";
}

// ─── Name normalization for dedup ─────────────────────────────────────────────

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

// ─── Confidence from source ───────────────────────────────────────────────────

function confidenceFromSource(source: string): "high" | "medium" | "low" {
  if (source === "manufacturer_map" || source === "manufacturer_known") return "high";
  if (
    source === "search" &&
    ["octopart", "findchips", "digikey", "mouser", "arrow", "avnet"].some((d) =>
      source.includes(d),
    )
  )
    return "medium";
  if (source === "agent") return "medium";
  return "low";
}

function confidenceFromUrl(sourceUrl: string): "high" | "medium" | "low" {
  const lower = sourceUrl.toLowerCase();
  if (lower.includes("manufacturer_map") || lower.includes("manufacturer_known")) return "high";
  const mediumDomains = ["octopart", "findchips", "digikey", "mouser", "arrow", "avnet"];
  if (mediumDomains.some((d) => lower.includes(d))) return "medium";
  return "low";
}

// ─── Data completeness score ──────────────────────────────────────────────────

function computeScore(d: Distributor): number {
  let score = 0;
  if (d.email) score += 3;
  if (d.phone) score += 1;
  if (d.website) score += 1;
  if (d.region) score += 1;
  return score;
}

// ─── Raw → Distributor ────────────────────────────────────────────────────────

export function parseDistributor(
  raw: RawDistributor & { _sourceUrl?: string; _sourceLayer?: string },
): Distributor | null {
  const name = asString(raw.name as string);
  if (!name) return null;

  const rawEmail = asString(raw.email as string);
  const email = isUsableEmail(rawEmail) ? rawEmail : "";
  const phone = normalizePhone(asString(raw.phone as string));
  const website = asString(raw.website as string);
  const region = asString((raw.region ?? raw.country) as string);
  const isAuthorized = asBool(raw.isAuthorized);
  const stockAvailable = asBool(raw.stockAvailable);

  const sourceLayer = asString(raw._sourceLayer as string) || "unknown";
  const sourceUrl = asString(raw._sourceUrl as string);
  const authorizedConfidence =
    confidenceFromSource(sourceLayer) === "high" || sourceUrl.includes("manufacturer")
      ? "high"
      : confidenceFromUrl(sourceUrl);

  const d: Distributor = {
    name,
    email,
    phone,
    website,
    region,
    isAuthorized,
    stockAvailable,
    authorizedConfidence,
    dataCompleteness: 0,
    sourceLayer: sourceLayer || sourceUrl,
  };

  d.dataCompleteness = computeScore(d);
  return d;
}

// ─── Deduplication ────────────────────────────────────────────────────────────

function mergeDistributors(existing: Distributor, incoming: Distributor): Distributor {
  // Merge: prefer the one with more data
  return {
    ...existing,
    email: existing.email || incoming.email,
    phone: existing.phone || incoming.phone,
    website: existing.website || incoming.website,
    region: existing.region || incoming.region,
    // Prefer higher confidence
    authorizedConfidence:
      existing.authorizedConfidence === "high"
        ? "high"
        : incoming.authorizedConfidence === "high"
          ? "high"
          : existing.authorizedConfidence === "medium"
            ? "medium"
            : "low",
    isAuthorized: existing.isAuthorized || incoming.isAuthorized,
    stockAvailable: existing.stockAvailable || incoming.stockAvailable,
    dataCompleteness: 0, // recalculated below
    sourceLayer: existing.sourceLayer,
  };
}

// ─── Main validation function ─────────────────────────────────────────────────

export function runLayer6Validate(
  rawDistributors: Array<RawDistributor & { _sourceUrl?: string; _sourceLayer?: string }>,
  log: (stage: string, msg: string, data?: unknown) => void,
): Distributor[] {
  log("layer6", `Validating ${rawDistributors.length} raw distributor records`);

  // Step 1: parse to typed objects
  const parsed = rawDistributors
    .map(parseDistributor)
    .filter((d): d is Distributor => d !== null);

  log("layer6", `Parsed: ${parsed.length} valid records`);

  // Step 2: Deduplicate by email (primary), then by normalized name
  const byEmail = new Map<string, Distributor>();
  const byName = new Map<string, Distributor>();

  for (const d of parsed) {
    if (d.email) {
      const key = d.email.toLowerCase();
      if (byEmail.has(key)) {
        byEmail.set(key, mergeDistributors(byEmail.get(key)!, d));
      } else {
        byEmail.set(key, d);
      }
    } else {
      const nameKey = normalizeName(d.name);
      if (byName.has(nameKey)) {
        byName.set(nameKey, mergeDistributors(byName.get(nameKey)!, d));
      } else {
        byName.set(nameKey, d);
      }
    }
  }

  // Merge name-keyed entries with email-keyed entries (email wins)
  const emailNames = new Set(
    Array.from(byEmail.values()).map((d) => normalizeName(d.name)),
  );
  for (const [nameKey, d] of byName) {
    if (!emailNames.has(nameKey)) {
      byEmail.set(`__name__${nameKey}`, d);
    }
  }

  // Step 3: Recompute scores
  const deduped = Array.from(byEmail.values()).map((d) => ({
    ...d,
    dataCompleteness: computeScore(d),
  }));

  // Step 4: Sort by score desc, then by confidence
  const CONF_ORDER: Record<string, number> = { high: 2, medium: 1, low: 0 };
  const sorted = deduped.sort((a, b) => {
    if (b.dataCompleteness !== a.dataCompleteness) return b.dataCompleteness - a.dataCompleteness;
    return (CONF_ORDER[b.authorizedConfidence] ?? 0) - (CONF_ORDER[a.authorizedConfidence] ?? 0);
  });

  const withEmail = sorted.filter((d) => d.email).length;
  log("layer6", "Validation complete", {
    total: sorted.length,
    withEmail,
    withoutEmail: sorted.length - withEmail,
    topScores: sorted.slice(0, 5).map((d) => `${d.name} [${d.dataCompleteness}] ${d.email}`),
  });

  return sorted;
}
