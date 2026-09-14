import { handleApiRequest } from "./api";
import { parseInteracEmail } from "./parser";
import { verifyInteracSender } from "./emailVerifier";
import { dispatchWebhooks } from "./webhooks";
import type { Env } from "./types";

export default {
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext,
  ) {
    const allowlist = env.INTERAC_DOMAIN_ALLOWLIST.split(",").map((d) =>
      d.trim(),
    );
    const senderVerified = verifyInteracSender(message, allowlist);

    const rawEmail = await new Response(message.raw).arrayBuffer();

    const parsed = await parseInteracEmail(rawEmail, message.to);
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
    if (!senderVerified) {
      // Forwarded mail: outer envelope is NOT from Interac, so SPF/DKIM fail.
      // Flag it for manual review rather than silently rejecting or trusting it.
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
      const transactionRow = { id: idKey, ...parsed, status, created_at: now };
      ctx.waitUntil(
        dispatchWebhooks(env.DB, transactionRow, env.WEBHOOK_SIGNING_KEY),
      );
    }

    console.log(`Processed email: ${idKey} status=${status}`);
  },

  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, env);
    }
    return new Response("Interac Inbox Worker", { status: 200 });
  },
};

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
