import { describe, it, expect } from "vitest";
import { verifyInteracSender, parseAuthResults } from "../src/emailVerifier";

const ALLOWLIST = ["payments.interac.ca", "interac.ca", "notifications.interac.ca"];

function makeMessage(opts: {
  envelopeFrom: string;
  headerFrom?: string;
  authResults?: string;
}): ForwardableEmailMessage {
  const headers = new Headers();
  if (opts.headerFrom !== undefined) headers.set("from", opts.headerFrom);
  if (opts.authResults !== undefined) {
    headers.set("authentication-results", opts.authResults);
  }
  return { from: opts.envelopeFrom, headers } as unknown as ForwardableEmailMessage;
}

const CF_PASS =
  "mx.cloudflare.net; spf=pass; dkim=pass header.d=payments.interac.ca header.s=sel1; dmarc=pass header.from=payments.interac.ca";

describe("parseAuthResults", () => {
  it("parses Cloudflare's header", () => {
    expect(parseAuthResults(CF_PASS)).toEqual({
      spfPass: true,
      dkimPass: true,
      dkimDomains: ["payments.interac.ca"],
      dmarcPass: true,
    });
  });

  it("returns all-false for a missing header", () => {
    expect(parseAuthResults(null)).toEqual({
      spfPass: false,
      dkimPass: false,
      dkimDomains: [],
      dmarcPass: false,
    });
  });

  it("only trusts the mx.cloudflare.net segment when headers are concatenated", () => {
    // Upstream relay claims everything passed; Cloudflare says it failed.
    const combined =
      "mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail header.from=evil.example, " +
      "relay.evil.example; spf=pass; dkim=pass header.d=payments.interac.ca; dmarc=pass";
    const r = parseAuthResults(combined);
    expect(r.spfPass).toBe(false);
    expect(r.dkimPass).toBe(false);
    expect(r.dmarcPass).toBe(false);
  });

  it("handles multiple dkim results", () => {
    const r = parseAuthResults(
      "mx.cloudflare.net; dkim=pass header.d=mailer.example; dkim=pass header.d=interac.ca; spf=pass",
    );
    expect(r.dkimDomains).toEqual(["mailer.example", "interac.ca"]);
  });
});

describe("verifyInteracSender", () => {
  it("passes for allowlisted From header with dmarc=pass", () => {
    const msg = makeMessage({
      envelopeFrom: "bounce-123@bounce.interac-mailer.example",
      headerFrom: "Interac <notify@payments.interac.ca>",
      authResults: CF_PASS,
    });
    expect(verifyInteracSender(msg, ALLOWLIST)).toBe(true);
  });

  it("passes with spf+dkim(aligned) when dmarc is absent", () => {
    const msg = makeMessage({
      envelopeFrom: "notify@payments.interac.ca",
      headerFrom: "notify@payments.interac.ca",
      authResults:
        "mx.cloudflare.net; spf=pass; dkim=pass header.d=payments.interac.ca",
    });
    expect(verifyInteracSender(msg, ALLOWLIST)).toBe(true);
  });

  it("accepts bare dkim=pass without header.d (legacy header shape)", () => {
    const msg = makeMessage({
      envelopeFrom: "donotreply@payments.interac.ca",
      authResults: "dkim=pass; spf=pass",
    });
    expect(verifyInteracSender(msg, ALLOWLIST)).toBe(true);
  });

  it("is case-insensitive on domains", () => {
    const msg = makeMessage({
      envelopeFrom: "donotreply@Payments.Interac.CA",
      authResults: "dkim=pass; spf=pass",
    });
    expect(verifyInteracSender(msg, ALLOWLIST)).toBe(true);
  });

  it("matches subdomains of allowlisted domains", () => {
    const msg = makeMessage({
      envelopeFrom: "x@mail.payments.interac.ca",
      authResults: "mx.cloudflare.net; spf=pass; dkim=pass header.d=mail.payments.interac.ca",
    });
    expect(verifyInteracSender(msg, ALLOWLIST)).toBe(true);
  });

  it("fails for non-allowlisted From and envelope even with full auth pass", () => {
    const msg = makeMessage({
      envelopeFrom: "someone@gmail.com",
      headerFrom: "Someone <someone@gmail.com>",
      authResults:
        "mx.cloudflare.net; spf=pass; dkim=pass header.d=gmail.com; dmarc=pass header.from=gmail.com",
    });
    expect(verifyInteracSender(msg, ALLOWLIST)).toBe(false);
  });

  it("fails when dkim passes for an unrelated domain and dmarc is absent", () => {
    // Spoofed From header, signed by attacker's own domain.
    const msg = makeMessage({
      envelopeFrom: "attacker@evil.example",
      headerFrom: "notify@payments.interac.ca",
      authResults: "mx.cloudflare.net; spf=pass; dkim=pass header.d=evil.example",
    });
    expect(verifyInteracSender(msg, ALLOWLIST)).toBe(false);
  });

  it("fails on lookalike domain (interac.ca.evil.example)", () => {
    const msg = makeMessage({
      envelopeFrom: "notify@interac.ca.evil.example",
      authResults: CF_PASS,
    });
    expect(verifyInteracSender(msg, ALLOWLIST)).toBe(false);
  });

  it("fails when dkim fails", () => {
    const msg = makeMessage({
      envelopeFrom: "donotreply@interac.ca",
      authResults: "dkim=fail; spf=pass",
    });
    expect(verifyInteracSender(msg, ALLOWLIST)).toBe(false);
  });

  it("fails when spf fails", () => {
    const msg = makeMessage({
      envelopeFrom: "donotreply@interac.ca",
      authResults: "dkim=pass; spf=softfail",
    });
    expect(verifyInteracSender(msg, ALLOWLIST)).toBe(false);
  });

  it("fails when authentication-results header is missing", () => {
    const msg = makeMessage({ envelopeFrom: "donotreply@interac.ca" });
    expect(verifyInteracSender(msg, ALLOWLIST)).toBe(false);
  });

  it("fails for malformed sender without a domain", () => {
    const msg = makeMessage({ envelopeFrom: "not-an-email", authResults: "dkim=pass; spf=pass" });
    expect(verifyInteracSender(msg, ALLOWLIST)).toBe(false);
  });

  it("fails with an empty allowlist", () => {
    const msg = makeMessage({ envelopeFrom: "notify@payments.interac.ca", authResults: CF_PASS });
    expect(verifyInteracSender(msg, [])).toBe(false);
  });
});
