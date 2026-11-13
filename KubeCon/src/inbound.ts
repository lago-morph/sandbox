/**
 * Inbound mail for *@shareplay.com (Email Routing catch-all -> this Worker's email handler).
 * Mail that passes sender checks is forwarded unchanged to FORWARD_TO (a verified destination,
 * kept as a secret). Everything else is rejected.
 *
 * Sender checks use the Authentication-Results header that Cloudflare's MX prepends
 * (authserv-id mx.cloudflare.net). Only that first header is trusted; others may be forged.
 * Pass = DMARC pass, or (no DMARC failure and SPF or DKIM pass).
 */
import type { Env } from "./types";

/** The Authentication-Results header added by Cloudflare, or null if it is not first. */
export function cloudflareAuthResults(headerValue: string | null): string | null {
  if (!headerValue) return null;
  // Headers.get() joins repeated headers with ", "; a new header starts with "<authserv-id>;".
  const first = headerValue.split(/,\s*(?=[A-Za-z0-9.-]+\s*;)/)[0].trim();
  return /^mx\.cloudflare\.net\s*;/i.test(first) ? first : null;
}

export function senderChecksPass(headerValue: string | null): boolean {
  const ar = cloudflareAuthResults(headerValue);
  if (!ar) return false;
  const result = (method: string) => ar.match(new RegExp(`\\b${method}=([a-z]+)`, "i"))?.[1]?.toLowerCase() ?? "none";
  const dmarc = result("dmarc");
  if (dmarc === "pass") return true;
  if (dmarc === "fail") return false;
  return result("spf") === "pass" || result("dkim") === "pass";
}

/** Only addresses directly at the apex domain (not subdomains such as t.shareplay.com). */
export const isShareplayAddress = (to: string) => /^[^@\s]+@shareplay\.com$/i.test(to.trim());

export async function handleInbound(message: ForwardableEmailMessage, env: Env): Promise<string> {
  if (!isShareplayAddress(message.to)) {
    message.setReject("Unknown address");
    return "rejected: not a shareplay.com address";
  }
  if (!env.FORWARD_TO) {
    message.setReject("Temporarily unable to accept mail");
    return "rejected: FORWARD_TO not configured";
  }
  if (!senderChecksPass(message.headers.get("authentication-results"))) {
    message.setReject("Message failed sender authentication (SPF/DKIM/DMARC)");
    return "rejected: failed sender checks";
  }
  await message.forward(env.FORWARD_TO);
  return "forwarded";
}
