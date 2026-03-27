/**
 * Layer 4 — Deep Scrape for Missing Emails
 * For distributors that came out of Layer 3 without an email address,
 * this layer:
 *   1. Maps the distributor's domain to find their contact/about page URL
 *   2. Scrapes that contact page requesting both markdown and links formats
 *   3. Extracts email from markdown text AND from mailto: links
 *
 * Only runs for distributors where email is still null — keeps costs low.
 */

import { firecrawl } from "./firecrawlClient.js";
import { asString, getDomain } from "./firecrawlClient.js";
import type { Logger } from "./firecrawlClient.js";
import type { Distributor } from "./types.js";

const EMAIL_REGEX = /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi;
const PHONE_REGEX = /(?:\+?\d[\d().\-\s]{7,}\d)/g;

const CONTACT_PATH_HINTS = ["/contact", "/contact-us", "/about", "/about-us", "/sales"];
const MAX_DISTRIBUTORS_TO_ENRICH = 8;

function extractEmailFromText(text: string): string {
  const matches = text.match(EMAIL_REGEX);
  return matches?.[0]?.trim() ?? "";
}

function extractEmailFromLinks(links: unknown[]): string {
  for (const link of links) {
    const href = asString(link);
    if (href.startsWith("mailto:")) {
      const email = href.slice(7).split("?")[0];
      if (email && EMAIL_REGEX.test(email)) return email;
    }
  }
  return "";
}

function extractPhoneFromText(text: string): string {
  const matches = text.match(PHONE_REGEX);
  return matches?.[0]?.trim() ?? "";
}

async function findContactUrl(domain: string, log: Logger): Promise<string> {
  const base = `https://${domain}`;
  try {
    const mapResult = await firecrawl.map(base, {
      search: "contact OR about OR sales",
      limit: 20,
    });
    const links = (mapResult as { links?: Array<{ url?: unknown }> }).links ?? [];
    for (const link of links) {
      const url = asString(link.url as string);
      const lower = url.toLowerCase();
      if (CONTACT_PATH_HINTS.some((hint) => lower.includes(hint))) {
        return url;
      }
    }
    // Fall back to base URL
    return base;
  } catch {
    return base;
  }
}

async function enrichOneDistributor(
  distributor: Distributor,
  log: Logger,
): Promise<Distributor> {
  const domain = getDomain(distributor.website);
  if (!domain) {
    log("layer4", `No domain for ${distributor.name} — skipping`);
    return distributor;
  }

  log("layer4", `Enriching ${distributor.name}`, { domain });

  try {
    const contactUrl = await findContactUrl(domain, log);
    log("layer4", `Contact URL for ${distributor.name}`, { contactUrl });

    const scrapeResult = await (firecrawl as unknown as {
      scrape: (
        url: string,
        opts: { formats: string[]; onlyMainContent: boolean; timeout: number },
      ) => Promise<{
        markdown?: unknown;
        links?: unknown[];
        data?: { markdown?: unknown; links?: unknown[] };
      }>;
    }).scrape(contactUrl, {
      formats: ["markdown", "links"],
      onlyMainContent: true,
      timeout: 25000,
    });

    const markdown = asString(
      (scrapeResult as { markdown?: unknown }).markdown ??
        (scrapeResult as { data?: { markdown?: unknown } }).data?.markdown,
    );
    const links: unknown[] =
      (scrapeResult as { links?: unknown[] }).links ??
      (scrapeResult as { data?: { links?: unknown[] } }).data?.links ??
      [];

    const emailFromLinks = extractEmailFromLinks(links);
    const emailFromText = extractEmailFromText(markdown);
    const resolvedEmail = emailFromLinks || emailFromText;
    const resolvedPhone = distributor.phone || extractPhoneFromText(markdown);

    const updated: Distributor = {
      ...distributor,
      email: resolvedEmail || distributor.email,
      phone: resolvedPhone || distributor.phone,
    };

    log("layer4", `Enrichment result for ${distributor.name}`, {
      hadEmail: !!distributor.email,
      foundEmail: resolvedEmail,
      foundPhone: resolvedPhone,
    });

    return updated;
  } catch (err) {
    log("layer4", `Enrichment failed for ${distributor.name}`, { error: String(err) });
    return distributor;
  }
}

export async function runLayer4Scrape(
  distributors: Distributor[],
  log: Logger,
): Promise<Distributor[]> {
  const needsEnrichment = distributors.filter((d) => !d.email).slice(0, MAX_DISTRIBUTORS_TO_ENRICH);

  if (needsEnrichment.length === 0) {
    log("layer4", "All distributors have emails — skipping deep scrape");
    return distributors;
  }

  log("layer4", `Deep scraping for ${needsEnrichment.length} distributors missing emails`);

  const enriched = await Promise.all(needsEnrichment.map((d) => enrichOneDistributor(d, log)));

  // Merge enriched results back in
  const enrichedMap = new Map<string, Distributor>(enriched.map((d) => [d.name, d]));
  const result = distributors.map((d) => enrichedMap.get(d.name) ?? d);

  const resolved = result.filter((d) => d.email).length;
  log("layer4", "Deep scrape complete", {
    enriched: needsEnrichment.length,
    nowHaveEmail: resolved,
    total: result.length,
  });

  return result;
}
