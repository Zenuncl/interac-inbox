import type { Env } from "./types";
import { dispatchWebhooks } from "./webhooks";

/** Statuses a human reviewer may promote to `unmatched`. */
const APPROVABLE_STATUSES = ["flagged", "pending_deposit"];
/** Statuses a human reviewer may mark as `rejected`. */
const REJECTABLE_STATUSES = ["flagged", "pending_deposit", "unmatched"];

export async function handleApiRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${env.API_KEY}`) {
    return json({ error: "Unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === "GET" && path === "/api/transactions") {
    return getTransactions(url, env);
  }

  const txMatch = path.match(/^\/api\/transactions\/([^/]+)$/);
  if (txMatch) {
    const id = txMatch[1];
    if (method === "GET") return getTransaction(id, env);
  }

  const matchRoute = path.match(
    /^\/api\/transactions\/([^/]+)\/match$/,
  );
  if (matchRoute && method === "POST") {
    return matchTransaction(matchRoute[1], request, env);
  }

  const approveRoute = path.match(/^\/api\/transactions\/([^/]+)\/approve$/);
  if (approveRoute && method === "POST") {
    return approveTransaction(approveRoute[1], env, ctx);
  }

  const rejectRoute = path.match(/^\/api\/transactions\/([^/]+)\/reject$/);
  if (rejectRoute && method === "POST") {
    return rejectTransaction(rejectRoute[1], env);
  }

  const deliveriesRoute = path.match(
    /^\/api\/transactions\/([^/]+)\/deliveries$/,
  );
  if (deliveriesRoute && method === "GET") {
    return getDeliveries(deliveriesRoute[1], env);
  }

  if (method === "GET" && path === "/api/webhooks") {
    return getWebhooks(url, env);
  }

  if (method === "POST" && path === "/api/webhooks") {
    return createWebhook(request, env);
  }

  const whDeleteMatch = path.match(/^\/api\/webhooks\/([^/]+)$/);
  if (whDeleteMatch && method === "DELETE") {
    return deleteWebhook(whDeleteMatch[1], env);
  }

  return json({ error: "Not Found" }, 404);
}

async function getTransactions(
  url: URL,
  env: Env,
): Promise<Response> {
  const reference = url.searchParams.get("reference");
  const status = url.searchParams.get("status");
  const fromDate = url.searchParams.get("from_date");
  const toDate = url.searchParams.get("to_date");
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 200);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (reference) {
    conditions.push("reference = ?");
    bindings.push(reference);
  }
  if (status) {
    conditions.push("status = ?");
    bindings.push(status);
  }
  if (fromDate) {
    const ts = parseInt(fromDate, 10);
    if (Number.isNaN(ts)) return json({ error: "from_date must be a unix timestamp" }, 400);
    conditions.push("created_at >= ?");
    bindings.push(ts);
  }
  if (toDate) {
    const ts = parseInt(toDate, 10);
    if (Number.isNaN(ts)) return json({ error: "to_date must be a unix timestamp" }, 400);
    conditions.push("created_at <= ?");
    bindings.push(ts);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `SELECT * FROM transactions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  bindings.push(limit, offset);

  const result = await env.DB.prepare(query)
    .bind(...bindings)
    .all();

  return json(result.results);
}

async function getTransaction(
  id: string,
  env: Env,
): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT * FROM transactions WHERE id = ?",
  )
    .bind(id)
    .first();
  if (!row) return json({ error: "Not Found" }, 404);
  return json(row);
}

async function matchTransaction(
  id: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readJson<{ order_id?: string }>(request);
  if (!body || typeof body.order_id !== "string" || !body.order_id) {
    return json({ error: "order_id is required" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "UPDATE transactions SET status = 'matched', order_id = ?, updated_at = ? WHERE id = ?",
  )
    .bind(body.order_id, now, id)
    .run();

  const updated = await env.DB.prepare(
    "SELECT * FROM transactions WHERE id = ?",
  )
    .bind(id)
    .first();
  if (!updated) return json({ error: "Not Found" }, 404);
  return json(updated);
}

/**
 * Promote a reviewed `flagged` / `pending_deposit` transaction to `unmatched`
 * and fire webhooks, exactly as if it had arrived verified + auto-deposited.
 */
async function approveTransaction(
  id: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT id, status FROM transactions WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!row) return json({ error: "Not Found" }, 404);
  if (!APPROVABLE_STATUSES.includes(row.status)) {
    return json(
      {
        error: `Cannot approve transaction in status '${row.status}'`,
        allowed_from: APPROVABLE_STATUSES,
      },
      409,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "UPDATE transactions SET status = 'unmatched', updated_at = ? WHERE id = ?",
  )
    .bind(now, id)
    .run();

  ctx.waitUntil(dispatchWebhooks(env.DB, id, env.WEBHOOK_SIGNING_KEY));

  const updated = await env.DB.prepare(
    "SELECT * FROM transactions WHERE id = ?",
  )
    .bind(id)
    .first();
  return json(updated);
}

/** Mark a transaction as rejected so it is excluded from matching. */
async function rejectTransaction(id: string, env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT id, status FROM transactions WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!row) return json({ error: "Not Found" }, 404);
  if (!REJECTABLE_STATUSES.includes(row.status)) {
    return json(
      {
        error: `Cannot reject transaction in status '${row.status}'`,
        allowed_from: REJECTABLE_STATUSES,
      },
      409,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "UPDATE transactions SET status = 'rejected', updated_at = ? WHERE id = ?",
  )
    .bind(now, id)
    .run();

  const updated = await env.DB.prepare(
    "SELECT * FROM transactions WHERE id = ?",
  )
    .bind(id)
    .first();
  return json(updated);
}

async function getDeliveries(id: string, env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT d.*, w.url AS webhook_url
     FROM webhook_deliveries d
     JOIN webhooks w ON w.id = d.webhook_id
     WHERE d.transaction_id = ?
     ORDER BY d.created_at DESC, d.attempt DESC`,
  )
    .bind(id)
    .all();
  return json(result.results);
}

async function getWebhooks(url: URL, env: Env): Promise<Response> {
  const includeInactive = url.searchParams.get("include_inactive") === "1";
  const result = await env.DB.prepare(
    includeInactive
      ? "SELECT * FROM webhooks ORDER BY created_at DESC"
      : "SELECT * FROM webhooks WHERE active = 1 ORDER BY created_at DESC",
  ).all();
  return json(result.results);
}

async function createWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readJson<{ url?: string; description?: string }>(request);
  if (!body || typeof body.url !== "string" || !body.url) {
    return json({ error: "url is required" }, 400);
  }
  try {
    const u = new URL(body.url);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
  } catch {
    return json({ error: "url must be a valid http(s) URL" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);

  // url is UNIQUE; a previously deleted (active=0) webhook is reactivated
  // rather than failing the INSERT.
  const existing = await env.DB.prepare(
    "SELECT id, active FROM webhooks WHERE url = ?",
  )
    .bind(body.url)
    .first<{ id: string; active: number }>();

  let id: string;
  if (existing) {
    if (existing.active) {
      return json({ error: "webhook with this url already exists" }, 409);
    }
    id = existing.id;
    await env.DB.prepare(
      "UPDATE webhooks SET active = 1, description = COALESCE(?, description), created_at = ? WHERE id = ?",
    )
      .bind(body.description ?? null, now, id)
      .run();
  } else {
    id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO webhooks (id, url, description, active, created_at) VALUES (?, ?, ?, 1, ?)",
    )
      .bind(id, body.url, body.description ?? null, now)
      .run();
  }

  const webhook = await env.DB.prepare(
    "SELECT * FROM webhooks WHERE id = ?",
  )
    .bind(id)
    .first();

  return json(webhook, existing ? 200 : 201);
}

async function deleteWebhook(
  id: string,
  env: Env,
): Promise<Response> {
  await env.DB.prepare(
    "UPDATE webhooks SET active = 0 WHERE id = ?",
  )
    .bind(id)
    .run();
  return new Response(null, { status: 204 });
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

function clampInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = parseInt(raw ?? "", 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
