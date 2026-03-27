/**
 * Layer 0 — Input Normalization
 * Pure TypeScript, zero API calls.
 * Normalizes manufacturer names, sanitizes part numbers,
 * resolves known domains, and generates query variants for search.
 */

import type { NormalizedInput, ProcurementInput } from "./types.js";

// ─── Manufacturer name normalization map ──────────────────────────────────────

const MANUFACTURER_NAMES: Record<string, string> = {
  SKF: "SKF",
  TI: "Texas Instruments",
  ST: "STMicroelectronics",
  STM: "STMicroelectronics",
  NXP: "NXP Semiconductors",
  ADI: "Analog Devices",
  ALTECH: "Altech Corporation",
  MURATA: "Murata Manufacturing",
  VISHAY: "Vishay Intertechnology",
  BOURNS: "Bourns Inc",
  YAGEO: "Yageo Corporation",
  PANASONIC: "Panasonic Corporation",
  SAMSUNG: "Samsung Electronics",
  INFINEON: "Infineon Technologies",
  MICROCHIP: "Microchip Technology",
  MAXIM: "Maxim Integrated",
  LINEAR: "Linear Technology",
  ON: "onsemi",
  ONSEMI: "onsemi",
  RENESAS: "Renesas Electronics",
  ROHM: "ROHM Semiconductor",
  ALPS: "Alps Alpine",
  TE: "TE Connectivity",
  MOLEX: "Molex",
  AMPHENOL: "Amphenol Corporation",
  JST: "JST Manufacturing",
  WEIDMULLER: "Weidmüller",
  PHOENIX: "Phoenix Contact",
  KEMET: "KEMET Corporation",
  TDK: "TDK Corporation",
  EPCOS: "EPCOS AG",
  WURTH: "Würth Elektronik",
  ABRACON: "Abracon LLC",
  LITTELFUSE: "Littelfuse Inc",
  BELDEN: "Belden Inc",
  WAGO: "WAGO Corporation",
  MOSFET: "International Rectifier",
  IR: "International Rectifier",
  ON_SEMI: "onsemi",
  CUI: "CUI Devices",
  COILCRAFT: "Coilcraft Inc",
  PULSE: "Pulse Electronics",
  FAIR_RITE: "Fair-Rite Products",
  LAIRD: "Laird Technologies",
  HIROSE: "Hirose Electric",
  SAMTEC: "Samtec Inc",
  HARTING: "HARTING Technology Group",
};

// ─── Known manufacturer domain map ───────────────────────────────────────────

const MANUFACTURER_DOMAINS: Record<string, string> = {
  SKF: "skf.com",
  "Texas Instruments": "ti.com",
  "STMicroelectronics": "st.com",
  "NXP Semiconductors": "nxp.com",
  "Analog Devices": "analog.com",
  "Altech Corporation": "altechcorp.com",
  "Murata Manufacturing": "murata.com",
  "Vishay Intertechnology": "vishay.com",
  "Microchip Technology": "microchip.com",
  "Infineon Technologies": "infineon.com",
  "onsemi": "onsemi.com",
  "Renesas Electronics": "renesas.com",
  "ROHM Semiconductor": "rohm.com",
  "TE Connectivity": "te.com",
  "Molex": "molex.com",
  "Amphenol Corporation": "amphenol.com",
  "Phoenix Contact": "phoenixcontact.com",
  "KEMET Corporation": "kemet.com",
  "TDK Corporation": "tdk.com",
  "Würth Elektronik": "we-online.com",
  "Littelfuse Inc": "littelfuse.com",
  "Belden Inc": "belden.com",
  "WAGO Corporation": "wago.com",
  "Coilcraft Inc": "coilcraft.com",
  "Hirose Electric": "hirose.com",
  "Samtec Inc": "samtec.com",
  "HARTING Technology Group": "harting.com",
  "Bourns Inc": "bourns.com",
  "Panasonic Corporation": "industry.panasonic.com",
  "Alps Alpine": "alpsalpine.com",
};

// ─── Public API ───────────────────────────────────────────────────────────────

export function normalizeManufacturerName(raw: string): string {
  const trimmed = raw.trim();
  const upper = trimmed.toUpperCase().replace(/[\s\-\.]+/g, "_");
  return MANUFACTURER_NAMES[upper] ?? MANUFACTURER_NAMES[trimmed.toUpperCase()] ?? trimmed;
}

export function getManufacturerDomain(normalizedName: string): string {
  return MANUFACTURER_DOMAINS[normalizedName] ?? "";
}

export function sanitizePartNumber(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9\-_.\/\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPrimaryPartToken(partNumber: string): string {
  const tokens = partNumber.split(" ").filter(Boolean);
  for (const token of tokens) {
    // Prefer tokens that include at least one digit and are not just unit strings.
    if (/\d/.test(token) && !/^(MM|CM|IN|OD|ID|WIDTH|DIA)$/i.test(token)) {
      return token;
    }
  }
  return partNumber;
}

export function buildQueryVariants(partNumber: string, manufacturer: string): string[] {
  const primaryPart = extractPrimaryPartToken(partNumber);
  return [
    `"${manufacturer}" "${primaryPart}" authorized distributor email contact`,
    `"${primaryPart}" ${manufacturer} buy reseller contact phone`,
    `site:octopart.com OR site:findchips.com "${primaryPart}" "${manufacturer}" distributor`,
    `${manufacturer} ${primaryPart} distributor network`,
  ];
}

export function normalize(input: ProcurementInput): NormalizedInput {
  const partNumber = sanitizePartNumber(input.partNumber);
  const manufacturerName = normalizeManufacturerName(input.manufacturerName);
  const manufacturerDomain = getManufacturerDomain(manufacturerName);
  const queryVariants = buildQueryVariants(partNumber, manufacturerName);

  return { partNumber, manufacturerName, manufacturerDomain, queryVariants };
}
