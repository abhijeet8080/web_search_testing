import FirecrawlApp from "@mendable/firecrawl-js";
import { requiredEnv } from "../utils/env.js";

export const firecrawl = new FirecrawlApp({
  apiKey: requiredEnv("FIRECRAWL_API_KEY"),
});

export type Logger = (stage: string, message: string, data?: unknown) => void;

export function makeLogger(prefix: string): Logger {
  return (stage: string, message: string, data?: unknown) => {
    const line = `[${prefix}] [${stage}] ${message}`;
    if (data === undefined) {
      console.error(line);
    } else {
      console.error(`${line}\n${JSON.stringify(data, null, 2)}`);
    }
  };
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function asBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return false;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getDomain(input: string): string {
  const raw = asString(input);
  if (!raw) return "";
  try {
    const withProtocol = raw.startsWith("http") ? raw : `https://${raw}`;
    return new URL(withProtocol).hostname.replace(/^www\./, "");
  } catch {
    return raw.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] ?? "";
  }
}
