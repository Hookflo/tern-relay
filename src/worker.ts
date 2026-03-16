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

// ── Worker entrypoint ────────────────────────────────────────────────────────
//
// Two URL patterns:
//
// 1. CLI connects (WebSocket upgrade):
//    GET wss://tern-relay.hookflo-tern.workers.dev/connect
//    → creates session, returns { url, sessionId }
//
// 2. Platform sends webhook:
//    POST https://tern-relay.hookflo-tern.workers.dev/s/<sessionId>/webhook
//    → pipes to CLI over open WebSocket
//
// No subdomain routing needed — everything is path-based.

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const isWsUpgrade =
      request.headers.get("upgrade")?.toLowerCase() === "websocket";

    // ── /connect — CLI WebSocket upgrade
    if (url.pathname === "/connect" && isWsUpgrade) {
      const sessionId = generateSessionId();
      const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
      return stub.fetch(
        new Request(`https://session/connect?sessionId=${sessionId}`, request),
      );
    }

    // ── /s/<sessionId>/<...path> — incoming webhook from platform
    const match = url.pathname.match(/^\/s\/([a-z0-9]+)(\/.*)?$/);
    if (match) {
      const sessionId = match[1];
      const webhookPath = match[2] || "/";
      const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
      return stub.fetch(
        new Request(`https://session/forward${webhookPath}`, request),
      );
    }

    // ── health check
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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

    // ── /connect — CLI establishing tunnel
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

      this.ctx.acceptWebSocket(server);
      this.cliSocket = server;

      // Build public URL using path-based routing
      // Works on both workers.dev and custom domain
      const host =
        request.headers.get("x-forwarded-host") ??
        request.headers.get("host") ??
        "tern-relay.hookflo-tern.workers.dev";

      // Strip the /connect path to get the base URL
      const baseUrl = `https://${host}`;
      const publicUrl = `${baseUrl}/s/${sessionId}`;

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
        return new Response(
          JSON.stringify({ error: "No CLI connected. Start tern-dev first." }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      // Raw body — no parsing, no inspection
      const body = await request.text();

      // Serialise headers — strip CF internal headers
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        if (!key.startsWith("cf-") && key !== "host") {
          headers[key] = value;
        }
      });

      const webhookPath = url.pathname.replace("/forward", "") || "/";

      const msg: RelayRequest = {
        type: "request",
        id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        method: request.method,
        path: webhookPath,
        headers,
        body,
        receivedAt: new Date().toISOString(),
      };

      // Fire and forget — return 200 immediately
      try {
        this.cliSocket.send(JSON.stringify(msg));
      } catch {
        // CLI disconnected mid-send — not an error
      }

      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  }

  // ── WebSocket hibernation handlers

  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer) {
    // CLI can send pings — ignore
  }

  webSocketClose(_ws: WebSocket, _code: number, _reason: string) {
    this.cliSocket = null;
  }

  webSocketError(_ws: WebSocket, _error: unknown) {
    this.cliSocket = null;
  }
}
