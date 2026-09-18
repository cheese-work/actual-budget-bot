import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

/**
 * Single shared Anthropic client factory so the text fallback (llmFallback.ts)
 * and the vision extraction (visionExtract.ts) lanes stay on ONE configured
 * route rather than each constructing their own client. When anthropicBaseUrl
 * is set, requests go through OmniRoute (an Anthropic-API-compatible proxy)
 * instead of the vendor API directly — auth token preferred over a direct
 * vendor key because that's what the proxy expects in the x-api-key header.
 */
export function isLlmConfigured(): boolean {
  return Boolean(config.anthropicAuthToken || config.anthropicApiKey);
}

/** Returns null when neither an auth token nor an api key is configured. Callers log the warning — this stays silent so it's reusable from any call site. */
export function createLlmClient(): Anthropic | null {
  const apiKey = config.anthropicAuthToken || config.anthropicApiKey;
  if (!apiKey) return null;

  return new Anthropic({
    apiKey,
    ...(config.anthropicBaseUrl ? { baseURL: config.anthropicBaseUrl } : {}),
  });
}
