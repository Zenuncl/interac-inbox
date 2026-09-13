export interface ParsedInteracEmail {
  messageId: string;
  fromName: string | null;
  toEmail: string | null;
  replyToEmail: string | null;
  amountCents: number;
  currency: string;
  reference: string | null;
  isAutoDeposit: boolean;
  userMessage: string | null;
  language: "en" | "fr" | null;
  subject: string | null;
  bodyRaw: string | null;
  senderVerified: boolean;
}

export interface Env {
  DB: D1Database;
  API_KEY: string;
  WEBHOOK_SIGNING_KEY: string;
  INTERAC_DOMAIN_ALLOWLIST: string;
}
