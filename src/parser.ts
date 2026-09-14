import PostalMime from "postal-mime";
import type { ParsedInteracEmail } from "./types";

const FRENCH_KEYWORDS = [
  "vous avez reçu",
  "dépôt automatique",
  "virement",
  "déposé automatiquement",
  "montant de",
  "numéro de référence",
];

const AUTO_DEPOSIT_EN = [
  "automatically deposited",
  "auto deposit",
  "autodeposit",
];

const AUTO_DEPOSIT_FR = [
  "dépôt automatique",
  "déposé automatiquement",
];

// Patterns that identify a forwarded email wrapper
const GMAIL_FORWARD_RE =
  /^-{5,}\s*Forwarded message\s*-{5,}/im;
const APPLE_FORWARD_RE =
  /^Begin forwarded message:/im;
const OUTLOOK_FORWARD_RE =
  /^-{5,}\s*Original Message\s*-{5,}/im;

export async function parseInteracEmail(
  rawEmail: ReadableStream | ArrayBuffer,
  toEmail: string | null,
): Promise<ParsedInteracEmail> {
  const parser = new PostalMime();
  const parsed = await parser.parse(rawEmail as ArrayBuffer);

  const messageId = parsed.messageId ?? "";
  const subject = parsed.subject ?? null;

  // Prefer plain text body; fall back to HTML-stripped version
  const bodyText = parsed.text ?? stripHtml(parsed.html ?? "");

  // Detect forwarded email and unwrap inner content
  const forwardResult = detectAndUnwrapForwarded(bodyText);
  const isForwarded = forwardResult.isForwarded;
  const innerBody = forwardResult.innerBody; // The Interac-original content to parse

  // For forwarded mail, the outer Reply-To is the forwarder's, not Interac's.
  // Prefer inner headers embedded in the forwarded body.
  const replyToEmail = isForwarded
    ? forwardResult.embeddedReplyTo ?? parsed.replyTo?.[0]?.address ?? null
    : parsed.replyTo?.[0]?.address ?? parseReplyToFromBody(innerBody) ?? null;

  const bodyRaw = bodyText || null;

  const language = detectLanguage(subject, innerBody);
  const amountCents = parseAmount(innerBody, language);
  const isAutoDeposit = detectAutoDeposit(innerBody, language);

  // Reference: try URL query param first (most reliable in real emails), then labelled text
  const reference = parseReference(innerBody, language);

  // From name: look in inner body, then fall back to outer from header
  const outerFromName = parsed.from?.name ?? null;
  const embeddedFromName = isForwarded ? forwardResult.embeddedFrom : null;
  const fromName = parseFromName(innerBody, embeddedFromName ?? outerFromName);

  const userMessage = parseUserMessage(innerBody);

  return {
    messageId,
    fromName,
    toEmail,
    replyToEmail,
    amountCents,
    currency: "CAD",
    reference,
    isAutoDeposit,
    userMessage,
    language,
    subject,
    bodyRaw,
    isForwarded,
    senderVerified: false,
  };
}

// ---------------------------------------------------------------------------
// Forwarded email detection + unwrapping
// ---------------------------------------------------------------------------

interface ForwardUnwrapResult {
  isForwarded: boolean;
  innerBody: string;
  embeddedFrom: string | null;
  embeddedReplyTo: string | null;
}

function detectAndUnwrapForwarded(body: string): ForwardUnwrapResult {
  const NOT_FORWARDED: ForwardUnwrapResult = {
    isForwarded: false,
    innerBody: body,
    embeddedFrom: null,
    embeddedReplyTo: null,
  };

  let markerMatch: RegExpMatchArray | null = null;
  let markerIndex = -1;

  // Gmail: "---------- Forwarded message ---------"
  const gmailMatch = body.match(GMAIL_FORWARD_RE);
  if (gmailMatch && gmailMatch.index !== undefined) {
    markerMatch = gmailMatch;
    markerIndex = gmailMatch.index;
  }

  // Apple Mail: "Begin forwarded message:"
  if (!markerMatch) {
    const appleMatch = body.match(APPLE_FORWARD_RE);
    if (appleMatch && appleMatch.index !== undefined) {
      markerMatch = appleMatch;
      markerIndex = appleMatch.index;
    }
  }

  // Outlook / other: "-----Original Message-----"
  if (!markerMatch) {
    const outlookMatch = body.match(OUTLOOK_FORWARD_RE);
    if (outlookMatch && outlookMatch.index !== undefined) {
      markerMatch = outlookMatch;
      markerIndex = outlookMatch.index;
    }
  }

  if (!markerMatch || markerIndex < 0) return NOT_FORWARDED;

  // Everything after the marker is the forwarded content block
  const forwardedBlock = body.slice(markerIndex + markerMatch[0].length);

  // Strip quote prefixes FIRST so that embedded header extraction works on
  // both normal forwarded blocks AND "> "-quoted forwarded blocks.
  const innerBody = stripQuotePrefix(forwardedBlock);

  // Extract embedded From / Reply-To headers that mail clients inline as text
  // Gmail/Outlook style: "From: Name <email@domain.com>"
  const embeddedFrom = extractEmbeddedHeader(innerBody, "From");
  const embeddedReplyTo = extractEmbeddedHeader(innerBody, "Reply-To");

  return {
    isForwarded: true,
    innerBody,
    embeddedFrom,
    embeddedReplyTo,
  };
}

/**
 * Extracts a header value from the text block that mail clients embed inside
 * forwarded content, e.g.:
 *   From: John Doe <john@example.com>
 *   Reply-To: john@example.com
 */
function extractEmbeddedHeader(block: string, header: string): string | null {
  const re = new RegExp(
    `^${header}:\\s*(.+?)$`,
    "im",
  );
  const match = block.match(re);
  if (!match) return null;
  const raw = match[1].trim();
  // Try to extract just the email address from "Name <email>" format
  const angleMatch = raw.match(/<([^>]+@[^>]+)>/);
  if (angleMatch) return angleMatch[1].trim();
  // Plain email address
  const emailMatch = raw.match(/\S+@\S+/);
  if (emailMatch) return emailMatch[0];
  return raw;
}

/**
 * Strip leading ">" quote prefixes from forwarded body lines.
 */
function stripQuotePrefix(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^>+\s?/, ""))
    .join("\n");
}

// ---------------------------------------------------------------------------
// HTML stripping
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

function detectLanguage(
  subject: string | null,
  body: string,
): "en" | "fr" | null {
  const text = `${subject ?? ""} ${body}`.toLowerCase();
  for (const kw of FRENCH_KEYWORDS) {
    if (text.includes(kw)) return "fr";
  }
  return "en";
}

// ---------------------------------------------------------------------------
// Amount parsing
// ---------------------------------------------------------------------------

function parseAmount(body: string, language: "en" | "fr" | null): number {
  if (language === "fr") {
    const frMatch = body.match(
      /(\d[\d\s]*(?:\d))\s*,\s*(\d{2})\s*\$/,
    );
    if (frMatch) {
      const dollars = parseInt(frMatch[1].replace(/\s/g, ""), 10);
      const cents = parseInt(frMatch[2], 10);
      return dollars * 100 + cents;
    }
  }

  const enMatch = body.match(/\$\s*([\d,]+)\.(\d{2})/);
  if (enMatch) {
    const dollars = parseInt(enMatch[1].replace(/,/g, ""), 10);
    const cents = parseInt(enMatch[2], 10);
    return dollars * 100 + cents;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Auto-deposit detection
// ---------------------------------------------------------------------------

function detectAutoDeposit(
  body: string,
  language: "en" | "fr" | null,
): boolean {
  const lower = body.toLowerCase();

  if (language === "fr") {
    return AUTO_DEPOSIT_FR.some((phrase) => lower.includes(phrase));
  }

  return AUTO_DEPOSIT_EN.some((phrase) => lower.includes(phrase));
}

// ---------------------------------------------------------------------------
// Reference number parsing
//
// Real Interac emails embed the reference in a URL query parameter AND/OR as
// a labelled line.  We try both extraction strategies.
//
// Known URL patterns (from real Interac emails observed in the wild):
//   https://...interac.ca/...?referenceNumber=2FE7-A1B2C3D4
//   https://...interac.ca/...?etransferReferenceNumber=ETR-2024-XXXXXX
//
// Known label patterns:
//   Reference Number: ETR-2024-XK9P2L
//   Numéro de référence: ETR-2024-XK9P2L
//   Ref: XXXX
//   Confirmation number: XXXX
// ---------------------------------------------------------------------------

function parseReference(
  body: string,
  language: "en" | "fr" | null,
): string | null {
  // Strategy 1: URL query parameter (most reliable — not localized)
  const urlParamPatterns = [
    /[?&]referenceNumber=([A-Za-z0-9\-]+)/i,
    /[?&]etransferReferenceNumber=([A-Za-z0-9\-]+)/i,
    /[?&]confirmationNumber=([A-Za-z0-9\-]+)/i,
    /[?&]ref=([A-Za-z0-9\-]+)/i,
  ];
  for (const re of urlParamPatterns) {
    const m = body.match(re);
    if (m) return m[1];
  }

  // Strategy 2: Labelled text lines (both languages, order by detected language)
  const enPatterns = [
    /[Rr]eference\s*[Nn]umber\s*[:.]?\s*([A-Za-z0-9\-]+)/,
    /[Rr]eference\s*#\s*[:.]?\s*([A-Za-z0-9\-]+)/,
    /[Cc]onfirmation\s*[Nn]umber\s*[:.]?\s*([A-Za-z0-9\-]+)/,
    /[Cc]onfirmation\s*#\s*[:.]?\s*([A-Za-z0-9\-]+)/,
    /\bRef(?:erence)?\s*[:.]?\s*([A-Za-z0-9\-]{6,})/,
  ];
  const frPatterns = [
    /[Nn]uméro\s+de\s+référence\s*[:.]?\s*([A-Za-z0-9\-]+)/,
    /[Nn]uméro\s+de\s+confirmation\s*[:.]?\s*([A-Za-z0-9\-]+)/,
    /[Rr]éférence\s*[:.]?\s*([A-Za-z0-9\-]{6,})/,
    // English fallbacks even in FR emails
    /[Rr]eference\s*[Nn]umber\s*[:.]?\s*([A-Za-z0-9\-]+)/,
  ];

  const patterns =
    language === "fr" ? [...frPatterns, ...enPatterns] : [...enPatterns, ...frPatterns];

  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match) return match[1];
  }

  return null;
}

// ---------------------------------------------------------------------------
// Sender name parsing
// ---------------------------------------------------------------------------

function parseFromName(
  body: string,
  senderDisplayName: string | null,
): string | null {
  // "John Doe sent you $X"
  const sentEnMatch = body.match(/^(.+?)\s+sent you/m);
  if (sentEnMatch) return sentEnMatch[1].trim();

  // "Pierre Leblanc vous a envoyé X $"
  const sentFrMatch = body.match(/^(.+?)\s+vous a envoyé/m);
  if (sentFrMatch) return sentFrMatch[1].trim();

  // Explicit FROM/De label in body
  const fromMatch = body.match(/(?:^|\n)\s*(?:FROM|De)\s*[:]\s*(.+?)(?:\n|$)/im);
  if (fromMatch) return fromMatch[1].trim();

  return senderDisplayName || null;
}

// ---------------------------------------------------------------------------
// Reply-To extraction from body text
// (fallback when the Reply-To header is absent, as sometimes happens)
// ---------------------------------------------------------------------------

function parseReplyToFromBody(body: string): string | null {
  // Some Interac email templates include a line like:
  //   "Reply to this message to contact [Name] at email@domain.com"
  const replyLineMatch = body.match(
    /reply[- ]to[^@\n]*?([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})/i,
  );
  if (replyLineMatch) return replyLineMatch[1];
  return null;
}

// ---------------------------------------------------------------------------
// User message parsing
//
// Real Interac emails use "Message:" or "Message from sender:" labels.
// The message can also span a paragraph — we capture until the next blank
// line or end-of-body rather than just the remainder of the same line.
// ---------------------------------------------------------------------------

function parseUserMessage(body: string): string | null {
  // Try single-line label patterns first
  const singleLinePatterns = [
    /(?:^|\n)\s*(?:Message from sender|Message de l'expéditeur|Message de lexpéditeur|MESSAGE|Message)\s*[:\-]\s*(.+?)(?:\n|$)/im,
  ];

  for (const pattern of singleLinePatterns) {
    const match = body.match(pattern);
    if (match) {
      const msg = match[1].trim();
      if (msg.length > 0) return msg;
    }
  }

  // Try multi-line block: label on its own line, then content until blank line
  const blockPattern =
    /(?:^|\n)\s*(?:Message from sender|Message de l'expéditeur|Message de lexpéditeur|MESSAGE|Message)\s*[:\-]?\s*\n([\s\S]+?)(?:\n\s*\n|$)/im;
  const blockMatch = body.match(blockPattern);
  if (blockMatch) {
    // Trim and collapse internal newlines
    const lines = blockMatch[1]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length > 0) return lines.join(" ");
  }

  return null;
}
