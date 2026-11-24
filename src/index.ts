import { handleApiRequest } from "./api";
import { parseInteracEmail } from "./parser";
import { verifyInteracSender } from "./emailVerifier";
import { dispatchWebhooks, retryFailedWebhooks } from "./webhooks";
import type { Env, ParsedInteracEmail } from "./types";

export default {
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext,
  ) {
    const allowlist = env.INTERAC_DOMAIN_ALLOWLIST.split(",").map((d) =>
      d.trim().toLowerCase(),
    );
    const senderVerified = verifyInteracSender(message, allowlist);

    const rawEmail = await new Response(message.raw).arrayBuffer();

    let parsed: ParsedInteracEmail;
    let parseError: string | null = null;
    try {
      parsed = await parseInteracEmail(rawEmail, message.to);
    } catch (err) {
      // Never drop mail on the floor: record what we got so it can be
      // reviewed manually instead of bouncing back to Interac.
      parseError = String(err);
      console.error("Failed to parse inbound email:", err);
      parsed = fallbackParsed(message, rawEmail);
    }
    parsed.senderVerified = senderVerified;

    const idKey = await buildIdempotencyKey(
      parsed.messageId,
      parsed.reference,
      parsed.amountCents,
    );

    const existing = await env.DB.prepare(
      "SELECT id FROM transactions WHERE id = ?",
    )
      .bind(idKey)
      .first();
    if (existing) {
      console.log("Duplicate transaction, skipping:", idKey);
      return;
    }

    let status: string;
    if (parseError || !senderVerified) {
      // Unparseable, or forwarded mail: outer envelope is NOT from Interac,
      // so SPF/DKIM fail. Flag for manual review rather than silently
      // rejecting or trusting it.
      status = "flagged";
    } else if (!parsed.isAutoDeposit) {
      status = "pending_deposit";
    } else {
      status = "unmatched";
    }

    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO transactions (id, message_id, from_name, to_email, reply_to_email, amount_cents, currency, reference, is_auto_deposit, user_message, language, subject, body_raw, is_forwarded, sender_verified, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        idKey,
        parsed.messageId,
        parsed.fromName,
        parsed.toEmail,
        parsed.replyToEmail,
        parsed.amountCents,
        parsed.currency,
        parsed.reference,
        parsed.isAutoDeposit ? 1 : 0,
        parsed.userMessage,
        parsed.language,
        parsed.subject,
        parsed.bodyRaw,
        parsed.isForwarded ? 1 : 0,
        senderVerified ? 1 : 0,
        status,
        now,
        now,
      )
      .run();

    if (status === "unmatched") {
      ctx.waitUntil(dispatchWebhooks(env.DB, idKey, env.WEBHOOK_SIGNING_KEY));
    }

    console.log(
      `Processed email: ${idKey} status=${status}${parseError ? " (parse error)" : ""}`,
    );
  },

  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, env, ctx);
    }
    return new Response("Interac Inbox Worker", { status: 200 });
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      retryFailedWebhooks(env.DB, env.WEBHOOK_SIGNING_KEY).then((r) =>
        console.log(
          `Webhook retry sweep: scanned=${r.scanned} retried=${r.retried}`,
        ),
      ),
    );
  },
};

/**
 * Minimal record for mail the parser could not handle. Keeps the raw body
 * so a human can inspect it; amount 0 ensures nothing downstream treats it
 * as a real payment.
 */
function fallbackParsed(
  message: ForwardableEmailMessage,
  rawEmail: ArrayBuffer,
): ParsedInteracEmail {
  const messageId =
    message.headers.get("message-id") ?? `unparsed-${crypto.randomUUID()}`;
  let bodyRaw: string | null = null;
  try {
    bodyRaw = new TextDecoder().decode(rawEmail).slice(0, 64 * 1024);
  } catch {
    bodyRaw = null;
  }
  return {
    messageId,
    fromName: message.from,
    toEmail: message.to,
    replyToEmail: null,
    amountCents: 0,
    currency: "CAD",
    reference: null,
    isAutoDeposit: false,
    userMessage: null,
    language: null,
    subject: message.headers.get("subject"),
    bodyRaw,
    isForwarded: false,
    senderVerified: false,
  };
}

async function buildIdempotencyKey(
  messageId: string,
  reference: string | null,
  amountCents: number,
): Promise<string> {
  const data = `${messageId}|${reference ?? ""}|${amountCents}`;
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(data),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
