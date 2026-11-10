# Demo Langdock A2A Agent

This repo is a sample of a simple implementation of an A2A agent compatible with Langdock's implementation of the A2A protocol.

## Requirements

The following is needed to run / experiment with this repo:

1. Langdock Account & API key with access to the Agent API

2. [Node.js](https://nodejs.org/) (v18 or higher recommended)

```bash
brew install node
```

3. [pnpm](https://pnpm.io/) package manager

```bash
brew install pnpm
```

4. [ngrok](https://ngrok.com/) for tunneling

```bash
brew install ngrok
```

## Getting Started

1. Tunnel the server port with ngrok

```bash
ngrok http 3333
```

2. Install dependencies and run dev server with your ngrok URL

```bash
AGENT_URL=https://<your-ngrok-url>.ngrok-free.app pnpm d
```

3. Copy the Url from the Terminal output

4. Open Langdock and "add integration" -> "start from scratch" -> "Connect Remote Agent (A2A)" -> paste the copied url into the input field:

- Run this command (in a different terminal) to open the langdock integrations page:

```bash
pnpm langdock
```

5. Create a Connection to the Agent

Just use an langdock api-key with the `Agent API` Scope, it will be forwarded to the A2A

(Optionally) Open the A2A Inspector to test your agent:

```bash
pnpm inspector
```

## OAuth Test Agent

`src/oauth-server.ts` is a second, separate A2A agent protected by OAuth 2.0. Use it to test OAuth support in A2A clients such as Langdock. It has its own built-in OAuth server, so you don't need Auth0 or another identity provider, and it doesn't call the Langdock API.

It's an echo agent: each reply repeats your message and shows the user, client, grant and scopes from the access token.

```bash
ngrok http 3334
OAUTH_AGENT_URL=https://<your-ngrok-url>.ngrok-free.app pnpm dev:oauth
```

Then add `https://<your-ngrok-url>.ngrok-free.app/.well-known/agent-card.json` as a remote agent.

| Endpoint | URL |
| --- | --- |
| Agent card (public) | `/.well-known/agent-card.json` |
| Authorization server metadata (RFC 8414) | `/.well-known/oauth-authorization-server` |
| Protected resource metadata (RFC 9728) | `/.well-known/oauth-protected-resource` |
| Authorize (consent page) | `/oauth/authorize` |
| Token | `/oauth/token` |
| Dynamic client registration (RFC 7591) | `/oauth/register` |
| Revocation (RFC 7009) | `/oauth/revoke` |

- **Grants**: authorization code with PKCE (S256 or plain), refresh token (rotated on use), client credentials
- **Scope**: `a2a:invoke` is required; `offline_access` is optional
- **Pre-registered client**: ID `langdock-test-client`, secret `langdock-test-secret`. Both are dummy test values; you can override them.
- **Consent page**: enter any username, no password. It becomes the token's user.
- A2A requests without a valid token get `401` with a `WWW-Authenticate: Bearer resource_metadata="..."` challenge. A token without the required scope gets `403 insufficient_scope`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OAUTH_AGENT_URL` | `http://localhost:3334` | Public origin used in the agent card and metadata |
| `OAUTH_AGENT_PORT` | `3334` | Listen port |
| `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` | `langdock-test-client` / `langdock-test-secret` | Pre-registered confidential client |
| `OAUTH_REDIRECT_URIS` | empty (any URL) | Comma-separated redirect URI allow-list for the pre-registered client |
| `OAUTH_ACCESS_TOKEN_TTL` | `3600` | Access token lifetime in seconds; set it low (e.g. `60`) to test refresh |
| `OAUTH_REFRESH_TOKEN_TTL` | `2592000` | Refresh token lifetime in seconds |

> Test only: clients, codes and tokens live in memory and are lost on restart, including restarts by `tsx watch` after file edits.

## Agent Details

- **Protocol Version**: 0.3.0
- **Port**: 3333

## Dependencies

- `@a2a-js/sdk` - A2A protocol SDK
- `express` - Web framework
- `uuid` - UUID generation
