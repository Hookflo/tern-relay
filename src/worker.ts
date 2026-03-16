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
// ALL requests route to a SINGLE Durable Object instance called "global".
// That one instance holds ALL active WebSocket sessions in a Map.
// This guarantees the same instance handles both WS connect and HTTP POST.

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const isWsUpgrade =
      request.headers.get("upgrade")?.toLowerCase() === "websocket";

    // Always route to the single global DO instance
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName("global"));

    // /connect — CLI WebSocket upgrade
    if (url.pathname === "/connect" && isWsUpgrade) {
      const sessionId = generateSessionId();
      return stub.fetch(
        new Request(`https://session/connect?sessionId=${sessionId}`, request),
      );
    }

    // /s/<sessionId>/<...path> — incoming webhook from platform
    const match = url.pathname.match(/^\/s\/([a-z0-9]+)(\/.*)?$/);
    if (match) {
      const sessionId = match[1];
      const webhookPath = match[2] || "/";
      return stub.fetch(
        new Request(
          `https://session/forward/${sessionId}${webhookPath}`,
          request,
        ),
      );
    }

    // /health
    if (url.pathname === "/health") {
      return stub.fetch(new Request("https://session/health", request));
    }

    return new Response("Not found", { status: 404 });
  },
};

// ── SessionDurableObject ─────────────────────────────────────────────────────
// Single global instance — holds ALL active sessions in one Map.

export class SessionDurableObject extends DurableObject {
  private sessions: Map<string, WebSocket> = new Map();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const isWsUpgrade =
      request.headers.get("upgrade")?.toLowerCase() === "websocket";

    // /connect — CLI establishing tunnel
    if (url.pathname === "/connect") {
      const sessionId = url.searchParams.get("sessionId")!;

      if (!isWsUpgrade) {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }

      const [client, server] = Object.values(new WebSocketPair()) as [
        WebSocket,
        WebSocket,
      ];

      this.ctx.acceptWebSocket(server, [sessionId]);
      this.sessions.set(sessionId, server);

      const host =
        request.headers.get("x-forwarded-host") ??
        request.headers.get("host") ??
        "tern-relay.hookflo-tern.workers.dev";

      const baseUrl = `https://${host.replace(":8787", "")}`;
      const publicUrl = `${baseUrl}/s/${sessionId}`;

      const msg: RelayConnected = {
        type: "connected",
        url: publicUrl,
        sessionId,
      };
      server.send(JSON.stringify(msg));

      return new Response(null, { status: 101, webSocket: client });
    }

    // /forward/<sessionId>/<...path> — incoming webhook
    if (url.pathname.startsWith("/forward/")) {
      const forwardMatch = url.pathname.match(
        /^\/forward\/([a-z0-9]+)(\/.*)?$/,
      );
      if (!forwardMatch) {
        return new Response("Bad request", { status: 400 });
      }

      const sessionId = forwardMatch[1];
      const webhookPath = forwardMatch[2] || "/";

      // Try in-memory map first
      let socket = this.sessions.get(sessionId);

      // Fall back to hibernation websockets
      if (!socket) {
        const hibernated = this.ctx.getWebSockets(sessionId);
        if (hibernated.length > 0) {
          socket = hibernated[0];
          this.sessions.set(sessionId, socket);
        }
      }

      if (!socket) {
        return new Response(
          JSON.stringify({ error: "No CLI connected. Start tern-dev first." }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      const body = await request.text();

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
        path: webhookPath,
        headers,
        body,
        receivedAt: new Date().toISOString(),
      };

      try {
        socket.send(JSON.stringify(msg));
      } catch {
        this.sessions.delete(sessionId);
        return new Response(
          JSON.stringify({ error: "CLI disconnected. Restart tern-dev." }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // /health
    if (url.pathname === "/health") {
      const hibernated = this.ctx.getWebSockets();
      return new Response(
        JSON.stringify({
          ok: true,
          activeSessions: hibernated.length,
          memSessions: this.sessions.size,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response("Not found", { status: 404 });
  }

  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer) {}

  webSocketClose(_ws: WebSocket, _code: number, _reason: string) {
    for (const [id, socket] of this.sessions.entries()) {
      if (socket === _ws) {
        this.sessions.delete(id);
        break;
      }
    }
  }

  webSocketError(_ws: WebSocket, _error: unknown) {
    for (const [id, socket] of this.sessions.entries()) {
      if (socket === _ws) {
        this.sessions.delete(id);
        break;
      }
    }
  }
}
