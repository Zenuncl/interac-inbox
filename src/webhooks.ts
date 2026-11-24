export const WEBHOOK_EVENT = "transaction.received";

/** Attempts per (webhook, transaction) before we give up. */
export const MAX_ATTEMPTS = 5;

/**
 * Delay (seconds) before retrying after a failed attempt N.
 * attempt 1 -> 1m, 2 -> 5m, 3 -> 30m, 4 -> 2h. attempt 5 is terminal.
 */
const BACKOFF_SECONDS = [0, 60, 300, 1800, 7200];

export function backoffFor(attempt: number): number {
  return BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length - 1)];
}

interface WebhookRow {
  id: string;
  url: string;
}

type TransactionRow = Record<string, unknown> & { id: string };

/**
 * Initial dispatch: send the transaction to every active webhook (attempt 1).
 * Failures are recorded in webhook_deliveries and picked up by the cron retry.
 */
export async function dispatchWebhooks(
  db: D1Database,
  transactionId: string,
  signingKey: string,
): Promise<void> {
  const transaction = await loadTransaction(db, transactionId);
  if (!transaction) {
    console.error("dispatchWebhooks: transaction not found", transactionId);
    return;
  }

  const webhooks = await db
    .prepare("SELECT id, url FROM webhooks WHERE active = 1")
    .all<WebhookRow>();
  if (!webhooks.results.length) return;

  const results = await Promise.allSettled(
    webhooks.results.map((wh) =>
      sendWebhook(db, wh, transaction, signingKey, 1),
    ),
  );
  reportRejections(results);
}

/**
 * Cron entry point: re-send deliveries whose most recent attempt failed,
 * once their backoff window has elapsed and while under MAX_ATTEMPTS.
 */
export async function retryFailedWebhooks(
  db: D1Database,
  signingKey: string,
  limit = 50,
): Promise<{ scanned: number; retried: number }> {
  const now = Math.floor(Date.now() / 1000);

  // Latest delivery row per (webhook, transaction) that is still failed.
  const due = await db
    .prepare(
      `SELECT d.webhook_id, d.transaction_id, d.attempt, d.created_at, w.url
       FROM webhook_deliveries d
       JOIN webhooks w ON w.id = d.webhook_id
       WHERE d.status = 'failed'
         AND w.active = 1
         AND d.attempt < ?
         AND NOT EXISTS (
           SELECT 1 FROM webhook_deliveries d2
           WHERE d2.webhook_id = d.webhook_id
             AND d2.transaction_id = d.transaction_id
             AND d2.attempt > d.attempt
         )
       ORDER BY d.created_at ASC
       LIMIT ?`,
    )
    .bind(MAX_ATTEMPTS, limit)
    .all<{
      webhook_id: string;
      transaction_id: string;
      attempt: number;
      created_at: number;
      url: string;
    }>();

  const ready = due.results.filter(
    (d) => d.created_at + backoffFor(d.attempt) <= now,
  );
  if (!ready.length) return { scanned: due.results.length, retried: 0 };

  const results = await Promise.allSettled(
    ready.map(async (d) => {
      const transaction = await loadTransaction(db, d.transaction_id);
      if (!transaction) return;
      await sendWebhook(
        db,
        { id: d.webhook_id, url: d.url },
        transaction,
        signingKey,
        d.attempt + 1,
      );
    }),
  );
  reportRejections(results);
  return { scanned: due.results.length, retried: ready.length };
}

/** POST one transaction to one webhook and record the delivery outcome. */
export async function sendWebhook(
  db: D1Database,
  webhook: WebhookRow,
  transaction: TransactionRow,
  signingKey: string,
  attempt: number,
): Promise<boolean> {
  const payload = JSON.stringify({ event: WEBHOOK_EVENT, data: transaction });
  const signature = await hmacSign(payload, signingKey);
  const deliveryId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  let status = "failed";
  let responseCode = 0;
  let responseBody = "";

  try {
    const response = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature": signature,
        "X-Interac-Inbox-Event": WEBHOOK_EVENT,
        "X-Interac-Inbox-Attempt": String(attempt),
      },
      body: payload,
    });
    responseCode = response.status;
    responseBody = await response.text();
    status = response.ok ? "success" : "failed";
  } catch (err) {
    console.error(`Webhook delivery failed for ${webhook.url}:`, err);
    responseBody = String(err);
  }

  await db
    .prepare(
      "INSERT INTO webhook_deliveries (id, webhook_id, transaction_id, attempt, status, response_code, response_body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      deliveryId,
      webhook.id,
      transaction.id,
      attempt,
      status,
      responseCode,
      responseBody.slice(0, 500),
      now,
    )
    .run();

  return status === "success";
}

async function loadTransaction(
  db: D1Database,
  id: string,
): Promise<TransactionRow | null> {
  const row = await db
    .prepare("SELECT * FROM transactions WHERE id = ?")
    .bind(id)
    .first<TransactionRow>();
  return row ?? null;
}

function reportRejections(results: PromiseSettledResult<unknown>[]): void {
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length) {
    console.error(
      `${failures.length}/${results.length} webhook dispatches threw`,
      failures.map((f) => String((f as PromiseRejectedResult).reason)),
    );
  }
}

async function hmacSign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
