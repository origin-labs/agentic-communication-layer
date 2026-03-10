# ACL MVP v1 Specification

## 1. Overview

ACL is a minimal agent-to-agent communication layer.
Its purpose in v1 is to let one agent discover another agent by name, connect to it over a peer transport, start an ACP session, and exchange messages.

ACP is the session and call protocol used inside ACL.
ACL does not modify ACP semantics.
ACL uses ACP for:

- `initialize`
- optional `authenticate`
- `session/new`
- `session/prompt`
- `session/update`
- `session/cancel`

ACL adds only the minimum surrounding runtime needed to make ACP work across agents:

- a directory for naming and discovery
- a peer daemon on each side
- a WSS transport carrying raw ACP JSON-RPC
- a stdio adapter for hosting local ACP agents

Out of scope in v1:

- payments
- reputation
- federation
- decentralized naming
- marketplace logic
- file transfer subsystem
- automatic remote tool execution
- user-visible cross-process session persistence
- CLI support for `session/load`

## 2. Frozen MVP Architecture

```text
Directory
    |
resolve name
    |
Local Peer Daemon
    |
WSS Transport
    |
Remote Peer Daemon
    |
Stdio Agent Adapter
    |
Local ACP Agent
```

Components:

- Directory
  - naming and discovery only
  - not on the runtime path
- Peer daemon
  - resolution
  - transport connection handling
  - trust checks
  - policy enforcement
  - ACP client/runtime routing
- WSS transport
  - remote transport for peer-to-peer communication
  - carries raw ACP JSON-RPC messages unchanged
- ACP session layer
  - call/session semantics
  - streaming and cancellation semantics
- stdio agent adapter
  - connects the peer daemon to a hosted local ACP agent process

## 3. Core Invariants

- ACP is unchanged.
- ACP messages are raw JSON-RPC messages.
- One ACP JSON-RPC message MUST be carried in one WebSocket text frame.
- The first application message on a WSS connection MUST be ACP `initialize`.
- The directory MUST NOT participate in runtime communication after resolution.
- Allowed prompt content block types in v1 are only:
  - `text`
  - `resource_link`
  - `resource` only when `promptCapabilities.embeddedContext = true`
- The implementation MUST NOT introduce custom ACP content block types.
- No raw file transfer layer exists.
- Remote filesystem capabilities MUST be disabled by default.
- Remote terminal capabilities MUST be disabled by default.
- Remote caller-provided `mcpServers` MUST be disabled by default.
- One WSS connection carries exactly one target `agentId` and exactly one ACP session in v1.
- `acl send` always uses a fresh ACP session.
- `acl call` keeps one live ACP session only for the lifetime of the command.
- `session/load` is not exposed in the CLI in v1.

## 4. Identity and Trust Model

### 4.1 `agentId`

`agentId` is the globally unique human-facing agent identifier used by the directory.

Examples:

- `acme.reviewer.agent`
- `hvac.estimator.agent`

Properties:

- globally unique within the directory
- stable logical identifier
- may map to one or more endpoints
- multiple `agentId`s MAY be hosted by one peer daemon

### 4.2 `peerId`

`peerId` is the daemon-level runtime identity used for trust pinning.
It is not human-facing.

In v1, `peerId` MUST be derived from the remote WSS TLS certificate Subject Public Key Info bytes.

Derivation:

- `peerId = "peer_spki_sha256_" + base32_no_padding_lowercase(sha256(spki_der_bytes))`

This binding is required because:

- it is tied to the actual remote connection
- it does not modify ACP
- it is available before ACP `initialize`

### 4.3 Trust Establishment

The caller MUST learn `peerId` from the remote WSS TLS handshake before relying on the connection.

Learning process:

1. open WSS
2. complete TLS handshake
3. extract leaf certificate SPKI DER bytes
4. compute `peerId`
5. compare to any stored `pinnedPeerId`

### 4.4 Trust Pinning

If a local contact contains `pinnedPeerId`, the caller MUST compare the observed `peerId` to it before proceeding beyond transport establishment.

If no pin exists:

- the connection MAY continue
- the call remains unpinned unless the operator explicitly saves trust later

### 4.5 Mismatch Behavior

If observed `peerId` does not match stored `pinnedPeerId`:

- the caller MUST fail closed by default
- the caller MUST surface:
  - expected `peerId`
  - observed `peerId`
  - target endpoint
- the connection MUST NOT proceed unless explicitly overridden by the operator

### 4.6 `inspect` Behavior

`acl inspect` is observational only.

- it MUST display the observed `peerId`
- it MUST NOT pin trust by default

### 4.7 Directory Ownership vs Runtime Trust

Directory namespace ownership proves only naming ownership.
It MUST NOT be treated as proof of runtime endpoint identity or transport trust.

Runtime trust is determined by:

- TLS validation
- `peerId` derivation
- local trust pin comparison

## 5. Directory Specification

### 5.1 Naming Rules

Canonical handle pattern:

- `^[a-z0-9-]+(\.[a-z0-9-]+)*\.agent$`

Constraints:

- lowercase ASCII only
- each label length: `1..63`
- total length: `<= 255`

Canonicalization:

- names MUST be lowercased before storage
- canonical stored identifier is exact lowercase form

### 5.2 Public Registration Policy

At launch, only namespaced handles are allowed for `public` and `unlisted` registrations.

Allowed:

- `acme.reviewer.agent`
- `hvac.estimator.agent`

Not allowed at launch:

- `name.agent`

Rationale:

- root names are scarce
- root names are high-value squatting targets

### 5.3 Visibility Modes

- `private`
  - local only
  - not stored in the directory
- `unlisted`
  - exact lookup allowed
  - not returned by search
- `public`
  - exact lookup allowed
  - returned by search

### 5.4 Uniqueness Rules

- `public` names MUST be globally unique
- `unlisted` names MUST be globally unique
- `private` names are local-only and outside directory scope

### 5.5 Tombstone and Reuse Policy

Deleting a `public` or `unlisted` registration SHOULD create a tombstone.

Tombstone requirements:

- deleted names SHOULD NOT be immediately reusable
- recommended tombstone duration: `180 days`

### 5.6 Search Behavior

- search MUST return only `public` records
- search MUST NOT return `unlisted` records
- ACL commands MUST NOT invoke search implicitly during exact resolution

### 5.7 Lookup Behavior

Exact lookup by `agentId`:

- MUST return `public` records
- MUST return `unlisted` records
- MUST NOT return `private` records

### 5.8 Record Schema

```json
{
  "agentId": "acme.reviewer.agent",
  "handle": "acme.reviewer.agent",
  "displayName": "Acme Reviewer",
  "summary": "Architecture and code review agent",
  "protocols": {
    "acp": [1]
  },
  "endpoints": [
    {
      "transport": "wss",
      "url": "wss://peer.acme.dev/agents/acme.reviewer.agent",
      "priority": 0
    }
  ],
  "serviceCapabilities": ["code.review", "architecture.plan"],
  "visibility": "public",
  "version": "1.2.0",
  "updatedAt": "2026-03-09T00:00:00Z"
}
```

Field rules:

- `agentId`: required, canonical handle
- `handle`: required, equal to canonical `agentId`
- `displayName`: required
- `summary`: required
- `protocols`: required, advisory only
- `endpoints`: required, advisory only
- `serviceCapabilities`: required, advisory only
- `visibility`: required, one of `public`, `unlisted`
- `version`: required
- `updatedAt`: required, RFC3339 timestamp

Compatibility note:

- directory metadata is advisory
- actual compatibility MUST be determined by ACP `initialize`

### 5.9 API Routes

- `POST /v1/namespaces`
- `POST /v1/namespaces/{namespace}/verify`
- `GET /v1/namespaces/{namespace}`
- `PUT /v1/agents/{agentId}`
- `GET /v1/agents/{agentId}`
- `GET /v1/search`

### 5.10 API Schemas

`POST /v1/namespaces`

Request:
```json
{
  "namespace": "acme",
  "verificationMethod": "dns_txt"
}
```

Response:
```json
{
  "namespace": "acme",
  "status": "pending",
  "challenge": {
    "type": "dns_txt",
    "name": "_acl.acme",
    "value": "acl-verify-abc123"
  },
  "createdAt": "2026-03-09T00:00:00Z"
}
```

`POST /v1/namespaces/{namespace}/verify`

Request:
```json
{
  "proof": "submitted"
}
```

Response:
```json
{
  "namespace": "acme",
  "status": "verified",
  "verifiedAt": "2026-03-09T00:05:00Z"
}
```

`GET /v1/namespaces/{namespace}`

Response:
```json
{
  "namespace": "acme",
  "status": "verified",
  "verifiedAt": "2026-03-09T00:05:00Z"
}
```

`PUT /v1/agents/{agentId}`

Request:
```json
{
  "displayName": "Acme Reviewer",
  "summary": "Architecture and code review agent",
  "protocols": { "acp": [1] },
  "endpoints": [
    {
      "transport": "wss",
      "url": "wss://peer.acme.dev/agents/acme.reviewer.agent",
      "priority": 0
    }
  ],
  "serviceCapabilities": ["code.review", "architecture.plan"],
  "visibility": "public",
  "version": "1.2.0"
}
```

Response:
```json
{
  "agentId": "acme.reviewer.agent",
  "handle": "acme.reviewer.agent",
  "displayName": "Acme Reviewer",
  "summary": "Architecture and code review agent",
  "protocols": { "acp": [1] },
  "endpoints": [
    {
      "transport": "wss",
      "url": "wss://peer.acme.dev/agents/acme.reviewer.agent",
      "priority": 0
    }
  ],
  "serviceCapabilities": ["code.review", "architecture.plan"],
  "visibility": "public",
  "version": "1.2.0",
  "updatedAt": "2026-03-09T00:10:00Z"
}
```

`GET /v1/agents/{agentId}`

Response:
```json
{
  "agentId": "acme.reviewer.agent",
  "handle": "acme.reviewer.agent",
  "displayName": "Acme Reviewer",
  "summary": "Architecture and code review agent",
  "protocols": { "acp": [1] },
  "endpoints": [
    {
      "transport": "wss",
      "url": "wss://peer.acme.dev/agents/acme.reviewer.agent",
      "priority": 0
    }
  ],
  "serviceCapabilities": ["code.review", "architecture.plan"],
  "visibility": "public",
  "version": "1.2.0",
  "updatedAt": "2026-03-09T00:10:00Z"
}
```

`GET /v1/search?q=<query>&limit=<n>&cursor=<cursor>`

Response:
```json
{
  "results": [
    {
      "agentId": "acme.reviewer.agent",
      "displayName": "Acme Reviewer",
      "summary": "Architecture and code review agent",
      "protocols": { "acp": [1] },
      "endpoints": [
        {
          "transport": "wss",
          "url": "wss://peer.acme.dev/agents/acme.reviewer.agent",
          "priority": 0
        }
      ],
      "serviceCapabilities": ["code.review", "architecture.plan"],
      "visibility": "public",
      "version": "1.2.0",
      "updatedAt": "2026-03-09T00:10:00Z"
    }
  ],
  "nextCursor": null
}
```

## 6. Peer Daemon Specification

### 6.1 Responsibilities

The peer daemon is responsible for:

- maintaining local peer identity
- maintaining local contacts
- resolving names through contacts and directory
- opening outbound WSS connections
- accepting inbound WSS connections
- enforcing trust checks
- enforcing policy rules
- routing ACP messages
- hosting local ACP agents via stdio adapters

### 6.2 Outbound Pipeline

```text
CLI
 -> contacts exact match
 -> directory exact lookup if needed
 -> trust lookup
 -> policy preflight
 -> WSS connect
 -> ACP initialize
 -> ACP authenticate if needed
 -> ACP session/new
 -> prompt loop
 -> close
```

### 6.3 Inbound Pipeline

```text
WSS accept
 -> endpoint path route match
 -> trust / transport auth check
 -> stdio adapter spawn
 -> ACP proxying between WSS and adapter
 -> policy enforcement
 -> close and cleanup
```

### 6.4 Routing Rules

- Endpoint path MUST select exactly one local `agentId`.
- One WSS connection MUST target exactly one `agentId`.
- One WSS connection MUST carry exactly one ACP session in v1.
- The daemon MUST NOT allow multiple ACP sessions on one WSS connection in v1.
- The daemon MUST NOT allow multiple concurrent prompts in a session.

### 6.5 Session Persistence

There is no user-visible cross-process session persistence in v1.

- `acl send` always creates a fresh session
- `acl call` holds one live session only for the duration of the command
- the daemon MUST NOT persist resumable sessions for later CLI attachment in v1

## 7. Transport Specification

### 7.1 Mandatory Transport

WSS is the only remote transport in v1.

Later transports may be added behind the same interface, but are out of scope.

### 7.2 Endpoint Format

Canonical format:

- `wss://{host}/agents/{agentId}`

Examples:

- `wss://peer.acme.dev/agents/acme.reviewer.agent`
- `wss://10.0.0.5:8443/agents/hvac.estimator.agent`

### 7.3 Framing Rules

- Each WebSocket frame MUST be a UTF-8 text frame.
- Each frame MUST contain exactly one serialized ACP JSON-RPC object.
- The transport MUST NOT use binary frames in v1.
- The transport MUST NOT add any ACL framing or envelope.

### 7.4 Handshake Rules

1. establish TCP connection
2. complete TLS handshake
3. complete WebSocket upgrade
4. optionally validate transport-level bearer auth
5. caller sends ACP `initialize`

Server behavior:

- If the endpoint path does not match a hosted `agentId`, the server MUST reject the connection.
- If the first application message is not ACP `initialize`, the server MUST close the connection.

### 7.5 Timeout Rules

Defaults:

- `CONNECT_TIMEOUT_MS = 10000`
- `INIT_START_TIMEOUT_MS = 5000`
- `INITIALIZE_RESPONSE_TIMEOUT_MS = 10000`
- `AUTH_TIMEOUT_MS = 15000`
- `SESSION_NEW_TIMEOUT_MS = 10000`
- `PROMPT_IDLE_TIMEOUT_MS = 120000`
- `CANCEL_GRACE_TIMEOUT_MS = 10000`
- `WSS_PING_INTERVAL_MS = 30000`
- `WSS_PING_DEAD_MS = 90000`

Behavior:

- If no `initialize` arrives within `INIT_START_TIMEOUT_MS`, the callee MUST close the connection.
- If the caller receives no initialize response within `INITIALIZE_RESPONSE_TIMEOUT_MS`, it MUST fail the connection.
- During a prompt turn, if no progress or result arrives within `PROMPT_IDLE_TIMEOUT_MS`, the caller MUST send `session/cancel`.
- If cancellation does not complete within `CANCEL_GRACE_TIMEOUT_MS`, the caller MUST close the connection.

### 7.6 Reconnect Rules

- The implementation MUST NOT automatically reconnect mid-session in v1.
- Transport loss terminates the active command.
- `session/load` MUST NOT be exposed in the CLI in v1.

## 8. ACP Profile for ACL MVP

### 8.1 General Rules

- The caller MUST act as ACP client.
- The callee MUST act as ACP agent.
- ACP semantics MUST remain unchanged.
- The daemon MUST preserve raw ACP JSON-RPC message bodies on the wire.

### 8.2 `initialize`

- The caller MUST send `initialize` first.
- The caller MUST advertise conservative client capabilities:
  - `fs.readTextFile = false`
  - `fs.writeTextFile = false`
  - `terminal = false`
- The caller SHOULD include `clientInfo`.
- The callee MUST respond with negotiated protocol version and advertised capabilities.

### 8.3 `authenticate`

- `authenticate` MAY be used only after successful `initialize`.
- If ACP auth is required and fails, the caller MUST close the connection.

### 8.4 `session/new`

- The caller MUST use `session/new` for all CLI sessions in v1.
- The caller MUST send:
  - `cwd: "/"`
  - `mcpServers: []`
- The callee daemon MAY map `cwd: "/"` to the adapter’s configured local `serviceRoot`.

### 8.5 `session/prompt`

- Only one `session/prompt` MAY be in flight per session.
- Prompt content MUST be validated against the content restrictions before send.

### 8.6 `session/update`

- The caller MUST accept `session/update` notifications while a prompt is active.
- The caller MUST continue accepting trailing `session/update` notifications after sending `session/cancel` until the final prompt response arrives.

### 8.7 `session/cancel`

- The caller MUST send `session/cancel` when local cancellation is requested or local policy requires aborting the turn.
- If permission requests are pending when cancelling, the caller MUST respond with ACP `cancelled` outcomes.

### 8.8 Omitted or Forbidden ACP Features in v1

- `session/load` is not exposed in the CLI.
- caller-provided `mcpServers` are forbidden in v1
- remote caller-side `fs/*` access is forbidden in v1
- remote caller-side `terminal/*` access is forbidden in v1
- multiple ACP sessions per WSS connection are forbidden in v1

### 8.9 Content Restrictions

Allowed prompt content block types:

- `text`
- `resource_link`
- `resource` only when `promptCapabilities.embeddedContext = true`

Forbidden in v1:

- `image`
- `audio`
- unknown content block types
- custom ACP content block types

Structured content rule:

- structured content SHOULD be encoded inside `text` or `resource.text`
- the implementation MUST NOT add a raw file transfer primitive

### 8.10 Concurrency Restrictions

- Exactly one ACP session per WSS connection in v1
- Exactly one in-flight prompt per session
- No concurrent multi-session multiplexing

## 9. Agent Adapter Specification

### 9.1 Adapter Type

The only supported adapter type in v1 is `stdio`.

### 9.2 Adapter Configuration

```json
{
  "type": "stdio",
  "command": "/path/to/agent",
  "args": ["acp"],
  "env": [],
  "serviceRoot": "/srv/agent"
}
```

### 9.3 Lifecycle

For each inbound WSS connection:

1. route to local `agentId`
2. spawn stdio adapter process
3. proxy ACP messages between WSS and stdio
4. terminate adapter when connection closes

The daemon MUST use one adapter process per inbound connection in v1.

### 9.4 Capability Truth

The local ACP agent’s `initialize` response is the only source of runtime capability truth.

- adapter metadata MAY describe local configuration
- adapter metadata MUST NOT invent ACP runtime capabilities

### 9.5 `serviceRoot` Mapping

The daemon MUST map remote `cwd: "/"` to the adapter’s configured local `serviceRoot`.
This is daemon-local behavior and not a change to ACP semantics.

### 9.6 Invalid Stdout Behavior

- Adapter stdout MUST contain only valid ACP JSON-RPC messages.
- Invalid ACP on adapter stdout MUST be treated as fatal.
- On fatal invalid stdout, the daemon MUST terminate the adapter and fail the connection.

### 9.7 stderr Handling

- Adapter stderr is logging only.
- The daemon MUST NOT forward stderr as ACP content.

## 10. CLI Specification

### 10.1 Common Resolution Order

All CLI commands MUST resolve targets in this order:

1. exact alias in local contacts
2. exact `agentId` in local contacts
3. exact directory lookup by `agentId`

The CLI MUST NOT invoke directory search implicitly.

### 10.2 `acl resolve`

Usage:

- `acl resolve <target>`

Behavior:

- resolves target using exact resolution order
- does not open WSS
- does not pin trust

Default output:
```text
agentId: acme.reviewer.agent
endpoint: wss://peer.acme.dev/agents/acme.reviewer.agent
source: directory
```

`--json` output:
```json
{
  "agentId": "acme.reviewer.agent",
  "endpoint": "wss://peer.acme.dev/agents/acme.reviewer.agent",
  "source": "directory"
}
```

### 10.3 `acl inspect`

Usage:

- `acl inspect <target>`

Behavior:

- resolves target
- opens WSS
- derives observed `peerId`
- performs ACP `initialize`
- prints:
  - endpoint
  - observed `peerId`
  - negotiated protocol version
  - `agentInfo`
  - `agentCapabilities`
  - `authMethods`
- does not create a session
- does not pin trust by default

`--json` output MUST include raw initialize result.

Example:
```json
{
  "agentId": "acme.reviewer.agent",
  "endpoint": "wss://peer.acme.dev/agents/acme.reviewer.agent",
  "peerId": "peer_spki_sha256_abc123",
  "initialize": {
    "protocolVersion": 1,
    "agentCapabilities": {
      "loadSession": false,
      "promptCapabilities": {
        "image": false,
        "audio": false,
        "embeddedContext": true
      }
    },
    "agentInfo": {
      "name": "acme-reviewer",
      "title": "Acme Reviewer",
      "version": "1.2.0"
    },
    "authMethods": []
  }
}
```

### 10.4 `acl send`

Usage:

- `acl send <target> <message>`
- `printf '%s' 'message' | acl send <target> -`

Behavior:

- resolves target
- opens WSS
- derives and checks `peerId`
- runs `initialize`
- runs `authenticate` if needed
- opens a fresh session with `session/new`
- sends one prompt
- prints result
- closes connection

Input rules:

- stdin MUST be read only when the message argument is exactly `-`
- the command MUST NOT implicitly read stdin when no message is provided

Default output:

- stdout: aggregated visible agent text
- stderr: progress and diagnostics

`--json` output MUST include:

- resolved target data
- observed `peerId`
- raw initialize result
- session id
- raw prompt result
- aggregated visible text

`--jsonl` output MUST emit normalized event wrappers with raw ACP payloads nested in `payload`.

Event types:

- `resolved`
- `connected`
- `initialized`
- `authenticated`
- `session_opened`
- `session_update`
- `permission_request`
- `prompt_result`
- `error`

### 10.5 `acl call`

Usage:

- `acl call <target>`

Behavior:

- resolves target
- opens WSS
- derives and checks `peerId`
- runs `initialize`
- runs `authenticate` if needed
- opens one live session
- enters a prompt REPL loop
- keeps the session only for the lifetime of the command

Local controls:

- `/exit`
  - closes the session and transport
- `/cancel`
  - sends `session/cancel` if a prompt is active

Default output:

- stdout: aggregated visible agent text
- stderr: progress and diagnostics

`--jsonl` output MUST use the same event model as `acl send`.

### 10.6 Exit Codes

- `0` success
- `1` CLI usage or local config error
- `2` resolution failure
- `3` transport or TLS failure
- `4` ACP initialize or protocol version failure
- `5` authentication failure
- `6` session setup failure
- `7` locally cancelled prompt
- `8` remote JSON-RPC, adapter, or runtime error
- `9` local policy rejection

## 11. Policy Engine Rules

### 11.1 Remote Defaults

Outbound `initialize.clientCapabilities` MUST be:

```json
{
  "fs": {
    "readTextFile": false,
    "writeTextFile": false
  },
  "terminal": false
}
```

Outbound `session/new` MUST use:

```json
{
  "cwd": "/",
  "mcpServers": []
}
```

### 11.2 Permission Rejection Algorithm

Default policy is reject.

Algorithm:

1. if a permission option with `kind = reject_once` exists, select the first one
2. else if a permission option with `kind = reject_always` exists, select the first one
3. else send `session/cancel`
4. if cancellation is in progress, respond to pending permission requests with ACP `cancelled`

### 11.3 Content Restrictions

Allowed:

- `text`
- `resource_link`
- `resource` only if remote advertised `embeddedContext`

Rejected:

- `image`
- `audio`
- unknown content block types
- custom ACP content block types

### 11.4 Prompt Size Limits

Defaults:

- `MAX_PROMPT_TOTAL_BYTES = 524288`
- `MAX_TEXT_BLOCK_BYTES = 262144`
- `MAX_RESOURCE_TEXT_BYTES = 262144`
- `MAX_RESOURCE_LINK_URI_BYTES = 4096`
- `MAX_PROMPT_BLOCKS = 32`

Behavior:

- outbound prompts exceeding limits MUST be rejected locally
- inbound prompts exceeding limits MUST be rejected with JSON-RPC `-32602`

### 11.5 Update Size Limits

Defaults:

- `MAX_UPDATE_FRAME_BYTES = 262144`
- `MAX_UPDATE_CUMULATIVE_BYTES_PER_TURN = 8388608`
- `MAX_TOOL_CALL_CONTENT_ITEMS = 64`

Behavior:

- if one `session/update` exceeds `MAX_UPDATE_FRAME_BYTES`, the caller MUST cancel the turn
- if cumulative updates exceed `MAX_UPDATE_CUMULATIVE_BYTES_PER_TURN`, the caller MUST cancel the turn

### 11.6 Timeout Limits

Defaults:

- `CONNECT_TIMEOUT_MS = 10000`
- `INIT_START_TIMEOUT_MS = 5000`
- `INITIALIZE_RESPONSE_TIMEOUT_MS = 10000`
- `AUTH_TIMEOUT_MS = 15000`
- `SESSION_NEW_TIMEOUT_MS = 10000`
- `PROMPT_IDLE_TIMEOUT_MS = 120000`
- `CANCEL_GRACE_TIMEOUT_MS = 10000`

### 11.7 Inbound Hardening Rules

For inbound remote traffic, the daemon MUST:

- reject non-empty `mcpServers`
- reject unsupported content block types
- reject oversized prompts
- reject a second session on the same WSS connection
- reject a second prompt while the first is active
- never expose adapter stderr as ACP content
- never synthesize caller-side fs or terminal capabilities

## 12. Error Taxonomy

| Class | Cause | Source | CLI Surface | Exit Code | Retryable |
| --- | --- | --- | --- | --- | --- |
| Directory error | namespace registration, lookup, or search failure | directory service or directory client | directory error with details | `2` or `8` | sometimes |
| Resolution error | target not found by exact alias or exact `agentId` lookup | local peer daemon | `target not found` | `2` | no |
| Transport error | DNS, TCP, TLS, WSS upgrade, ping timeout, early close | transport manager | transport phase and endpoint | `3` | yes |
| TLS/auth error | TLS validation failure, bearer auth failure, ACP auth failure | transport manager or remote peer/agent | auth failure with phase | `5` | yes |
| ACP initialize error | version mismatch, invalid ordering, bad init response | either side | protocol/init failure | `4` | generally no |
| Session error | `session/new` or prompt request failure | remote agent or local state machine | JSON-RPC code and message | `6` or `8` | sometimes |
| Policy error | local content, size, permission, or safety rule fired | local peer daemon | policy rule name and message | `9` | only with changed input or flags |
| Adapter/runtime error | adapter startup failure, crash, invalid stdout | local callee daemon or caller observing remote failure | adapter or runtime failure | `8` | sometimes |

## 13. State Machines

### 13.1 Outbound State Machine

```text
Idle
 -> Resolving
 -> Connecting
 -> Initializing
 -> Authenticating
 -> OpeningSession
 -> SessionReady
 -> PromptInProgress
 -> Cancelling
 -> SessionReady
 -> Closing
 -> Closed
```

Transition rules:

- `Idle -> Resolving` when command starts
- `Resolving -> Connecting` after endpoint selection
- `Connecting -> Initializing` after WSS open
- `Initializing -> Authenticating` if auth is required
- `Initializing -> OpeningSession` if auth is not required
- `Authenticating -> OpeningSession` after auth success
- `OpeningSession -> SessionReady` after `session/new`
- `SessionReady -> PromptInProgress` after `session/prompt`
- `PromptInProgress -> SessionReady` after normal prompt completion
- `PromptInProgress -> Cancelling` after local cancel or policy cancel
- `Cancelling -> SessionReady` after prompt completes with `stopReason: cancelled`
- any active state MAY transition to `Closing` on fatal transport, protocol, or adapter failure

### 13.2 Inbound State Machine

```text
Listening
 -> Accepted
 -> AdapterStarting
 -> Initializing
 -> SessionOpening
 -> SessionReady
 -> PromptInProgress
 -> Cancelling
 -> Closing
 -> Closed
```

### 13.3 Edge-Case Rules

Adapter crash mid-turn:

- if possible, the callee SHOULD send JSON-RPC `-32603` for the outstanding request
- the callee MUST then close the connection

`session/cancel` followed by transport close:

- the caller MUST treat the result as incomplete cancellation
- the caller MUST NOT assume a clean remote stop

Initialize succeeds but auth fails:

- the caller MUST close the transport
- no resumable session state is persisted

Prompt result arrives after caller entered `Closing`:

- the implementation MAY drop the late result
- the implementation MUST NOT reopen the state machine

## 14. Conformance Requirements

The implementation is not MVP-complete until all of the following pass end-to-end:

- successful exact `acl inspect`
- successful exact `acl send`
- successful multi-turn `acl call`
- permission rejection path
- permission request with no reject option causing cancel
- local cancel path with trailing updates accepted
- oversized prompt rejected locally before send
- unsupported content block rejected locally
- invalid ACP from adapter stdout detected and fails connection
- adapter crash mid-turn handled according to spec
- exact lookup of `public` record
- exact lookup of `unlisted` record
- search returns only `public` records
- observed `peerId` is reported
- pinned `peerId` match succeeds
- pinned `peerId` mismatch fails closed and warns
- first non-`initialize` message on inbound connection is rejected

## 15. Explicit Non-Goals

The following are explicitly out of scope for v1:

- file transfer protocol
- raw file attachments
- payments
- billing
- reputation systems
- marketplace logic
- directory federation
- decentralized naming
- automatic remote tool execution
- user-visible session resume or attachment across CLI invocations
- CLI support for `session/load`
- support for remote caller-side filesystem access
- support for remote caller-side terminal access
- support for caller-provided remote MCP servers

## 16. Dangerous Implementation Mistakes

1. Treating directory ownership as runtime trust proof.
2. Introducing custom ACP content block types.
3. Allowing more than one active prompt per ACP session.
4. Exposing filesystem, terminal, or MCP capabilities to remote peers by default.
5. Adding user-visible session resume before real interop is proven.
