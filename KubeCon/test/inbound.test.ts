import { describe, expect, it } from "vitest";
import { cloudflareAuthResults, handleInbound, isShareplayAddress, senderChecksPass } from "../src/inbound";
import type { Env } from "../src/types";

const ar = (s: string) => `mx.cloudflare.net; ${s}`;

describe("sender checks", () => {
  it("trusts only Cloudflare's Authentication-Results header", () => {
    expect(senderChecksPass(ar("dkim=pass header.d=example.com; dmarc=pass header.from=example.com; spf=pass smtp.mailfrom=example.com"))).toBe(true);
    expect(senderChecksPass(ar("dkim=none; dmarc=none; spf=pass smtp.mailfrom=example.com"))).toBe(true);
    expect(senderChecksPass(ar("dkim=pass header.d=example.com; dmarc=none; spf=softfail"))).toBe(true);
    expect(senderChecksPass(ar("dkim=pass header.d=other.com; dmarc=fail header.from=example.com; spf=pass"))).toBe(false);
    expect(senderChecksPass(ar("dkim=none; dmarc=none; spf=softfail"))).toBe(false);
    expect(senderChecksPass(null)).toBe(false);
    // A forged header from the sender comes after Cloudflare's and must not count.
    const forged = `${ar("dkim=fail; dmarc=fail; spf=fail")}, evil.example; dkim=pass; dmarc=pass; spf=pass`;
    expect(cloudflareAuthResults(forged)).toBe(ar("dkim=fail; dmarc=fail; spf=fail"));
    expect(senderChecksPass(forged)).toBe(false);
    expect(senderChecksPass("evil.example; dmarc=pass")).toBe(false);
  });

  it("accepts only addresses directly at shareplay.com", () => {
    expect(isShareplayAddress("anything@shareplay.com")).toBe(true);
    expect(isShareplayAddress("Planner@SharePlay.com")).toBe(true);
    expect(isShareplayAddress("sink@t.shareplay.com")).toBe(false);
    expect(isShareplayAddress("x@shareplay.com.evil.example")).toBe(false);
  });
});

describe("handleInbound", () => {
  const msg = (to: string, auth: string | null) => {
    const m = { to, from: "a@example.com", headers: new Headers(auth ? { "authentication-results": auth } : {}), forwarded: [] as string[], rejected: "" };
    return Object.assign(m, {
      forward: async (rcpt: string) => (m.forwarded.push(rcpt), { messageId: "f" }),
      setReject: (reason: string) => (m.rejected = reason),
    });
  };
  const env = { FORWARD_TO: "owner@example.org" } as Env;

  it("forwards mail that passes sender checks, unchanged, to the owner", async () => {
    const m = msg("hello@shareplay.com", ar("dkim=pass; dmarc=pass; spf=pass"));
    expect(await handleInbound(m as any, env)).toBe("forwarded");
    expect(m.forwarded).toEqual(["owner@example.org"]);
  });

  it("rejects mail that fails sender checks or is not for shareplay.com", async () => {
    const bad = msg("hello@shareplay.com", ar("dkim=fail; dmarc=fail; spf=fail"));
    expect(await handleInbound(bad as any, env)).toMatch(/^rejected/);
    expect(bad.forwarded).toEqual([]);
    expect(bad.rejected).toMatch(/sender authentication/);
    const sub = msg("sink@t.shareplay.com", ar("dmarc=pass"));
    expect(await handleInbound(sub as any, env)).toMatch(/^rejected/);
    const noDest = msg("hello@shareplay.com", ar("dmarc=pass"));
    expect(await handleInbound(noDest as any, {} as Env)).toMatch(/^rejected/);
  });
});
