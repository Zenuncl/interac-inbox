/**
 * Decide whether an inbound message is authentically from Interac.
 *
 * Cloudflare Email Routing prepends an `Authentication-Results` header of the
 * form:
 *
 *   mx.cloudflare.net; spf=pass; dkim=pass header.d=payments.interac.ca; dmarc=pass header.from=payments.interac.ca
 *
 * Verification requires BOTH:
 *   1. The sender domain is allowlisted. We check the RFC5322 `From:` header
 *      domain (what Interac documents: notify@payments.interac.ca) and the
 *      SMTP envelope sender (`message.from`), since bulk senders often use a
 *      different bounce domain for the envelope.
 *   2. Authentication passed. `dmarc=pass` is sufficient (it proves SPF or
 *      DKIM aligned with the From domain). Otherwise require `spf=pass` AND a
 *      `dkim=pass` whose `header.d` (if reported) is an allowlisted domain.
 *
 * Allowlist entries match exact domains and their subdomains.
 */
export function verifyInteracSender(
  message: ForwardableEmailMessage,
  allowlist: string[],
): boolean {
  const allowed = allowlist.map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length) return false;

  const envelopeDomain = domainOf(message.from);
  const headerDomain = domainOf(extractAddress(message.headers.get("from")));
  const domainOk =
    isAllowed(headerDomain, allowed) || isAllowed(envelopeDomain, allowed);
  if (!domainOk) return false;

  const auth = parseAuthResults(message.headers.get("authentication-results"));
  if (auth.dmarcPass) return true;

  const dkimOk =
    auth.dkimPass &&
    (auth.dkimDomains.length === 0 ||
      auth.dkimDomains.some((d) => isAllowed(d, allowed)));

  return dkimOk && auth.spfPass;
}

export interface AuthResults {
  spfPass: boolean;
  dkimPass: boolean;
  /** `header.d=` values attached to dkim=pass results. */
  dkimDomains: string[];
  dmarcPass: boolean;
}

/**
 * Parse the Cloudflare-authored Authentication-Results. If several headers
 * were present (upstream relays add their own), only trust the segment
 * authored by `mx.cloudflare.net`.
 */
export function parseAuthResults(header: string | null): AuthResults {
  const result: AuthResults = {
    spfPass: false,
    dkimPass: false,
    dkimDomains: [],
    dmarcPass: false,
  };
  if (!header) return result;

  let text = header.toLowerCase();
  const cfIndex = text.indexOf("mx.cloudflare.net");
  if (cfIndex >= 0) {
    text = text.slice(cfIndex);
    // Stop at the next authserv-id if another header was concatenated after.
    const next = text.slice(1).search(/,\s*[a-z0-9.-]+;\s*(spf|dkim|dmarc|arc)=/);
    if (next >= 0) text = text.slice(0, next + 1);
  }

  // Each result is "method=value" followed by optional "key=value" props,
  // separated by ";".
  for (const segment of text.split(";")) {
    const s = segment.trim();
    if (s.startsWith("spf=pass")) result.spfPass = true;
    else if (s.startsWith("dmarc=pass")) result.dmarcPass = true;
    else if (s.startsWith("dkim=pass")) {
      result.dkimPass = true;
      const d = s.match(/header\.d=([a-z0-9.-]+)/);
      if (d) result.dkimDomains.push(d[1]);
    }
  }
  return result;
}

function isAllowed(domain: string | null, allowed: string[]): boolean {
  if (!domain) return false;
  return allowed.some((a) => domain === a || domain.endsWith(`.${a}`));
}

function domainOf(address: string | null): string | null {
  if (!address) return null;
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  const domain = address
    .slice(at + 1)
    .trim()
    .replace(/[>\s]+$/, "")
    .toLowerCase();
  return domain || null;
}

/** "Interac <notify@payments.interac.ca>" -> "notify@payments.interac.ca" */
function extractAddress(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const angle = headerValue.match(/<([^>]+)>/);
  if (angle) return angle[1].trim();
  const bare = headerValue.match(/[^\s"<>,]+@[^\s"<>,]+/);
  return bare ? bare[0] : null;
}
