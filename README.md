# tern-relay

WebSocket relay for [@hookflo/tern-dev](https://github.com/hookflo/tern-dev).

Dumb pipe. Stores nothing. Logs nothing. 80 lines. MIT. 

---

## How it works

```
tern-dev CLI ──WSS──► relay.workers.dev/connect
                            │ assigns session ID: abc12345
                            │ returns: https://relay.workers.dev/s/abc12345
                            │
Stripe ──POST──► relay.workers.dev/s/abc12345/webhook
                            │ pipes raw bytes over open WebSocket
                            ▼
                       tern-dev CLI ──► localhost:3000
```

- CLI connects via WebSocket to `/connect` → receives a public session URL
- Platforms (Stripe, GitHub, etc.) POST to `/s/<sessionId>/your-path`
- Relay pipes the raw request bytes over the open WebSocket to the CLI
- Returns `{"received":true}` to the platform immediately
- When CLI disconnects, session is gone — nothing persists anywhere

---

## What it does NOT do

- Store request bodies, headers, or any payload data
- Log request content (only session connect/disconnect events are logged)
- Require accounts, API keys, or authentication
- Hold state after CLI disconnects

---

## Using the hosted version

If you use `npx @hookflo/tern-dev`, it connects to Hookflo's hosted relay automatically.
You don't need to deploy anything.

---

## Self-hosting (full data isolation)

If you want zero data touching Hookflo infrastructure, deploy your own relay.

**Prerequisites:**
- A Cloudflare account (free tier is enough)
- Node.js 18+

**Step 1 — Fork and clone**
```bash
git clone https://github.com/hookflo/tern-relay
cd tern-relay
npm install
```

**Step 2 — Get Cloudflare credentials**

You need two values from Cloudflare:

*Account ID:*
1. Go to [dash.cloudflare.com](https://dash.cloudflare.com)
2. Click **Workers & Pages** in the left nav
3. Your Account ID is shown in the right sidebar (32-character hex string)

*API Token:*
1. Click your avatar (top right) → **My Profile**
2. Click **API Tokens** → **Create Token**
3. Use the **"Edit Cloudflare Workers"** template
4. Click **Continue to summary** → **Create Token**
5. Copy the token — it is shown only once

**Step 3 — Add secrets to GitHub**
1. Go to your forked repo on GitHub
2. **Settings → Secrets and variables → Actions → New repository secret**
3. Add secret: `CLOUDFLARE_API_TOKEN` (paste the token from step 2)
4. Add secret: `CLOUDFLARE_ACCOUNT_ID` (paste the account ID from step 2)

**Step 4 — Deploy**
```bash
git push origin main
# GitHub Actions runs wrangler deploy automatically
# Check the Actions tab — takes ~30 seconds
```

**Step 5 — Get your worker URL**
After deploy, go to:
`Cloudflare dashboard → Workers & Pages → tern-relay`

Your URL is: `https://tern-relay.<your-subdomain>.workers.dev`

**Step 5.1 — Set a single default relay base URL (recommended)**

Set one variable in `wrangler.toml` so you do not need to edit URLs in multiple places:

```toml
[vars]
RELAY_PUBLIC_BASE_URL = "https://tern-relay.<your-subdomain>.workers.dev"
```

This value is used in `/connect` responses as the public relay URL base.

**Step 6 — Point tern-dev at your relay**
```bash
# Basic usage — forwards everything to localhost:3000
RELAY_URL=wss://tern-relay.<your-subdomain>.workers.dev \
  npx @hookflo/tern-dev --port 3000

# Forward to a specific path (e.g. your app uses /api/webhooks)
RELAY_URL=wss://tern-relay.<your-subdomain>.workers.dev \
  npx @hookflo/tern-dev --port 3000 --path /api/webhooks

# Or set RELAY_URL permanently in your shell profile:
export RELAY_URL=wss://tern-relay.<your-subdomain>.workers.dev
npx @hookflo/tern-dev --port 3000
```

---

## Local development

To run the relay locally for development:
```bash
npm run dev
# Wrangler starts a local server at http://localhost:8787
```

In a separate terminal:
```bash
RELAY_URL=ws://localhost:8787 npx @hookflo/tern-dev --port 3000
```

Note: local dev uses `ws://` not `wss://` — no TLS on localhost.

---

## Testing your deployment

After deploying, run these checks in order:

```bash
# 1. Health check — worker is alive
curl https://tern-relay.<your-subdomain>.workers.dev/health
# Expected: {"ok":true,"sessions":0,"ts":"..."}

# 2. WebSocket connects and returns session URL
npx wscat -c wss://tern-relay.<your-subdomain>.workers.dev/connect
# Expected: {"type":"connected","url":"https://tern-relay...workers.dev/s/abc12345","sessionId":"abc12345"}

# 3. Webhook forwarded (run step 2 first, use the sessionId from the response)
curl -X POST https://tern-relay.<your-subdomain>.workers.dev/s/abc12345/webhook \
  -H "content-type: application/json" \
  -d '{"test": true}'
# Expected: {"received":true}
# wscat terminal should receive the RelayRequestMsg immediately

# 4. Hibernation test — wait 90 seconds, then re-run step 3
# Expected: same result — wscat still receives the message
# This confirms sessions survive Cloudflare DO eviction
```

---

## Forwarding to specific paths

By default, tern-dev forwards all webhooks to `localhost:<port>/`.

To forward to a specific path, use `--path`:

```bash
# Your webhook handler is at localhost:3000/webhooks/stripe
npx @hookflo/tern-dev --port 3000 --path /webhooks/stripe

# Give Stripe this URL:
# https://tern-relay.workers.dev/s/<sessionId>/webhooks/stripe
# OR simply tell Stripe to POST to your tunnel URL with the path included
```

The path in the tunnel URL is preserved end-to-end:
```
Stripe POST → /s/abc123/webhooks/stripe
Relay → CLI: path = "/webhooks/stripe"
CLI forwards → localhost:3000/webhooks/stripe
```

## tern-dev CLI flags (quick reference)

When you publish your own relay, point `tern-dev` to it with `--relay`.

| Flag | Type | Default | Description |
|---|---|---|---|
| `--relay` | string | `wss://tern-relay.hookflo-tern.workers.dev` | Relay websocket URL |
| `--port` | number | `3000` | Local server port to forward to |
| `--path` | string | `/` | Local webhook path to forward to |

---

## Configuration reference

All configurable values are in the `CONFIG` object at the top of `src/worker.ts`.
You never need to search the code for magic values — they are all in one place.

| Config key | Default | Description |
|---|---|---|
| `SESSION_ID_LENGTH` | `8` | Characters in session ID (~2.8T combinations) |
| `SESSION_ID_CHARSET` | `a-z0-9` | Characters used in session ID |
| `MAX_BODY_BYTES` | `1_000_000` | Max webhook payload size (1MB) |
| `FALLBACK_BASE_URL` | your workers.dev URL | Used if host cannot be determined |
| `CORS_ORIGIN` | `*` | CORS allowed origins |
| `DO_INSTANCE_NAME` | `global` | Durable Object instance name |
| `ROUTES.CONNECT` | `/connect` | CLI WebSocket endpoint |
| `ROUTES.HEALTH` | `/health` | Health check endpoint |

---

## Cost

Cloudflare Workers free tier: 100,000 requests/day, no charge for WebSocket duration.

A typical tern-dev session (developer testing webhooks for an hour):
- ~1 WebSocket connection
- ~50-200 webhook events
- Total: ~200 requests

Free tier supports ~500 simultaneous active developers before any cost.
Paid tier ($5/month) is 10 million requests/month — more than enough for serious usage.

---

## Privacy & security

- The relay is a dumb pipe — it never parses, stores, or logs webhook bodies
- Session IDs are cryptographically random (Web Crypto API)
- Sessions exist only while the CLI WebSocket is open — no persistence
- Request IDs are generated with cryptographic randomness
- Webhook forwarding strips infrastructure headers before relaying
- Session IDs are validated server-side before any forwarding
- The relay source is fully auditable at ~80 lines
- Self-hosting is supported for zero-trust environments

---

## License

MIT — [Hookflo](https://hookflo.com)
