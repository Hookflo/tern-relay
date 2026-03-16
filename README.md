# tern-relay

WebSocket relay server for [@hookflo/tern-dev](https://github.com/hookflo/tern-dev).

Runs on Cloudflare Workers. ~60 lines. MIT licensed. Self-hostable.

---

## What it does

- Accepts a WebSocket connection from the `tern-dev` CLI
- Assigns a public URL: `https://abc12345.relay.tern.dev`
- When a platform (Stripe, GitHub, Clerk…) POSTs a webhook to that URL, pipes the raw request to the CLI over the open WebSocket
- Returns `200 OK` to the platform immediately
- When the CLI disconnects, the session is gone — nothing persists

## What it does NOT do

- **Store anything** — no KV, no R2, no D1, no Logpush for request bodies
- **Log payloads** — raw bytes are piped, not inspected or recorded
- **Require auth** — the session URL is the access control
- **Hold state** — when your terminal closes, the session is over

Your webhook payloads never leave the WSS connection. The relay is a dumb pipe.

---

## Self-host in 3 steps

```bash
# 1. Clone
git clone https://github.com/hookflo/tern-relay
cd tern-relay && npm install

# 2. Add secrets to GitHub repo:
#    CLOUDFLARE_API_TOKEN
#    CLOUDFLARE_ACCOUNT_ID

# 3. Deploy
npx wrangler deploy
```

Then point tern-dev at your relay:

```bash
RELAY_URL=wss://your-worker.your-account.workers.dev \
  npx @hookflo/tern-dev --port 3000
```

## Local dev

```bash
npm run dev
# Worker runs at http://localhost:8787

# In another terminal:
RELAY_URL=ws://localhost:8787 npx @hookflo/tern-dev --port 3000
```

## DNS setup (for custom subdomain)

In your Cloudflare dashboard:

1. Add a Worker route: `relay.tern.dev/*` → this Worker
2. Add a wildcard route: `*.relay.tern.dev/*` → this Worker

Both routes are required — the root domain is where the CLI connects, the wildcard is where platforms send webhooks.

---

## Architecture

```
tern-dev CLI                    tern-relay (CF Worker)           Stripe / GitHub
────────────────────────────────────────────────────────────────────────────────
npx tern-dev --port 3000
  └─ WSS ──────────────────►  relay.tern.dev
                               └─ SessionDurableObject
                               └─ sends: { url: "https://abc12345.relay.tern.dev" }
                                                                 paste URL in dashboard
                               ◄─ POST /webhook ────────────────
  ◄─ pipes raw request ───────
  └─ forwards to localhost:3000
```

---

## Cost

Cloudflare Workers free tier: 100,000 requests/day. Developer tool sessions are short-lived. Realistic cost: **$0/month** for typical adoption.

---

MIT License — [Hookflo](https://hookflo.com)
