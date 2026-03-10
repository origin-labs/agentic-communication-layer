# Agentic Communication Layer (ACL)

A minimal, peer-to-peer communication layer for AI agents. ACL enables agents to discover each other through a directory service and communicate over secure WebSocket connections using the [Agent Communication Protocol (ACP)](https://spec.acp.anthropic.com/).

## Architecture

```
Directory (HTTP)          Peer Daemon (WSS)           Agent (stdio)
 ┌─────────────┐          ┌──────────────┐          ┌──────────────┐
 │  namespace   │          │  WSS server  │          │  stdin/stdout │
 │  claim/verify│          │  mTLS + SPKI │──stdio──▶│  JSON-RPC 2.0│
 │  publish     │          │  trust model │          │  ACP protocol│
 │  search      │          │  ACP bridge  │          └──────────────┘
 └─────────────┘          └──────────────┘
```

**Three layers:**

1. **Directory** — HTTP service for namespace registration and agent discovery. Not in the runtime path.
2. **Peer Daemon** — WSS server hosting local agents. Handles TLS, trust evaluation (peerId from certificate SPKI hash), and ACP session bridging.
3. **Agent** — Local process communicating via stdin/stdout JSON-RPC 2.0. Implements the ACP session lifecycle: `initialize` → `session/new` → `session/prompt` → `session/update` → `session/cancel`.

## Quickstart

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Generate development TLS certificates
pnpm dev:tls

# Run tests
pnpm test
```

### Start a local registry

```bash
pnpm acl registry serve --port 4040
```

### Claim and verify a namespace

```bash
export ACL_DIRECTORY_URL=http://127.0.0.1:4040

pnpm acl registry claim myns
# Returns a challenge proof
pnpm acl registry verify myns <proof>
```

### Start a peer daemon with an example agent

```bash
pnpm acl peer serve \
  --agent-id myns.echo.agent \
  --example echo \
  --cert .acl/tls/server.cert.pem \
  --key .acl/tls/server.key.pem \
  --port 7443
```

### Publish the agent to the registry

Create a manifest file (`agent.json`):

```json
{
  "agentId": "myns.echo.agent",
  "handle": "myns.echo.agent",
  "displayName": "My Echo Agent",
  "summary": "Echo agent for testing",
  "protocols": { "acp": [1] },
  "endpoints": [{
    "transport": "wss",
    "url": "wss://127.0.0.1:7443/agents/myns.echo.agent",
    "priority": 0
  }],
  "serviceCapabilities": ["echo"],
  "visibility": "public",
  "version": "0.1.0"
}
```

```bash
pnpm acl registry publish ./agent.json
```

### Send a message

```bash
export ACL_TLS_CERT=.acl/tls/server.cert.pem
export ACL_TLS_KEY=.acl/tls/server.key.pem
export ACL_TLS_CA_CERT=.acl/tls/ca.cert.pem

pnpm acl send myns.echo.agent "hello"
```

## Example Agents

| Agent | File | Description |
|-------|------|-------------|
| Echo | `examples/echo-acp-agent.mjs` | Echoes back prompt text. Supports `[hold]` for delayed response and cancellation testing. |
| Mailbox | `examples/mailbox-acp-agent.mjs` | Appends messages to a JSONL file. Parses `acl-mail-v1` envelope metadata. |
| Claude | `examples/claude-acp-agent.mjs` | Real LLM agent via OpenRouter API. Streams responses as ACP session updates. Requires `OPENROUTER_API_KEY`. |

## Packages

| Package | Description |
|---------|-------------|
| `acl-types` | Shared TypeScript types and interfaces |
| `acp-profile` | ACP protocol constants, size limits, and validation |
| `adapter-stdio` | Stdio process adapter for hosted agents |
| `cli-output` | CLI output formatting |
| `contacts-store` | File-backed local contacts store |
| `directory-client` | HTTP client for directory lookups |
| `directory-mock` | Mock directory for testing |
| `directory-server` | HTTP directory server with state persistence |
| `peer-daemon` | WSS peer daemon with ACP session bridging |
| `transport-wss` | WSS transport with TLS and SPKI-based peer identity |
| `trust` | Certificate trust evaluation and peerId derivation |

## Environment Variables

See [`.env.example`](.env.example) for the full list. Key variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | For Claude agent | API key for OpenRouter (LLM gateway) |
| `ACL_DIRECTORY_URL` | For registry ops | Directory service URL |
| `ACL_TLS_CERT` | For WSS | TLS certificate path |
| `ACL_TLS_KEY` | For WSS | TLS private key path |
| `ACL_TLS_CA_CERT` | For WSS client | CA certificate for peer verification |

## Trust Model

Peer identity is derived from the TLS certificate's Subject Public Key Info (SPKI) hash:

```
peerId = "peer_spki_sha256_" + base32(sha256(spki_der))
```

When connecting to a peer, the transport layer extracts the server's certificate, derives its peerId, and compares it against the expected value from the directory. Trust evaluation returns `matched`, `mismatched`, or `untrusted`.

## Planning Documents

The [`planning/`](planning/) directory contains the full design progression from initial analysis through implementation spec. See [`planning/README.md`](planning/README.md) for an overview.

## License

[MIT](LICENSE)
