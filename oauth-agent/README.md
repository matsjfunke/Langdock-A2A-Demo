# OAuth Test A2A Agent

An A2A agent (protocol v0.3.0) protected by OAuth 2.0. Use it to test OAuth support in A2A clients such as Langdock.

It has its own built-in OAuth server, so you don't need Auth0 or another identity provider, and it doesn't call the Langdock API. It's an echo agent: each reply repeats your message and shows the user, client, grant and scopes from the access token, so you can see exactly what your client sent.

This folder is self-contained, with its own `package.json` and lockfile, and is independent of the API-key agent in the repository root. Both agents use port 3333 by default, so run one at a time, or set `OAUTH_AGENT_PORT` to run them side by side.

## Getting Started

1. Tunnel the port. Langdock blocks private and internal addresses, so it needs a public HTTPS URL:

```bash
ngrok http 3333
```

2. Install dependencies and start the agent with your public URL:

```bash
cd oauth-agent
pnpm install
OAUTH_AGENT_URL=https://<your-ngrok-url>.ngrok-free.app pnpm dev
```

3. In Langdock, add a remote agent (A2A) with `https://<your-ngrok-url>.ngrok-free.app/.well-known/agent-card.json`. The card requires a bearer token, like the Phenom and BASF agents, so Langdock can't read it until a user has connected. Enter the OAuth settings by hand:

   | Field | Value |
   | --- | --- |
   | Authorization URL | `https://<your-ngrok-url>.ngrok-free.app/oauth/authorize` |
   | Token URL | `https://<your-ngrok-url>.ngrok-free.app/oauth/token` |
   | Client ID / secret | `langdock-test-client` / `langdock-test-secret` |
   | Scopes | `a2a:invoke offline_access` |

4. When the consent page opens, enter any username (there's no password) and click **Approve**. That username becomes the token's user.

If your client can't register itself dynamically, use the pre-registered client: ID `langdock-test-client`, secret `langdock-test-secret`. Both are dummy test values that you can override with environment variables.

## Endpoints

| Endpoint | Path |
| --- | --- |
| Agent card (bearer token required unless `OAUTH_PUBLIC_CARD=true`) | `/.well-known/agent-card.json`, or `OAUTH_CARD_PATH` |
| Authorization server metadata (RFC 8414) | `/.well-known/oauth-authorization-server` |
| Protected resource metadata (RFC 9728) | `/.well-known/oauth-protected-resource` |
| Authorize (consent page) | `/oauth/authorize` |
| Token | `/oauth/token` |
| Dynamic client registration (RFC 7591) | `/oauth/register` |
| Revocation (RFC 7009) | `/oauth/revoke` |
| A2A JSON-RPC (bearer token required) | `POST /` |

- **Grants**: authorization code with PKCE (S256 or plain), refresh token (rotated on use), client credentials
- **Scope**: `a2a:invoke` is required; `offline_access` is optional
- **Client authentication**: `client_secret_basic`, `client_secret_post`, or `none` for public clients, which must use PKCE
- The card and A2A requests without a valid token get `401` with a `WWW-Authenticate: Bearer resource_metadata="..."` challenge. A token without the required scope gets `403 insufficient_scope`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OAUTH_AGENT_URL` | `http://localhost:3333` | Public origin used in the agent card and metadata |
| `OAUTH_AGENT_PORT` | `3333` | Listen port |
| `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` | `langdock-test-client` / `langdock-test-secret` | Pre-registered confidential client |
| `OAUTH_REDIRECT_URIS` | empty (any URL) | Comma-separated redirect URI allow-list for the pre-registered client |
| `OAUTH_ACCESS_TOKEN_TTL` | `3600` | Access token lifetime in seconds; set it low (e.g. `60`) to test refresh |
| `OAUTH_REFRESH_TOKEN_TTL` | `2592000` | Refresh token lifetime in seconds |
| `OAUTH_PUBLIC_CARD` | `false` | Set to `true` to serve the agent card without a token (the A2A default) |
| `OAUTH_CARD_PATH` | `.well-known/agent-card.json` | Custom card path, e.g. `a2a/career-coach-agent` to mimic Phenom |

## Scripts

- `pnpm dev`: run with reload on file changes
- `pnpm start`: run without reload
- `pnpm typecheck`: type-check without emitting

> **Test only.** Clients, codes and tokens live in memory and are lost on restart, including restarts by `pnpm dev` after file edits. The pre-registered client accepts any redirect URI unless `OAUTH_REDIRECT_URIS` is set. Don't use this to protect anything real.
