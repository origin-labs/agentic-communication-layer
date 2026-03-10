# MVP Spec Hardening Review

## Purpose

This document records the final skeptical review pass before freezing the ACL MVP specification.
It stays within the current MVP and focuses on:

- failure modes
- ambiguities
- normative rule tightening
- trust establishment
- directory governance
- state machine hardening
- CLI hardening
- minimum conformance requirements

## 1. Executive Review

The MVP architecture is correct and minimal:

- ACP remains unchanged
- WSS is the only remote transport
- the directory is discovery only
- each side runs a peer daemon
- hosted agents are reached through stdio adapters
- no file transfer layer exists
- remote defaults are strict

The largest remaining weak spots are:

1. trust establishment and `peerId` binding
2. whether sessions should persist across CLI invocations
3. directory governance for root names
4. side effects of `inspect`
5. adapter crash handling and prompt cancellation edge cases

The conservative resolution is:

- bind `peerId` to the WSS TLS certificate public key
- make trust pinning explicit and side-effect free by default
- remove user-visible session persistence from the MVP
- keep `session/load` out of the CLI for now
- allow only namespaced registrations in the public directory at launch

## 2. Spec Gaps And Ambiguities

### Directory

- Root registrations like `name.agent` are underspecified and highly vulnerable to squatting.
- Reserved-name policy is too weak without a namespace admission policy.
- The distinction between ownership and trust is not explicit enough.
- It is unclear whether `unlisted` names are globally unique. They should be.
- Name deletion behavior is not specified. Immediate reuse is dangerous.

### Trust / `peerId`

- `peerId` exists conceptually but was not concretely bound to the connection.
- It was unclear whether `peerId` comes from TLS, an ACP `_meta` field, or a transport header.
- It was unclear when trust pins are learned, persisted, and enforced.
- The mismatch behavior was not fully specified.

### WSS Connection Semantics

- The previous spec restricted one WSS connection to one session. That is conservative, but the rationale was not explicit.
- It was unclear whether one connection targets exactly one `agentId` or may later be reused for other hosted agents. It should not.
- Reconnection behavior was defined loosely; session resumption over dropped transports is not interoperable enough for MVP.

### Session Store

- Persistent session store format was specified before deciding whether sessions should be user-visible.
- There was no demonstrated MVP need for cross-process session persistence.
- There was no transcript metadata model, which means the store was neither sufficient for replay nor necessary for current CLI behavior.

### Adapter Boundary

- Mapping remote `cwd = "/"` to a local `serviceRoot` is practical but must be explicitly defined as daemon behavior, not ACP semantics.
- It was not fully specified whether `inspect` should spawn a full adapter process and whether that side effect is acceptable. It is acceptable, but it must not persist trust by default.
- Invalid ACP from adapter stdout was marked fatal, but the caller-observable behavior needed a precise rule.

### CLI

- Implicit search in `resolve` would create ambiguity and unstable automation; it should never happen.
- `inspect` side effects were unclear.
- `send` stdin behavior was underspecified.
- JSON and JSONL output formats needed a clear choice between raw ACP payloads and normalized wrappers.
- User-visible sessions add scope without strong interop guarantees.

## 3. Normative Rules

### Transport

- Each peer daemon MUST expose hosted remote agents via WSS endpoints of the form `wss://{host}/agents/{agentId}`.
- Each WSS connection MUST target exactly one `agentId`.
- Each WebSocket text frame MUST contain exactly one raw ACP JSON-RPC message.
- The transport MUST NOT add an ACL message envelope around ACP payloads.
- The first application message on a successfully upgraded WSS connection MUST be ACP `initialize`.
- If the first application message is not `initialize`, the callee daemon MUST close the connection.
- The transport MUST use UTF-8 text frames only in the MVP.
- The MVP transport MUST NOT attempt mid-session automatic reconnection.

### ACP Profile

- The caller MUST act as ACP client.
- The callee MUST act as ACP agent.
- The caller MUST complete `initialize` before sending any session method.
- The caller MUST NOT send `session/new`, `session/load`, or `session/prompt` before `initialize` succeeds.
- The caller MUST send `mcpServers: []` in every `session/new` request in the MVP.
- The caller MUST advertise `fs.readTextFile = false`, `fs.writeTextFile = false`, and `terminal = false` for remote peers in the MVP.
- The caller MUST NOT rely on `session/load` unless the remote agent explicitly advertised `loadSession`.
- The CLI MUST NOT expose `session/load` as a user-facing feature in the MVP.

### Content Restrictions

- The daemon MUST allow only ACP-compatible content block types `text`, `resource_link`, and `resource`.
- The daemon MUST reject `image`, `audio`, and unknown content block types in the MVP.
- The daemon MUST NOT introduce custom ACP content block types.
- The daemon MUST send `resource` content only if the remote agent advertised `promptCapabilities.embeddedContext = true`.
- Structured application data SHOULD be encoded inside `text` or `resource.text`.
- The MVP MUST NOT implement a raw file transfer primitive.

### Concurrency

- A WSS connection MUST carry at most one ACP session in the MVP.
- An ACP session MUST have at most one in-flight `session/prompt` request at a time.
- The caller MUST NOT send a second prompt until the previous prompt response arrives.
- The callee daemon MUST reject concurrent second-session or second-prompt attempts with JSON-RPC `-32602` or by closing the connection if the protocol state is unrecoverable.

### Timeout Behavior

- The callee daemon MUST close the connection if `initialize` is not received within `INIT_START_TIMEOUT_MS`.
- The caller MUST fail the connection if no initialize response arrives within `INITIALIZE_RESPONSE_TIMEOUT_MS`.
- During an active prompt turn, if no prompt response, update, or permission request arrives within `PROMPT_IDLE_TIMEOUT_MS`, the caller MUST send `session/cancel`.
- After sending `session/cancel`, the caller MUST wait `CANCEL_GRACE_TIMEOUT_MS` for the final prompt response.
- If the final prompt response does not arrive within `CANCEL_GRACE_TIMEOUT_MS`, the caller MUST close the transport.

### Permission Requests

- The caller MUST reject permission requests by default in the MVP.
- If a rejection option exists, the caller MUST select a rejection option rather than silently dropping the request.
- If no rejection option exists, the caller MUST cancel the prompt turn.
- If a prompt turn is being cancelled while permission requests are outstanding, the caller MUST respond to each outstanding `session/request_permission` with the ACP `cancelled` outcome.
- The caller MUST continue accepting trailing `session/update` notifications after sending `session/cancel` until the final prompt response arrives.

### Trust Pinning

- The caller MUST derive `peerId` from the remote WSS TLS certificate public key.
- The caller MUST treat `peerId` as connection-bound identity.
- The caller MUST NOT trust directory ownership as proof of runtime endpoint identity.
- The caller MUST compare the observed `peerId` to any stored `pinnedPeerId` before sending ACP application messages beyond `initialize`.
- If a stored `pinnedPeerId` mismatches the observed `peerId`, the caller MUST fail the connection unless explicitly overridden by the operator.
- `inspect` MUST NOT persist a trust pin by default.
- `call` and `send` SHOULD remain side-effect free for unsaved targets by default.

### Adapter Boundary

- The adapter manager MUST treat the local ACP agent as the only source of runtime ACP capabilities.
- The adapter boundary MUST reject non-empty inbound `mcpServers`.
- The adapter boundary MUST enforce content type restrictions before forwarding prompts to the local agent.
- The adapter boundary MUST map remote `cwd = "/"` to the configured local `serviceRoot`.
- The adapter boundary MUST treat invalid ACP on stdout as fatal.
- The daemon MUST NOT forward stderr as ACP content.

## 4. Error Taxonomy

### Directory Errors

- Occurs when namespace registration, lookup, or search fails at the directory layer.
- Generated by the directory service or directory client.
- CLI should surface a short category plus underlying response details.
- Recommended exit code: `2` for not found, `1` for malformed local request, `8` for remote directory failure.
- Retryable: sometimes. `404` no, transient `5xx` yes.

### Resolution Errors

- Occurs when target cannot be resolved from contacts or exact directory lookup.
- Generated by local peer daemon.
- CLI should print `target not found`.
- Recommended exit code: `2`.
- Retryable: only if config or target changes.

### Transport Errors

- Occurs on DNS, TCP, TLS, WebSocket upgrade, ping timeout, or remote close before ACP success.
- Generated by local transport manager.
- CLI should print transport phase and endpoint.
- Recommended exit code: `3`.
- Retryable: yes.

### TLS / Auth Errors

- Occurs on TLS validation failure, transport auth rejection, or ACP authenticate failure.
- Generated by transport manager or remote peer / ACP agent.
- CLI should print whether the failure is transport auth or ACP auth.
- Recommended exit code: `5`.
- Retryable: yes after credential fix or override.

### ACP Protocol Errors

- Occurs when ACP ordering is violated, invalid JSON-RPC is received, version negotiation fails, or unsupported methods are used.
- Generated by either local daemon or remote peer/agent.
- CLI should show JSON-RPC code/message and phase.
- Recommended exit code: `4` for initialize/version issues, `8` for later ACP errors.
- Retryable: generally no until implementation/config change.

### Session Errors

- Occurs when `session/new` fails, `session/prompt` fails, or session state is invalid.
- Generated by remote ACP agent or local state machine.
- CLI should surface JSON-RPC error or local state violation clearly.
- Recommended exit code: `6` for session open failures, `8` for remote prompt/session errors.
- Retryable: sometimes.

### Policy Errors

- Occurs when local policy rejects target, content, permission request handling, prompt size, or update size.
- Generated by local peer daemon.
- CLI should clearly identify the local policy rule that fired.
- Recommended exit code: `9`.
- Retryable: only with different operator flags or prompt content.

### Adapter / Runtime Errors

- Occurs when adapter startup fails, adapter crashes, stdout is invalid ACP, or local hosted agent exits unexpectedly.
- Generated by local callee daemon or local caller daemon if hosting inbound endpoint.
- CLI should surface `adapter_failure`, `adapter_crash`, or `invalid_adapter_output`.
- Recommended exit code: `8` for remote-visible failures, `1` for local development/test contexts.
- Retryable: sometimes.

## 5. Trust / `peerId` Recommendation

### Hard Recommendation

For the MVP, `peerId` MUST be derived from the remote WSS server TLS certificate public key.

Concrete definition:

- `peerId = "peer_spki_sha256_" + base32(lowercase, no padding, sha256(SPKI_DER_bytes))`

Where it comes from:

- from the TLS certificate presented by the remote WSS endpoint during the TLS handshake

Why this is the MVP answer:

- it is bound to the actual connection
- it does not mutate ACP semantics
- it requires no extra control message
- it is available before ACP `initialize`
- it is easy to pin and compare

### Learning And Verification

1. Caller opens WSS.
2. Caller completes TLS handshake.
3. Caller extracts the leaf certificate SPKI bytes.
4. Caller computes `peerId`.
5. Caller compares it to any stored `pinnedPeerId`.
6. If no pin exists, caller may continue but does not persist trust by default.

### Pinning Behavior

- `inspect` observes `peerId` and displays it, but MUST NOT pin by default.
- `call` and `send` against a saved contact with an existing `pinnedPeerId` MUST enforce pin matching.
- If a saved contact has no `pinnedPeerId`, the implementation MAY offer an explicit trust-save flow later, but MUST remain side-effect free by default in the MVP.

### Mismatch Behavior

If observed `peerId` differs from `pinnedPeerId`:

- the caller MUST fail closed by default
- the caller MUST present:
  - expected `peerId`
  - observed `peerId`
  - target endpoint
- the CLI SHOULD require an explicit override flag to continue

### What Not To Use

- Do not use ACP `_meta` for `peerId` identity.
- Do not use directory metadata as runtime identity proof.
- Do not use custom WSS headers as the primary source of truth.

Directory metadata may optionally cache last-seen `peerId`, but it MUST be treated as advisory only.

## 6. Directory Governance Recommendation

### Hard Recommendation

Only namespaced registrations SHOULD be allowed in the public directory at MVP launch.

Meaning:

- allow `acme.reviewer.agent`
- allow `hvac.estimator.agent`
- do not allow `name.agent` in the public directory initially

Rationale:

- root names are scarce
- root names are high-value squatting targets
- moderation cost is high

Private local contacts may still use any local alias independently of public registration rules.

### Global Uniqueness

- `public` names MUST be globally unique
- `unlisted` names MUST also be globally unique
- `private` names are local-only and outside directory governance

### Anti-Squatting

- namespace verification is required before public or unlisted registration
- inactive records SHOULD expire only after a long grace period
- names MUST NOT be immediately reusable after deletion

### Transfer Policy

- no self-service name transfer in MVP
- transfers MUST be manual, reviewed, and recorded by the directory operator

### Deletion / Tombstones

- deleting a public or unlisted name SHOULD create a tombstone
- tombstones SHOULD block reuse for a fixed period, recommended `180 days`

### Canonicalization

- lowercase ASCII only
- labels separated by dots
- final suffix `.agent` required
- exact byte-equal canonical form is the stored identifier

### Ownership vs Trust

Namespace verification proves ownership of naming rights only.
It MUST NOT be treated as proof that any current endpoint or peer certificate is trustworthy.

## 7. State Machine Review

### Outbound Review

The outbound state machine is acceptable if hardened as follows:

- remove persistent disconnected-session resume from MVP
- treat sessions as process-local and command-local
- omit `session/load` from CLI

Recommended user-visible model:

- `send`: always fresh session
- `call`: one live session for the lifetime of the interactive command

### Inbound State Machine

Recommended inbound states:

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

### Adapter Crash Mid-Turn

If adapter crashes while a prompt is in flight:

- if possible, callee daemon SHOULD send JSON-RPC `-32603 Internal error` for the outstanding request
- callee daemon MUST then close the connection
- caller MUST surface this as adapter/runtime failure

### `session/cancel` Then Transport Close

If caller sends `session/cancel` and immediately loses transport:

- caller records local result as `cancel_incomplete`
- caller does not assume the remote prompt was cleanly cancelled
- since session resume is out of scope, no recovery is attempted

### Initialize Succeeds But Auth Fails

- connection state becomes `auth_failed`
- caller MUST close the transport
- no session state is persisted

### Prompt Result Arrives After Caller Decides To Close

If caller has already entered `Closing`:

- implementation MAY drop late prompt results
- implementation SHOULD log them if debug logging is enabled
- implementation MUST NOT reopen the state machine

### `disconnected` vs `closed`

Recommendation:

- remove persistent `disconnected` session state from MVP
- use `closed` as the terminal persisted state
- treat transport loss during `call` as command failure, not resumable state

### `session/load`

Hard recommendation:

- keep `session/load` implemented internally only if needed for future experiments
- do not expose it in CLI
- do not rely on it for MVP interop completeness

## 8. CLI UX Review

### `inspect`

- SHOULD NOT pin trust by default
- SHOULD display observed `peerId`
- SHOULD report whether the target came from contacts or directory

### `resolve`

- MUST never invoke directory search implicitly
- MUST use exact resolution only
- search, if added later, should be a separate command

### `call`

- SHOULD support local slash commands `/exit` and `/cancel`
- these are CLI controls, not ACP slash commands
- `/cancel` sends ACP `session/cancel` if a turn is active
- `/exit` closes the session and transport

### `send`

- SHOULD accept stdin only when message argument is exactly `-`
- SHOULD NOT implicitly read stdin when the message argument is absent
- this avoids accidental hangs and ambiguous automation behavior

### JSON Output

- `--json` SHOULD include the raw ACP `initialize` result and raw prompt result in separate fields
- normalized summaries may be included in addition, but raw protocol data is more useful for automation

Recommended shape:

```json
{
  "resolved": { "...": "..." },
  "peerId": "peer_spki_sha256_...",
  "initialize": { "...": "raw ACP initialize result ..." },
  "session": { "sessionId": "sess_..." },
  "promptResult": { "...": "raw ACP prompt result ..." },
  "aggregatedText": "..."
}
```

### JSONL Output

- `--jsonl` SHOULD emit normalized wrappers that contain raw ACP payloads
- raw ACP payloads alone are too context-poor for long-running automation

Recommended event shape:

```json
{
  "event": "session_update",
  "timestamp": "2026-03-09T00:00:00Z",
  "payload": { "... raw ACP payload ..." }
}
```

### Session Visibility

Hard recommendation:

- sessions SHOULD NOT be user-visible in MVP beyond the lifetime of the running `call`
- `send` and `call` SHOULD manage sessions internally
- no session-management CLI commands are needed for MVP

### `--no-save-session`

Not needed in MVP if sessions are not persisted across invocations.

## 9. Minimum Conformance Suite

The MVP is not complete until these tests pass end-to-end.

### Directory

- exact lookup of public name succeeds
- exact lookup of unlisted name succeeds
- search returns public names only
- search does not return unlisted names

### Trust

- successful inspect reports observed `peerId`
- saved contact with matching `pinnedPeerId` connects successfully
- saved contact with mismatched `pinnedPeerId` fails closed and warns

### Basic Calls

- successful `inspect`
- successful one-shot `send`
- successful interactive multi-turn `call`

### Policy Paths

- permission rejection path completes predictably
- permission request with no reject option triggers cancel path
- oversized prompt is rejected locally before send
- unsupported content block type is rejected locally

### Cancellation

- local cancel sends `session/cancel`
- caller continues accepting trailing updates
- prompt completes with `stopReason: cancelled`

### Adapter Failure

- invalid ACP from adapter stdout is detected and fails the connection
- adapter crash mid-turn produces the defined failure behavior

### Transport

- first non-`initialize` message is rejected
- idle initialize timeout closes connection
- prompt idle timeout triggers cancel

## 10. Final Freeze Recommendation

### Frozen MVP Changes Recommended

1. Bind `peerId` to the remote WSS TLS certificate SPKI hash.
2. Do not pin trust on `inspect` by default.
3. Remove user-visible cross-process session persistence from MVP.
4. Keep `session/load` out of the CLI until proven interoperable.
5. Allow only namespaced public and unlisted registrations at launch.

### Keep These Out Of Scope

1. raw file transfer
2. payments and billing
3. federation between directories
4. decentralized naming
5. automatic remote tool execution

### Most Dangerous Implementation Mistakes

1. treating directory metadata as runtime trust proof
2. inventing custom ACP content block types
3. allowing more than one active prompt per session
4. exposing filesystem, terminal, or MCP servers to remote peers by default
5. trying to make session resume user-visible before interop is proven
