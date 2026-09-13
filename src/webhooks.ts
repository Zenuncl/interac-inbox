export async function dispatchWebhooks(
  db: D1Database,
  transaction: Record<string, unknown>,
  signingKey: string,
): Promise<void> {
  const webhooks = await db
    .prepare("SELECT id, url FROM webhooks WHERE active = 1")
    .all<{ id: string; url: string }>();

  if (!webhooks.results.length) return;

  const payload = JSON.stringify({
    event: "transaction.received",
    data: transaction,
  });

  const signature = await hmacSign(payload, signingKey);
  const now = Math.floor(Date.now() / 1000);

  const results = await Promise.allSettled(
    webhooks.results.map(async (webhook) => {
      const deliveryId = crypto.randomUUID();
      try {
        const response = await fetch(webhook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Signature": signature,
            "X-Interac-Inbox-Event": "transaction.received",
          },
          body: payload,
        });

        const responseBody = await response.text();
        const status = response.ok ? "success" : "failed";

        await db
          .prepare(
            "INSERT INTO webhook_deliveries (id, webhook_id, transaction_id, attempt, status, response_code, response_body, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)",
          )
          .bind(
            deliveryId,
            webhook.id,
            transaction.id as string,
            status,
            response.status,
            responseBody.slice(0, 500),
            now,
          )
          .run();
      } catch (err) {
        console.error(
          `Webhook delivery failed for ${webhook.url}:`,
          err,
        );
        await db
          .prepare(
            "INSERT INTO webhook_deliveries (id, webhook_id, transaction_id, attempt, status, response_code, response_body, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)",
          )
          .bind(
            deliveryId,
            webhook.id,
            transaction.id as string,
            "failed",
            0,
            String(err).slice(0, 500),
            now,
          )
          .run();
      }
    }),
  );

  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length) {
    console.error(`${failures.length}/${results.length} webhook dispatches failed`);
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
