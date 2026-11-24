import { describe, it, expect } from "vitest";
import { verifyInteracSender } from "../src/emailVerifier";

const ALLOWLIST = ["payments.interac.ca", "interac.ca", "notifications.interac.ca"];

function makeMessage(from: string, authResults?: string): ForwardableEmailMessage {
  const headers = new Headers();
  if (authResults !== undefined) headers.set("authentication-results", authResults);
  return { from, headers } as unknown as ForwardableEmailMessage;
}

describe("verifyInteracSender", () => {
  it("passes for allowlisted domain with spf+dkim pass", () => {
    const msg = makeMessage(
      "donotreply@payments.interac.ca",
      "mx.cloudflare.net; dkim=pass header.d=payments.interac.ca; spf=pass smtp.mailfrom=payments.interac.ca",
    );
    expect(verifyInteracSender(msg, ALLOWLIST)).toBe(true);
  });

  it("is case-insensitive on the sender domain", () => {
    const msg = makeMessage(
      "donotreply@Payments.Interac.CA",
      "dkim=pass; spf=pass",
    );
    expect(verifyInteracSender(msg, ALLOWLIST)).toBe(true);
  });

  it("fails for non-allowlisted domain even with spf+dkim pass", () => {
    const msg = makeMessage("someone@gmail.com", "dkim=pass; spf=pass");
    expect(verifyInteracSender(msg, ALLOWLIST)).toBe(false);
  });

  it("fails when dkim fails", () => {
    const msg = makeMessage("donotreply@interac.ca", "dkim=fail; spf=pass");
    expect(verifyInteracSender(msg, ALLOWLIST)).toBe(false);
  });

  it("fails when spf fails", () => {
    const msg = makeMessage("donotreply@interac.ca", "dkim=pass; spf=softfail");
    expect(verifyInteracSender(msg, ALLOWLIST)).toBe(false);
  });

  it("fails when authentication-results header is missing", () => {
    const msg = makeMessage("donotreply@interac.ca");
    expect(verifyInteracSender(msg, ALLOWLIST)).toBe(false);
  });

  it("fails for malformed sender without a domain", () => {
    const msg = makeMessage("not-an-email", "dkim=pass; spf=pass");
    expect(verifyInteracSender(msg, ALLOWLIST)).toBe(false);
  });
});
