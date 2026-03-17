import { DurableObject } from 'cloudflare:workers'

const CONFIG = {
  SESSION_ID_LENGTH: 8,
  SESSION_ID_CHARSET: 'abcdefghijklmnopqrstuvwxyz0123456789',
  ROUTES: {
    CONNECT: "/connect",
    SESSION: /^\/s\/([a-z0-9]+)(\/.*)?$/,
    HEALTH: "/health",
  },
  MAX_BODY_BYTES: 1_000_000,
  FALLBACK_BASE_URL: 'https://tern-relay.hookflo-tern.workers.dev',
  CORS_ORIGIN: '*',
  CORS_METHODS: 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  CORS_HEADERS: '*',
  PLATFORM_ACK: {
    status: 200,
    body: JSON.stringify({ received: true }),
  },
  DO_INSTANCE_NAME: 'global',
  STRIP_HEADER_PREFIXES: ['cf-'],
  STRIP_HEADERS_EXACT: ['host', 'connection', 'keep-alive'],
  INTERNAL_ROUTES: {
    CONNECT: "/connect",
    FORWARD: "/forward",
    HEALTH: "/health",
  },
  RESPONSES: {
    NOT_FOUND: 'Not found',
    BAD_REQUEST: 'Bad request',
    EXPECTED_WEBSOCKET: 'Expected WebSocket upgrade',
    NO_SESSION: 'No CLI connected. Start tern-dev first.',
    PAYLOAD_TOO_LARGE: 'Payload too large',
    INTERNAL_HOST: 'do-internal',
    CONTENT_TYPE_JSON: 'application/json',
  },
  REQUEST_ID: {
    PREFIX: 'req_',
    RANDOM_SLICE_START: 2,
    RANDOM_SLICE_END: 7,
    RADIX: 36,
  },
  STATUS: {
    SWITCHING_PROTOCOLS: 101,
    NO_CONTENT: 204,
    OK: 200,
    BAD_REQUEST: 400,
    NOT_FOUND: 404,
    PAYLOAD_TOO_LARGE: 413,
    UPGRADE_REQUIRED: 426,
  },
} as const

interface Env {
  SESSIONS: DurableObjectNamespace<SessionDurableObject>
}

interface RelayConnectedMsg {
  type: 'connected'
  url: string
  sessionId: string
}

interface RelayRequestMsg {
  type: 'request'
  id: string
  method: string
  path: string
  headers: Record<string, string>
  body: string
  receivedAt: string
}


function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': CONFIG.CORS_ORIGIN,
    'access-control-allow-methods': CONFIG.CORS_METHODS,
    'access-control-allow-headers': CONFIG.CORS_HEADERS,
  }
}

function jsonHeaders(): Record<string, string> {
  return {
    'content-type': CONFIG.RESPONSES.CONTENT_TYPE_JSON,
    ...corsHeaders(),
  }
}

function generateSessionId(): string {
  const bytes = new Uint8Array(CONFIG.SESSION_ID_LENGTH)
  crypto.getRandomValues(bytes)
  return Array.from(
    bytes,
    (byte) =>
      CONFIG.SESSION_ID_CHARSET[byte % CONFIG.SESSION_ID_CHARSET.length],
  ).join('')
}

function generateRequestId(): string {
  const ts = Date.now().toString(CONFIG.REQUEST_ID.RADIX)
  const rand = Math.random()
    .toString(CONFIG.REQUEST_ID.RADIX)
    .slice(
      CONFIG.REQUEST_ID.RANDOM_SLICE_START,
      CONFIG.REQUEST_ID.RANDOM_SLICE_END,
    )
  return `${CONFIG.REQUEST_ID.PREFIX}${ts}_${rand}`
}

function sanitiseHeaders(request: Request): Record<string, string> {
  const exactHeaders: Set<string> = new Set(CONFIG.STRIP_HEADERS_EXACT)
  const out: Record<string, string> = {}

  request.headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (exactHeaders.has(lower)) return
    if (
      CONFIG.STRIP_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
    ) {
      return
    }
    out[lower] = value
  })

  return out
}

function bodyExceedsDeclaredLimit(request: Request): boolean {
  const contentLength = request.headers.get('content-length')
  if (!contentLength) return false

  const parsed = Number.parseInt(contentLength, 10)
  if (Number.isNaN(parsed)) return false

  return parsed > CONFIG.MAX_BODY_BYTES
}

function resolvePublicBase(request: Request): string {
  const url = new URL(request.url)
  if (url.host) {
    return `https://${url.host}`
  }
  return CONFIG.FALLBACK_BASE_URL
}

function platformAckResponse(): Response {
  return new Response(CONFIG.PLATFORM_ACK.body, {
    status: CONFIG.PLATFORM_ACK.status,
    headers: jsonHeaders(),
  })
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: corsHeaders(),
  })
}

function jsonResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: jsonHeaders(),
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: CONFIG.STATUS.NO_CONTENT,
        headers: corsHeaders(),
      })
    }

    const url = new URL(request.url)
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(CONFIG.DO_INSTANCE_NAME))
    const isWsUpgrade =
      request.headers.get('upgrade')?.toLowerCase() === 'websocket'

    if (request.method === 'GET' && url.pathname === CONFIG.ROUTES.HEALTH) {
      return stub.fetch(
        new Request(
          `https://${CONFIG.RESPONSES.INTERNAL_HOST}${CONFIG.INTERNAL_ROUTES.HEALTH}`,
          request,
        ),
      )
    }

    if (
      request.method === 'GET' &&
      url.pathname === CONFIG.ROUTES.CONNECT &&
      isWsUpgrade
    ) {
      const sessionId = generateSessionId()
      const base = resolvePublicBase(request)
      const connectUrl = new URL(
        `https://${CONFIG.RESPONSES.INTERNAL_HOST}${CONFIG.INTERNAL_ROUTES.CONNECT}`,
      )
      connectUrl.searchParams.set('sessionId', sessionId)
      connectUrl.searchParams.set('base', base)
      return stub.fetch(new Request(connectUrl.toString(), request))
    }

    const sessionMatch = url.pathname.match(CONFIG.ROUTES.SESSION)
    if (sessionMatch) {
      const sessionId = sessionMatch[1]
      const webhookPath = sessionMatch[2] ?? '/'
      const forwardUrl = new URL(
        `https://${CONFIG.RESPONSES.INTERNAL_HOST}${CONFIG.INTERNAL_ROUTES.FORWARD}`,
      )
      forwardUrl.searchParams.set('sessionId', sessionId)
      forwardUrl.searchParams.set('path', webhookPath)
      return stub.fetch(new Request(forwardUrl.toString(), request))
    }

    return textResponse(CONFIG.RESPONSES.NOT_FOUND, CONFIG.STATUS.NOT_FOUND)
  },
}

export class SessionDurableObject extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === CONFIG.INTERNAL_ROUTES.CONNECT) {
      const sessionId = url.searchParams.get('sessionId')
      const publicBase = url.searchParams.get('base')

      if (!sessionId || !publicBase) {
        return textResponse(
          CONFIG.RESPONSES.BAD_REQUEST,
          CONFIG.STATUS.BAD_REQUEST,
        )
      }

      return this.handleConnect(request, sessionId, publicBase)
    }

    if (url.pathname === CONFIG.INTERNAL_ROUTES.FORWARD) {
      const sessionId = url.searchParams.get('sessionId')
      const webhookPath = url.searchParams.get('path')

      if (!sessionId || !webhookPath) {
        return textResponse(
          CONFIG.RESPONSES.BAD_REQUEST,
          CONFIG.STATUS.BAD_REQUEST,
        )
      }

      return this.handleForward(request, sessionId, webhookPath)
    }

    if (url.pathname === CONFIG.INTERNAL_ROUTES.HEALTH) {
      return this.handleHealth()
    }

    return textResponse(CONFIG.RESPONSES.NOT_FOUND, CONFIG.STATUS.NOT_FOUND)
  }

  async handleConnect(
    request: Request,
    sessionId: string,
    publicBase: string,
  ): Promise<Response> {
    const isWsUpgrade =
      request.headers.get('upgrade')?.toLowerCase() === 'websocket'

    if (!isWsUpgrade) {
      return textResponse(
        CONFIG.RESPONSES.EXPECTED_WEBSOCKET,
        CONFIG.STATUS.UPGRADE_REQUIRED,
      )
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    this.ctx.acceptWebSocket(server, [sessionId])

    const msg: RelayConnectedMsg = {
      type: 'connected',
      url: `${publicBase}/s/${sessionId}`,
      sessionId,
    }
    server.send(JSON.stringify(msg))

    console.log(`[relay] session connected: ${sessionId}`)

    return new Response(null, {
      status: CONFIG.STATUS.SWITCHING_PROTOCOLS,
      webSocket: client,
      headers: corsHeaders(),
    })
  }

  async handleForward(
    request: Request,
    sessionId: string,
    webhookPath: string,
  ): Promise<Response> {
    if (bodyExceedsDeclaredLimit(request)) {
      return textResponse(
        CONFIG.RESPONSES.PAYLOAD_TOO_LARGE,
        CONFIG.STATUS.PAYLOAD_TOO_LARGE,
      )
    }

    const sockets = this.ctx.getWebSockets(sessionId)
    const socket = sockets[0]

    if (!socket) {
      return jsonResponse(
        JSON.stringify({ error: CONFIG.RESPONSES.NO_SESSION }),
        CONFIG.STATUS.NOT_FOUND,
      )
    }

    const body = await request.text()
    if (body.length > CONFIG.MAX_BODY_BYTES) {
      return textResponse(
        CONFIG.RESPONSES.PAYLOAD_TOO_LARGE,
        CONFIG.STATUS.PAYLOAD_TOO_LARGE,
      )
    }

    const msg: RelayRequestMsg = {
      type: 'request',
      id: generateRequestId(),
      method: request.method,
      path: webhookPath,
      headers: sanitiseHeaders(request),
      body,
      receivedAt: new Date().toISOString(),
    }

    try {
      socket.send(JSON.stringify(msg))
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error(`[relay] error:`, error.message)
      } else {
        console.error(`[relay] error:`, String(error))
      }
      return platformAckResponse()
    }

    console.log(`[relay] forwarded ${request.method} ${webhookPath} → ${sessionId}`)
    return platformAckResponse()
  }

  async handleHealth(): Promise<Response> {
    const activeSessions = this.ctx.getWebSockets().length
    return jsonResponse(
      JSON.stringify({
        ok: true,
        sessions: activeSessions,
        ts: new Date().toISOString(),
      }),
      CONFIG.STATUS.OK,
    )
  }

  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {}

  webSocketClose(ws: WebSocket, code: number, _reason: string): void {
    const tag = this.ctx.getTags(ws)[0] ?? 'unknown'
    console.log(`[relay] session disconnected: ${tag} (code=${code})`)
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    const tag = this.ctx.getTags(ws)[0] ?? 'unknown'
    console.error(
      `[relay] websocket error for session ${tag}:`,
      error instanceof Error ? error.message : String(error),
    )
  }
}
