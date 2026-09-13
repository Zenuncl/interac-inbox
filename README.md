# Interac Inbox

Cloudflare Worker that receives Interac e-Transfer notification emails via Email Routing, parses them, stores transactions in D1, and dispatches webhooks for downstream processing.

## Architecture

```
┌──────────────────┐    ┌─────────────────────┐    ┌──────────┐
│  Interac Email   │───▶│  Cloudflare Email    │───▶│  Worker  │
│  (payments.      │    │  Routing             │    │  email() │
│   interac.ca)    │    │                      │    │          │
└──────────────────┘    └─────────────────────┘    └────┬─────┘
                                                        │
                        ┌───────────────────────────────┤
                        ▼                               ▼
                  ┌──────────┐                   ┌──────────────┐
                  │  D1 DB   │                   │  Webhooks    │
                  │  (txns)  │                   │  (HMAC-signed│
                  └──────────┘                   │   POST)      │
                        ▲                        └──────────────┘
                        │
                  ┌──────────┐
                  │ REST API │◀── Your backend
                  │ fetch()  │
                  └──────────┘
```

## Setup

### 1. Clone and install

```bash
git clone <repo-url> && cd interac-inbox
npm install
```

### 2. Create D1 database

```bash
npx wrangler d1 create interac_inbox
```

Copy the `database_id` from the output into `wrangler.toml`.

### 3. Run migration

```bash
npx wrangler d1 migrations apply interac_inbox
```

### 4. Set secrets

```bash
npx wrangler secret put API_KEY
npx wrangler secret put WEBHOOK_SIGNING_KEY
```

### 5. Deploy

```bash
npx wrangler deploy
```

### 6. Configure Email Routing

In the Cloudflare dashboard under **Email Routing**, add your receiving email address (e.g. `payments@yourdomain.com`) and route it to this Worker.

## API Reference

All endpoints require `Authorization: Bearer <API_KEY>`.

### List transactions

```bash
curl -H "Authorization: Bearer $API_KEY" \
  "https://interac-inbox.<account>.workers.dev/api/transactions?status=unmatched&limit=50"
```

Query params: `reference`, `status`, `from_date`, `to_date`, `limit` (max 200), `offset`.

### Get transaction

```bash
curl -H "Authorization: Bearer $API_KEY" \
  "https://interac-inbox.<account>.workers.dev/api/transactions/<id>"
```

### Match transaction to order

```bash
curl -X POST -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"order_id": "ORD-123"}' \
  "https://interac-inbox.<account>.workers.dev/api/transactions/<id>/match"
```

### List webhooks

```bash
curl -H "Authorization: Bearer $API_KEY" \
  "https://interac-inbox.<account>.workers.dev/api/webhooks"
```

### Register webhook

```bash
curl -X POST -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-backend.com/webhook", "description": "Production"}' \
  "https://interac-inbox.<account>.workers.dev/api/webhooks"
```

### Delete webhook

```bash
curl -X DELETE -H "Authorization: Bearer $API_KEY" \
  "https://interac-inbox.<account>.workers.dev/api/webhooks/<id>"
```

## Webhook Verification

Each webhook POST includes an `X-Signature` header containing an HMAC-SHA256 hex digest of the request body, signed with your `WEBHOOK_SIGNING_KEY`.

To verify in your receiving system:

```python
import hmac, hashlib

def verify_signature(body: bytes, signature: str, secret: str) -> bool:
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
```

```javascript
async function verifySignature(body, signature, secret) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, "0")).join("");
  return expected === signature;
}
```

## Security Notes

- **SPF + DKIM validation**: Emails failing either check are stored with `status=flagged` and `sender_verified=0`. Never auto-process flagged transactions.
- **Domain allowlist**: Only emails from `payments.interac.ca`, `interac.ca`, and `notifications.interac.ca` pass verification. Adjust `INTERAC_DOMAIN_ALLOWLIST` if Interac adds new sending domains.
- **Security-question emails**: Emails without auto-deposit language are stored as `pending_deposit`. These require the recipient to manually accept the transfer — do not fulfill orders based on these.
- **Idempotency**: Duplicate emails (same message ID + reference + amount) are silently dropped.
- **Amount handling**: All amounts stored as integer cents to avoid floating-point precision issues.
- **API authentication**: All API endpoints require a Bearer token. Rotate `API_KEY` periodically.

## Field Reference

| Field | Type | Description |
|---|---|---|
| `messageId` | string | Email Message-ID header |
| `fromName` | string \| null | Sender's display name parsed from body |
| `toEmail` | string \| null | Recipient email address |
| `replyToEmail` | string \| null | Reply-To address (sender's real email) |
| `amountCents` | number | Transfer amount in cents (e.g. 15000 = $150.00) |
| `currency` | string | Always "CAD" |
| `reference` | string \| null | Interac reference number (e.g. ETR-2024-XK9P2L) |
| `isAutoDeposit` | boolean | true if auto-deposited, false if security question pending |
| `userMessage` | string \| null | Optional message from sender |
| `language` | "en" \| "fr" \| null | Detected email language |
| `subject` | string \| null | Email subject line |
| `bodyRaw` | string \| null | Plain text email body |
| `senderVerified` | boolean | true if SPF+DKIM passed and domain is allowlisted |
| `status` | string | unmatched \| matched \| pending_deposit \| flagged |
| `order_id` | string \| null | Linked order ID (set via match endpoint) |
