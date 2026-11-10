/**
 * OAuth-protected A2A test agent.
 *
 * A self-contained A2A server (protocol v0.3.0) with a built-in, in-memory
 * OAuth 2.0 authorization server. It exists to test OAuth support in A2A
 * clients (such as Langdock) without setting up an external identity provider.
 *
 * The agent itself is a simple echo agent: it replies with the caller's
 * message plus the identity and scopes from the access token, so you can see
 * exactly which token the client sent.
 *
 * Supported:
 * - Authorization Code grant with PKCE (S256/plain) and a consent page
 * - Refresh Token grant (refresh tokens rotate on use)
 * - Client Credentials grant (confidential clients only)
 * - Dynamic Client Registration (RFC 7591)
 * - Authorization Server Metadata (RFC 8414) and
 *   Protected Resource Metadata (RFC 9728)
 * - Token revocation (RFC 7009)
 *
 * TEST ONLY: all state lives in memory and is lost on restart, and the
 * pre-registered client accepts any redirect URI unless OAUTH_REDIRECT_URIS is
 * set. Do not use it to protect anything real.
 */
import express from "express";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import type { AgentCard } from "@a2a-js/sdk";
import {
  AgentExecutor,
  RequestContext,
  ExecutionEventBus,
  DefaultRequestHandler,
  InMemoryTaskStore,
} from "@a2a-js/sdk/server";
import { A2AExpressApp } from "@a2a-js/sdk/server/express";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = Number(process.env.OAUTH_AGENT_PORT ?? 3334);
// Public origin of this server, e.g. https://my-tunnel.example.com
const BASE_URL = (
  process.env.OAUTH_AGENT_URL ?? `http://localhost:${PORT}`
).replace(/\/+$/, "");

// Pre-registered confidential test client. These defaults are dummy values
// for local testing; override them with environment variables.
const STATIC_CLIENT_ID = process.env.OAUTH_CLIENT_ID ?? "langdock-test-client";
const STATIC_CLIENT_SECRET =
  process.env.OAUTH_CLIENT_SECRET ?? "langdock-test-secret";
// Comma-separated allow-list; empty means any redirect URI is accepted.
const STATIC_REDIRECT_URIS = (process.env.OAUTH_REDIRECT_URIS ?? "")
  .split(",")
  .map((uri) => uri.trim())
  .filter(Boolean);

const ACCESS_TOKEN_TTL = Number(process.env.OAUTH_ACCESS_TOKEN_TTL ?? 3600);
const REFRESH_TOKEN_TTL = Number(
  process.env.OAUTH_REFRESH_TOKEN_TTL ?? 30 * 24 * 3600
);
const AUTH_CODE_TTL = 300;

const REQUIRED_SCOPE = "a2a:invoke";
const SUPPORTED_SCOPES: Record<string, string> = {
  [REQUIRED_SCOPE]: "Send messages to the agent",
  offline_access: "Receive a refresh token",
};

const ENDPOINTS = {
  authorize: `${BASE_URL}/oauth/authorize`,
  token: `${BASE_URL}/oauth/token`,
  register: `${BASE_URL}/oauth/register`,
  revoke: `${BASE_URL}/oauth/revoke`,
  asMetadata: `${BASE_URL}/.well-known/oauth-authorization-server`,
  prMetadata: `${BASE_URL}/.well-known/oauth-protected-resource`,
};

// ---------------------------------------------------------------------------
// In-memory OAuth state
// ---------------------------------------------------------------------------

type Client = {
  clientId: string;
  clientSecret?: string; // undefined = public client (PKCE required)
  redirectUris: string[]; // empty = any (static test client only)
  name: string;
};

type AuthCode = {
  clientId: string;
  redirectUri: string;
  scope: string;
  subject: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  expiresAt: number;
};

type TokenInfo = {
  clientId: string;
  subject: string;
  scope: string;
  grantType: string;
  expiresAt: number;
};

const clients = new Map<string, Client>([
  [
    STATIC_CLIENT_ID,
    {
      clientId: STATIC_CLIENT_ID,
      clientSecret: STATIC_CLIENT_SECRET,
      redirectUris: STATIC_REDIRECT_URIS,
      name: "Pre-registered test client",
    },
  ],
]);
const authCodes = new Map<string, AuthCode>();
const accessTokens = new Map<string, TokenInfo>();
const refreshTokens = new Map<string, TokenInfo>();

const now = () => Math.floor(Date.now() / 1000);
const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function normalizeScope(requested: unknown): string | null {
  const scopes =
    typeof requested === "string" && requested.trim()
      ? requested.trim().split(/\s+/)
      : [REQUIRED_SCOPE];
  if (scopes.some((s) => !(s in SUPPORTED_SCOPES))) return null;
  return [...new Set(scopes)].join(" ");
}

function isAllowedRedirect(client: Client, redirectUri: string): boolean {
  if (client.redirectUris.length > 0) {
    return client.redirectUris.includes(redirectUri);
  }
  try {
    const url = new URL(redirectUri);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function issueTokens(
  clientId: string,
  subject: string,
  scope: string,
  grantType: string,
  withRefresh: boolean
) {
  const accessToken = randomToken();
  accessTokens.set(accessToken, {
    clientId,
    subject,
    scope,
    grantType,
    expiresAt: now() + ACCESS_TOKEN_TTL,
  });
  const body: Record<string, unknown> = {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL,
    scope,
  };
  if (withRefresh) {
    const refreshToken = randomToken();
    refreshTokens.set(refreshToken, {
      clientId,
      subject,
      scope,
      grantType,
      expiresAt: now() + REFRESH_TOKEN_TTL,
    });
    body.refresh_token = refreshToken;
  }
  return body;
}

// Removes expired codes and tokens once a minute.
setInterval(() => {
  const t = now();
  for (const store of [authCodes, accessTokens, refreshTokens] as Map<
    string,
    { expiresAt: number }
  >[]) {
    for (const [key, value] of store) if (value.expiresAt <= t) store.delete(key);
  }
}, 60_000).unref();

// ---------------------------------------------------------------------------
// Agent card
// ---------------------------------------------------------------------------

const agentCard: AgentCard = {
  name: "OAuth Test A2A Agent",
  description:
    "Echo agent protected by OAuth 2.0, for testing OAuth support in A2A clients.",
  protocolVersion: "0.3.0",
  version: "0.1.0",
  url: BASE_URL,
  skills: [
    {
      id: "echo",
      name: "Echo",
      description:
        "Echoes your message together with the authenticated user, client and scopes.",
      tags: ["test", "oauth"],
    },
  ],
  capabilities: { pushNotifications: false },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  securitySchemes: {
    oauth2: {
      type: "oauth2",
      description: `OAuth 2.0. Request the "${REQUIRED_SCOPE}" scope.`,
      oauth2MetadataUrl: ENDPOINTS.asMetadata,
      flows: {
        authorizationCode: {
          authorizationUrl: ENDPOINTS.authorize,
          tokenUrl: ENDPOINTS.token,
          refreshUrl: ENDPOINTS.token,
          scopes: SUPPORTED_SCOPES,
        },
        clientCredentials: {
          tokenUrl: ENDPOINTS.token,
          scopes: { [REQUIRED_SCOPE]: SUPPORTED_SCOPES[REQUIRED_SCOPE] },
        },
      },
    },
  },
  security: [{ oauth2: [REQUIRED_SCOPE] }],
};

// ---------------------------------------------------------------------------
// Echo agent
// ---------------------------------------------------------------------------

const authContext = new AsyncLocalStorage<TokenInfo>();

class EchoAgentExecutor implements AgentExecutor {
  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> {
    const { contextId, userMessage } = requestContext;
    const auth = authContext.getStore();
    const textPart = userMessage?.parts?.find((p) => p.kind === "text");
    const userText = textPart && "text" in textPart ? textPart.text : "";

    const text = auth
      ? [
          `OAuth works. You said: "${userText}"`,
          ``,
          `- user: ${auth.subject}`,
          `- client: ${auth.clientId}`,
          `- grant: ${auth.grantType}`,
          `- scopes: ${auth.scope}`,
          `- token expires in: ${auth.expiresAt - now()}s`,
        ].join("\n")
      : "Error: no authenticated user.";

    eventBus.publish({
      kind: "message",
      messageId: uuidv4(),
      role: "agent",
      parts: [{ kind: "text", text }],
      contextId,
    });
    eventBus.finished();
  }

  cancelTask = async (): Promise<void> => {};
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app = express();
app.set("trust proxy", true);

// Logs method, path and status only. Never logs tokens or bodies.
app.use((req, res, next) => {
  res.on("finish", () =>
    console.log(`${req.method} ${req.path} → ${res.statusCode}`)
  );
  next();
});

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!
  );

// --- Metadata ----------------------------------------------------------------

const authorizationServerMetadata = {
  issuer: BASE_URL,
  authorization_endpoint: ENDPOINTS.authorize,
  token_endpoint: ENDPOINTS.token,
  registration_endpoint: ENDPOINTS.register,
  revocation_endpoint: ENDPOINTS.revoke,
  scopes_supported: Object.keys(SUPPORTED_SCOPES),
  response_types_supported: ["code"],
  grant_types_supported: [
    "authorization_code",
    "refresh_token",
    "client_credentials",
  ],
  token_endpoint_auth_methods_supported: [
    "client_secret_basic",
    "client_secret_post",
    "none",
  ],
  revocation_endpoint_auth_methods_supported: [
    "client_secret_basic",
    "client_secret_post",
    "none",
  ],
  code_challenge_methods_supported: ["S256", "plain"],
  authorization_response_iss_parameter_supported: true,
};

app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json(authorizationServerMetadata);
});

app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: BASE_URL,
    authorization_servers: [BASE_URL],
    scopes_supported: Object.keys(SUPPORTED_SCOPES),
    bearer_methods_supported: ["header"],
    resource_name: agentCard.name,
  });
});

// --- Dynamic client registration (RFC 7591) ----------------------------------

app.post("/oauth/register", express.json(), (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const redirectUris = body.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    !redirectUris.every(
      (uri) => typeof uri === "string" && /^https?:\/\//.test(uri)
    )
  ) {
    res.status(400).json({
      error: "invalid_redirect_uri",
      error_description: "redirect_uris must be a non-empty list of http(s) URLs",
    });
    return;
  }
  const authMethod =
    typeof body.token_endpoint_auth_method === "string"
      ? body.token_endpoint_auth_method
      : "client_secret_basic";
  if (
    !["client_secret_basic", "client_secret_post", "none"].includes(authMethod)
  ) {
    res.status(400).json({
      error: "invalid_client_metadata",
      error_description: `Unsupported token_endpoint_auth_method: ${authMethod}`,
    });
    return;
  }

  const client: Client = {
    clientId: `dyn-${randomToken(12)}`,
    clientSecret: authMethod === "none" ? undefined : randomToken(),
    redirectUris: redirectUris as string[],
    name: typeof body.client_name === "string" ? body.client_name : "Dynamic client",
  };
  clients.set(client.clientId, client);

  res.status(201).json({
    client_id: client.clientId,
    ...(client.clientSecret
      ? { client_secret: client.clientSecret, client_secret_expires_at: 0 }
      : {}),
    client_id_issued_at: now(),
    client_name: client.name,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: authMethod,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
});

// --- Authorization endpoint --------------------------------------------------

type AuthorizeParams = {
  client: Client;
  redirectUri: string;
  scope: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
};

/**
 * Validates an authorization request. Errors that make the redirect URI
 * untrustworthy are shown as a page; all others are sent to the redirect URI.
 */
function validateAuthorizeRequest(
  params: Record<string, unknown>,
  res: express.Response
): AuthorizeParams | null {
  const str = (key: string) =>
    typeof params[key] === "string" ? (params[key] as string) : undefined;
  const client = clients.get(str("client_id") ?? "");
  if (!client) {
    res.status(400).send("Unknown client_id.");
    return null;
  }
  const redirectUri =
    str("redirect_uri") ??
    (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (!redirectUri || !isAllowedRedirect(client, redirectUri)) {
    res.status(400).send("Missing or unregistered redirect_uri.");
    return null;
  }

  const state = str("state");
  const fail = (error: string, description: string) => {
    const url = new URL(redirectUri);
    url.searchParams.set("error", error);
    url.searchParams.set("error_description", description);
    if (state) url.searchParams.set("state", state);
    url.searchParams.set("iss", BASE_URL);
    res.redirect(url.toString());
    return null;
  };

  if (str("response_type") !== "code") {
    return fail("unsupported_response_type", 'response_type must be "code"');
  }
  const scope = normalizeScope(str("scope"));
  if (!scope) return fail("invalid_scope", "Unsupported scope requested");

  const codeChallenge = str("code_challenge");
  const codeChallengeMethod = codeChallenge
    ? str("code_challenge_method") ?? "plain"
    : undefined;
  if (codeChallengeMethod && !["S256", "plain"].includes(codeChallengeMethod)) {
    return fail("invalid_request", "Unsupported code_challenge_method");
  }
  if (!client.clientSecret && !codeChallenge) {
    return fail("invalid_request", "PKCE is required for public clients");
  }

  return { client, redirectUri, scope, state, codeChallenge, codeChallengeMethod };
}

app.get("/oauth/authorize", (req, res) => {
  const params = validateAuthorizeRequest(req.query, res);
  if (!params) return;

  const hidden = Object.entries({
    client_id: params.client.clientId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: params.scope,
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: params.codeChallengeMethod,
  })
    .filter(([, value]) => value !== undefined)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${name}" value="${escapeHtml(value!)}">`
    )
    .join("\n");

  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${escapeHtml(params.client.name)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; }
  .card { border: 1px solid #ddd; border-radius: 12px; padding: 1.5rem; }
  label { display: block; margin: 1rem 0 .25rem; font-weight: 600; }
  input[type=text] { width: 100%; padding: .5rem; box-sizing: border-box; border: 1px solid #bbb; border-radius: 6px; }
  .buttons { display: flex; gap: .5rem; margin-top: 1.5rem; }
  button { flex: 1; padding: .6rem; border-radius: 6px; border: 1px solid #1a1a1a; font-size: 1rem; cursor: pointer; }
  button[value=approve] { background: #1a1a1a; color: white; }
  code { background: #f3f3f3; padding: .1rem .3rem; border-radius: 4px; }
</style>
</head>
<body>
<div class="card">
  <h1>Authorize access</h1>
  <p><strong>${escapeHtml(params.client.name)}</strong> (<code>${escapeHtml(params.client.clientId)}</code>)
  wants to use <strong>${escapeHtml(agentCard.name)}</strong> with these scopes:
  <code>${escapeHtml(params.scope)}</code></p>
  <form method="post" action="/oauth/authorize">
    ${hidden}
    <label for="username">Sign in as (test user, no password)</label>
    <input type="text" id="username" name="username" value="test-user" maxlength="64">
    <div class="buttons">
      <button type="submit" name="decision" value="deny">Deny</button>
      <button type="submit" name="decision" value="approve">Approve</button>
    </div>
  </form>
</div>
</body>
</html>`);
});

app.post(
  "/oauth/authorize",
  express.urlencoded({ extended: false }),
  (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const params = validateAuthorizeRequest(body, res);
    if (!params) return;

    const url = new URL(params.redirectUri);
    if (params.state) url.searchParams.set("state", params.state);
    url.searchParams.set("iss", BASE_URL);

    if (body.decision !== "approve") {
      url.searchParams.set("error", "access_denied");
      url.searchParams.set("error_description", "The user denied access");
      res.redirect(url.toString());
      return;
    }

    const username =
      typeof body.username === "string" && body.username.trim()
        ? body.username.trim().slice(0, 64)
        : "test-user";
    const code = randomToken();
    authCodes.set(code, {
      clientId: params.client.clientId,
      redirectUri: params.redirectUri,
      scope: params.scope,
      subject: username,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      expiresAt: now() + AUTH_CODE_TTL,
    });
    url.searchParams.set("code", code);
    res.redirect(url.toString());
  }
);

// --- Token endpoint ----------------------------------------------------------

type ClientAuthResult = { client: Client } | { error: string };

/** Authenticates the client via HTTP Basic, form body, or as a public client. */
function authenticateClient(req: express.Request): ClientAuthResult {
  const body = (req.body ?? {}) as Record<string, string | undefined>;
  let clientId = body.client_id;
  let clientSecret = body.client_secret;

  const header = req.headers.authorization;
  if (header?.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return { error: "Malformed Basic credentials" };
    clientId = decodeURIComponent(decoded.slice(0, separator));
    clientSecret = decodeURIComponent(decoded.slice(separator + 1));
  }

  const client = clients.get(clientId ?? "");
  if (!client) return { error: "Unknown client" };
  if (client.clientSecret) {
    if (!clientSecret || !safeEqual(clientSecret, client.clientSecret)) {
      return { error: "Invalid client credentials" };
    }
  }
  return { client };
}

app.post(
  "/oauth/token",
  express.urlencoded({ extended: false }),
  express.json(),
  (req, res) => {
    res.set("Cache-Control", "no-store");
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const oauthError = (status: number, error: string, description: string) => {
      if (status === 401) res.set("WWW-Authenticate", 'Basic realm="oauth"');
      res.status(status).json({ error, error_description: description });
    };

    const auth = authenticateClient(req);
    if ("error" in auth) {
      oauthError(401, "invalid_client", auth.error);
      return;
    }
    const { client } = auth;

    switch (body.grant_type) {
      case "authorization_code": {
        const code = authCodes.get(body.code ?? "");
        authCodes.delete(body.code ?? ""); // single use
        if (!code || code.expiresAt <= now() || code.clientId !== client.clientId) {
          oauthError(400, "invalid_grant", "Invalid or expired authorization code");
          return;
        }
        if (body.redirect_uri !== undefined && body.redirect_uri !== code.redirectUri) {
          oauthError(400, "invalid_grant", "redirect_uri does not match");
          return;
        }
        if (code.codeChallenge) {
          const verifier = body.code_verifier;
          if (!verifier) {
            oauthError(400, "invalid_grant", "code_verifier is required");
            return;
          }
          const computed =
            code.codeChallengeMethod === "S256"
              ? createHash("sha256").update(verifier).digest("base64url")
              : verifier;
          if (!safeEqual(computed, code.codeChallenge)) {
            oauthError(400, "invalid_grant", "PKCE verification failed");
            return;
          }
        }
        res.json(
          issueTokens(client.clientId, code.subject, code.scope, "authorization_code", true)
        );
        return;
      }

      case "refresh_token": {
        const token = refreshTokens.get(body.refresh_token ?? "");
        if (!token || token.expiresAt <= now() || token.clientId !== client.clientId) {
          oauthError(400, "invalid_grant", "Invalid or expired refresh token");
          return;
        }
        refreshTokens.delete(body.refresh_token!); // rotate
        let scope = token.scope;
        if (body.scope) {
          const requested = body.scope.trim().split(/\s+/);
          const granted = token.scope.split(" ");
          if (!requested.every((s) => granted.includes(s))) {
            oauthError(400, "invalid_scope", "Cannot widen scope on refresh");
            return;
          }
          scope = requested.join(" ");
        }
        res.json(issueTokens(client.clientId, token.subject, scope, "refresh_token", true));
        return;
      }

      case "client_credentials": {
        if (!client.clientSecret) {
          oauthError(400, "unauthorized_client", "Public clients cannot use client_credentials");
          return;
        }
        const scope = normalizeScope(body.scope);
        if (!scope || scope.includes("offline_access")) {
          oauthError(400, "invalid_scope", "Unsupported scope requested");
          return;
        }
        res.json(
          issueTokens(client.clientId, `client:${client.clientId}`, scope, "client_credentials", false)
        );
        return;
      }

      default:
        oauthError(400, "unsupported_grant_type", `Unsupported grant_type: ${body.grant_type}`);
    }
  }
);

// --- Revocation (RFC 7009) ---------------------------------------------------

app.post(
  "/oauth/revoke",
  express.urlencoded({ extended: false }),
  express.json(),
  (req, res) => {
    const auth = authenticateClient(req);
    if ("error" in auth) {
      res.set("WWW-Authenticate", 'Basic realm="oauth"');
      res.status(401).json({ error: "invalid_client", error_description: auth.error });
      return;
    }
    const token = ((req.body ?? {}) as Record<string, string | undefined>).token ?? "";
    for (const store of [accessTokens, refreshTokens]) {
      if (store.get(token)?.clientId === auth.client.clientId) store.delete(token);
    }
    res.status(200).end();
  }
);

// --- A2A routes (bearer token required, except the agent card) ---------------

const requireBearerToken: express.RequestHandler = (req, res, next) => {
  if (req.method === "GET" && req.path.startsWith("/.well-known/")) {
    next();
    return;
  }
  const challenge = (extra = "") =>
    `Bearer realm="a2a", resource_metadata="${ENDPOINTS.prMetadata}", scope="${REQUIRED_SCOPE}"${extra}`;

  const header = req.headers.authorization;
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    res.set("WWW-Authenticate", challenge());
    res.status(401).json({ error: "unauthorized", error_description: "Bearer token required" });
    return;
  }
  const info = accessTokens.get(token);
  if (!info || info.expiresAt <= now()) {
    res.set(
      "WWW-Authenticate",
      challenge(', error="invalid_token", error_description="Token is invalid or expired"')
    );
    res.status(401).json({ error: "invalid_token", error_description: "Token is invalid or expired" });
    return;
  }
  if (!info.scope.split(" ").includes(REQUIRED_SCOPE)) {
    res.set("WWW-Authenticate", challenge(', error="insufficient_scope"'));
    res.status(403).json({ error: "insufficient_scope", error_description: `Scope "${REQUIRED_SCOPE}" required` });
    return;
  }
  authContext.run(info, () => next());
};

const requestHandler = new DefaultRequestHandler(
  agentCard,
  new InMemoryTaskStore(),
  new EchoAgentExecutor()
);
new A2AExpressApp(requestHandler).setupRoutes(app, "", [requireBearerToken]);

app.listen(PORT, () => {
  console.log(`OAuth test A2A agent listening on http://localhost:${PORT}`);
  console.log(`Public URL: ${BASE_URL}`);
  console.log(`Agent card: ${BASE_URL}/.well-known/agent-card.json`);
  console.log(`Pre-registered client ID: ${STATIC_CLIENT_ID}`);
});
