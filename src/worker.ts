import { DurableObject } from "cloudflare:workers";

// ── Types ────────────────────────────────────────────────────────────────────

interface Env {
  SESSIONS: DurableObjectNamespace;
}

interface RelayConnected {
  type: "connected";
  url: string;
  sessionId: string;
}

interface RelayRequest {
  type: "request";
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  receivedAt: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const CHARSET = "abcdefghijklmnopqrstuvwxyz0123456789";

function generateSessionId(length = 8): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CHARSET[b % CHARSET.length]).join("");
}

function extractSessionId(host: string): string | null {
  // abc12345.relay.tern.dev → abc12345
  const match = host.match(/^([a-z0-9]+)\./);
  return match ? match[1] : null;
}

// ── Worker entrypoint ────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const host = request.headers.get("host") ?? "";

    // ── WebSocket upgrade from tern-dev CLI
    // CLI connects to wss://relay.tern.dev (no subdomain)
    // or wss://relay.tern.dev/connect
    const isRelayRoot =
      host === "relay.tern.dev" ||
      host.startsWith("localhost") ||
      host.endsWith("workers.dev");
    const isWsUpgrade =
      request.headers.get("upgrade")?.toLowerCase() === "websocket";

    if (isWsUpgrade && isRelayRoot) {
      const sessionId = generateSessionId();
      const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
      return stub.fetch(
        new Request(`https://session/connect?sessionId=${sessionId}`, request),
      );
    }

    // ── Incoming HTTP POST from platform (Stripe, GitHub etc.)
    // Arrives at: https://abc12345.relay.tern.dev/any/path
    const sessionId = extractSessionId(host);

    if (sessionId) {
      const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
      // Forward to the DO — it will pipe to CLI and return immediately
      return stub.fetch(
        new Request(
          `https://session/forward${url.pathname}${url.search}`,
          request,
        ),
      );
    }

    return new Response("Not found", { status: 404 });
  },
};

// ── SessionDurableObject ─────────────────────────────────────────────────────
// One instance per active CLI session.
// Holds exactly one WebSocket (the CLI connection).
// No storage. No logging. Pure pipe.

export class SessionDurableObject extends DurableObject {
  private cliSocket: WebSocket | null = null;
  private sessionId: string = "";

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // ── /connect — CLI is establishing the tunnel
    if (url.pathname === "/connect") {
      const sessionId =
        url.searchParams.get("sessionId") ?? generateSessionId();
      this.sessionId = sessionId;

      const isWsUpgrade =
        request.headers.get("upgrade")?.toLowerCase() === "websocket";
      if (!isWsUpgrade) {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }

      const [client, server] = Object.values(new WebSocketPair()) as [
        WebSocket,
        WebSocket,
      ];

      // Use hibernation API — zero idle cost when CLI is waiting
      this.ctx.acceptWebSocket(server);
      this.cliSocket = server;

      // Tell CLI its public URL
      const host = request.headers.get("host") ?? "relay.tern.dev";
      const baseHost = host.replace(/^[^.]+\./, ""); // strips any subdomain
      const publicUrl = `https://${sessionId}.${baseHost}`;
      const msg: RelayConnected = {
        type: "connected",
        url: publicUrl,
        sessionId,
      };
      server.send(JSON.stringify(msg));

      return new Response(null, { status: 101, webSocket: client });
    }

    // ── /forward/* — incoming webhook from platform
    if (url.pathname.startsWith("/forward")) {
      if (!this.cliSocket) {
        return new Response("No CLI connected", { status: 404 });
      }

      // Read raw body — no parsing, no inspection
      const body = await request.text();

      // Serialise headers — filter out CF internal headers
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        if (!key.startsWith("cf-") && key !== "host") {
          headers[key] = value;
        }
      });

      const msg: RelayRequest = {
        type: "request",
        id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        method: request.method,
        path: url.pathname.replace("/forward", "") || "/",
        headers,
        body,
        receivedAt: new Date().toISOString(),
      };

      // Fire and forget — do not wait for CLI to process
      try {
        this.cliSocket.send(JSON.stringify(msg));
      } catch {
        // CLI disconnected between check and send — not an error
      }

      // Always return 200 to the platform immediately
      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  }

  // ── WebSocket hibernation handlers
  // Called by CF runtime when a hibernated WebSocket receives a message

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // CLI can send { type: "ping" } to keep connection alive — ignore everything else
    // We never need to process CLI messages in the relay
  }

  webSocketClose(ws: WebSocket, code: number, reason: string) {
    this.cliSocket = null;
    // DO idles — no cleanup needed
  }

  webSocketError(ws: WebSocket, error: unknown) {
    this.cliSocket = null;
  }
}
