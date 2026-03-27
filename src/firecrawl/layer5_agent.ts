/**
 * Layer 5 — Autonomous Agent Fallback
 * Only triggered when:
 *   - Fewer than MIN_DISTRIBUTORS_WITH_EMAIL distributors have emails after layers 3 & 4, OR
 *   - The caller explicitly requests agent mode
 *
 * The agent autonomously navigates the manufacturer's site, clicks distributor
 * locator flows, and handles JS-gated pages that static scraping cannot reach.
 * Most expensive call — always last resort.
 */

import { firecrawl } from "./firecrawlClient.js";
import type { Logger } from "./firecrawlClient.js";
import type { NormalizedInput, RawDistributor } from "./types.js";
import { DISTRIBUTOR_SCHEMA } from "./types.js";

export const MIN_DISTRIBUTORS_WITH_EMAIL = 3;

function buildAgentPrompt(input: NormalizedInput): string {
  const mfgUrl = input.manufacturerDomain
    ? `https://${input.manufacturerDomain}`
    : undefined;

  return [
    `Find all authorized distributors for ${input.manufacturerName} part number "${input.partNumber}".`,
    "For each distributor, extract:",
    "- Company name",
    "- Email address (search for mailto: links, sales@, info@, contact@ patterns)",
    "- Phone number",
    "- Website URL",
    "- Countries or geographic regions they serve",
    "- Whether they are listed as an authorized/official distributor",
    mfgUrl
      ? `Start from the manufacturer's website: ${mfgUrl} and look for 'distributors', 'where to buy', 'find a reseller', or 'authorized partners' sections.`
      : `Search for the manufacturer's official website for ${input.manufacturerName} and find their distributor locator.`,
    "Navigate through distributor locator pages, click region selectors if needed.",
    "Also check octopart.com and findchips.com for additional distributor listings.",
  ]
    .filter(Boolean)
    .join(" ");
}

interface AgentResponse {
  data?: {
    distributors?: unknown[];
  };
  status?: string;
  success?: boolean;
}

function parseAgentResult(result: unknown): RawDistributor[] {
  if (typeof result !== "object" || result === null) return [];

  const response = result as AgentResponse;
  const distributors =
    response.data?.distributors ??
    (Array.isArray((result as { distributors?: unknown[] }).distributors)
      ? (result as { distributors: unknown[] }).distributors
      : []);

  if (!Array.isArray(distributors)) return [];
  return distributors.filter((d): d is RawDistributor => typeof d === "object" && d !== null);
}

export async function runLayer5Agent(
  input: NormalizedInput,
  currentDistributorCount: number,
  log: Logger,
): Promise<{ distributors: RawDistributor[]; triggered: boolean }> {
  if (currentDistributorCount >= MIN_DISTRIBUTORS_WITH_EMAIL) {
    log("layer5", "Sufficient distributors found — agent not needed", {
      count: currentDistributorCount,
      threshold: MIN_DISTRIBUTORS_WITH_EMAIL,
    });
    return { distributors: [], triggered: false };
  }

  const prompt = buildAgentPrompt(input);
  const urls = input.manufacturerDomain ? [`https://${input.manufacturerDomain}`] : [];

  log("layer5", "Triggering autonomous agent", {
    reason: `Only ${currentDistributorCount} distributors with emails (threshold: ${MIN_DISTRIBUTORS_WITH_EMAIL})`,
    urls,
    promptPreview: prompt.slice(0, 120),
  });

  try {
    const agentFn = (
      firecrawl as unknown as {
        agent: (opts: {
          prompt: string;
          schema: typeof DISTRIBUTOR_SCHEMA;
          urls?: string[];
          model: string;
          maxCredits: number;
        }) => Promise<unknown>;
      }
    ).agent;

    if (typeof agentFn !== "function") {
      log("layer5", "firecrawl.agent() not available in this SDK version — skipping");
      return { distributors: [], triggered: false };
    }

    const result = await agentFn.call(firecrawl, {
      prompt,
      schema: DISTRIBUTOR_SCHEMA,
      urls: urls.length > 0 ? urls : undefined,
      model: "spark-1-mini",
      maxCredits: 500,
    });

    const distributors = parseAgentResult(result);
    log("layer5", "Agent complete", {
      rawCount: distributors.length,
      status: (result as AgentResponse).status,
    });
    return { distributors, triggered: true };
  } catch (err) {
    log("layer5", "Agent failed", { error: String(err) });
    return { distributors: [], triggered: false };
  }
}
