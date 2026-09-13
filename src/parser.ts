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

export async function parseInteracEmail(
  rawEmail: ReadableStream | ArrayBuffer,
  toEmail: string | null,
): Promise<ParsedInteracEmail> {
  const parser = new PostalMime();
  const parsed = await parser.parse(rawEmail as ArrayBuffer);

  const messageId = parsed.messageId ?? "";
  const replyToEmail = parsed.replyTo?.[0]?.address ?? null;
  const subject = parsed.subject ?? null;

  const bodyText = parsed.text ?? stripHtml(parsed.html ?? "");
  const bodyRaw = bodyText || null;

  const language = detectLanguage(subject, bodyText);
  const amountCents = parseAmount(bodyText, language);
  const isAutoDeposit = detectAutoDeposit(bodyText, language);
  const reference = parseReference(bodyText, language);
  const fromName = parseFromName(bodyText, parsed.from?.name ?? null);
  const userMessage = parseUserMessage(bodyText);

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
    senderVerified: false,
  };
}

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

function parseReference(
  body: string,
  language: "en" | "fr" | null,
): string | null {
  const patterns =
    language === "fr"
      ? [
          /[Nn]uméro\s+de\s+référence\s*[:.]?\s*([A-Za-z0-9\-]+)/,
          /[Rr]eference\s*[Nn]umber\s*[:.]?\s*([A-Za-z0-9\-]+)/,
        ]
      : [
          /[Rr]eference\s*[Nn]umber\s*[:.]?\s*([A-Za-z0-9\-]+)/,
          /[Nn]uméro\s+de\s+référence\s*[:.]?\s*([A-Za-z0-9\-]+)/,
        ];

  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function parseFromName(
  body: string,
  senderDisplayName: string | null,
): string | null {
  const fromMatch = body.match(
    /(?:^|\n)\s*(?:FROM|De)\s*[:]\s*(.+?)(?:\n|$)/im,
  );
  if (fromMatch) return fromMatch[1].trim();

  const sentEnMatch = body.match(/^(.+?)\s+sent you/m);
  if (sentEnMatch) return sentEnMatch[1].trim();

  const sentFrMatch = body.match(/^(.+?)\s+vous a envoyé/m);
  if (sentFrMatch) return sentFrMatch[1].trim();

  return senderDisplayName || null;
}

function parseUserMessage(body: string): string | null {
  const patterns = [
    /(?:^|\n)\s*(?:MESSAGE|Message|MESSAGE DE L'EXPÉDITEUR|MESSAGE DE LEXPÉDITEUR)\s*[:]\s*(.+?)(?:\n|$)/im,
  ];

  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match) {
      const msg = match[1].trim();
      if (msg.length > 0) return msg;
    }
  }
  return null;
}
