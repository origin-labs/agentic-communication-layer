# ACL MVP Implementation Plan

## Purpose

This document translates the frozen MVP specification into an executable build plan.
The frozen specification in `planning/02-mvp-implementation-spec.md` is the source of truth.

This plan defines:

- repository and package boundaries
- core interfaces
- phased implementation order
- deliverables and milestones
- dependencies between subsystems
- acceptance criteria
- risks
- what can be parallelized
- what must wait until after the first successful end-to-end call

## Planning Constraints

Locked implementation constraints:

- the first implementation pass uses a stub/mock directory with exact lookup only
- the directory must sit behind a clean interface so a real service can replace it later
- transport-level bearer auth is not required in the first implementation pass
- the first pass trust model is TLS validation + `peerId` derivation from TLS SPKI + trust pinning
- the local contacts schema is frozen now and must be implemented as specified

## Recommended Order Of Implementation

Build in this order:

1. shared types and interfaces
2. contacts store
3. mock directory exact lookup
4. WSS transport and `peerId` derivation
5. ACP runtime/profile enforcement
6. stdio adapter
7. peer daemon orchestration
8. CLI `resolve` and `inspect`
9. CLI `send`
10. CLI `call`
11. conformance suite and hardening

This order is intentional:

- resolution and trust must exist before transport can be consumed safely
- transport must exist before ACP can be exercised remotely
- ACP enforcement must exist before adapters are exposed
- stdio hosting must exist before inbound peer-to-peer calls work
- `send` should be the first end-to-end success target
- `call` should come after one-shot calls are stable

## What Must Be Built First

- canonical data types
- core interfaces
- contacts schema and persistence
- mock directory exact lookup
- WSS client/server transport
- `peerId` derivation and trust pin comparison

Without these, no end-to-end remote call can be made safely.

## What Can Be Parallelized

Parallel workstreams after interfaces freeze:

- contacts store implementation
- mock directory implementation
- WSS transport implementation
- CLI shell and output rendering skeleton
- conformance harness skeleton

Parallel workstreams after ACP profile interface freezes:

- outbound ACP runtime
- inbound adapter proxy
- policy engine

## What Should Be Deferred Until After First End-To-End Working Call

- interactive `acl call`
- richer CLI UX polish
- search implementation in the directory service
- persistence beyond the lifetime of a single CLI command
- any real directory service deployment concerns

The first successful end-to-end milestone should be:

- `acl send <target> <message>` against a hosted local agent through two peer daemons over WSS

## 1. Repository / Package Layout

Recommended repository layout:

```text
/
  planning/
  packages/
    acl-types/
    contacts-store/
    directory-client/
    directory-mock/
    trust/
    transport-wss/
    acp-profile/
    adapter-stdio/
    peer-daemon/
    cli-output/
  apps/
    acl-cli/
  tests/
    fixtures/
    conformance/
    integration/
```

Package responsibilities:

- `acl-types`
  - shared schemas, enums, error classes, config shapes
- `contacts-store`
  - local contacts file loading, validation, writing, exact matching
- `directory-client`
  - interface for exact agent lookup
- `directory-mock`
  - first-pass stub/mock directory backend implementing exact lookup only
- `trust`
  - TLS SPKI extraction, `peerId` derivation, pin comparison
- `transport-wss`
  - WSS client/server transport, frame I/O, timeout handling
- `acp-profile`
  - ACP message validation, ordering enforcement, content restrictions, timeout logic
- `adapter-stdio`
  - stdio process management, ACP proxying to hosted agent
- `peer-daemon`
  - orchestration layer joining resolution, trust, transport, ACP runtime, adapter routing, and policy
- `cli-output`
  - human output, `--json`, `--jsonl`
- `apps/acl-cli`
  - command entrypoints and wiring
- `tests/conformance`
  - MVP conformance suite

Implementation note:

- These are logical package boundaries.
- If the implementation language prefers modules over packages, the same boundaries SHOULD still be preserved.

## 2. Core Interfaces

These interfaces should be frozen before feature implementation begins.

### 2.1 Directory Interface

Required in first pass:

- `getAgent(agentId) -> AgentRecord | NotFound`

Deferred but reserved:

- `search(query, cursor, limit) -> SearchResult`

Rules:

- first pass implementation MUST support exact lookup only
- callers MUST NOT depend on search

### 2.2 Contacts Store Interface

- `loadContacts() -> ContactsFile`
- `resolveExact(target) -> Contact | None`
- `saveContact(contact) -> void`
- `updatePinnedPeerId(agentId, peerId) -> void`

### 2.3 Trust Interface

- `derivePeerIdFromTls(connection) -> PeerId`
- `comparePin(expected, observed) -> MatchResult`

### 2.4 Transport Interface

- `connect(url, timeouts) -> Connection`
- `listen(bindConfig) -> Listener`
- `sendFrame(text) -> void`
- `recvFrame() -> text`
- `close() -> void`
- `peerIdentity() -> PeerId`

### 2.5 ACP Profile Interface

- `validateOutgoingInitialize(request) -> ok | error`
- `validateIncomingInitializeResponse(response) -> ok | error`
- `validateOutgoingPrompt(prompt, remoteCapabilities) -> ok | error`
- `enforceSingleSession(connectionState) -> ok | error`
- `enforceSinglePrompt(sessionState) -> ok | error`
- `handlePermissionRequest(request, policy) -> response`
- `handleTimeouts(state, clock) -> action`

### 2.6 Adapter Interface

- `open(hostedAgentConfig) -> AdapterConnection`
- `send(messageText) -> void`
- `recv() -> messageText`
- `close() -> void`
- `kill() -> void`
- `onExit() -> ExitStatus`

### 2.7 Peer Daemon Service Interface

- `resolveTarget(target) -> ResolvedTarget`
- `inspect(target) -> InspectResult`
- `send(target, prompt) -> SendResult`
- `call(target) -> InteractiveSessionHandle`

## 3. First-Pass Mock Directory Design

## Objective

Provide exact `agentId` lookup behind a stable interface so the rest of the system can be built without depending on a real directory service.

## Design

The first-pass mock directory SHOULD be a local in-process component backed by static JSON fixtures.

Recommended fixture format:

```json
{
  "version": 1,
  "agents": [
    {
      "agentId": "acme.reviewer.agent",
      "handle": "acme.reviewer.agent",
      "displayName": "Acme Reviewer",
      "summary": "Architecture and code review agent",
      "protocols": { "acp": [1] },
      "endpoints": [
        {
          "transport": "wss",
          "url": "wss://127.0.0.1:7443/agents/acme.reviewer.agent",
          "priority": 0
        }
      ],
      "serviceCapabilities": ["code.review"],
      "visibility": "public",
      "version": "0.1.0",
      "updatedAt": "2026-03-09T00:00:00Z"
    }
  ]
}
```

First-pass behavior:

- exact `agentId` lookup only
- no search path used by runtime
- no namespace registration flow required for first pass
- no HTTP service required in first pass

Replacement boundary:

- `directory-client` MUST depend only on the directory interface
- `directory-mock` MUST be swappable with a real remote client later

## 4. Peer Daemon Implementation Order

The daemon should be built in layers.

1. minimal outbound orchestrator
2. minimal inbound listener
3. adapter routing
4. policy enforcement hooks
5. CLI service wiring

This keeps the first end-to-end target narrow:

- outbound exact resolve
- WSS connect
- ACP initialize
- session/new
- session/prompt
- result

## 5. WSS Transport Implementation Order

1. WSS client connect
2. TLS validation
3. SPKI extraction and `peerId` derivation
4. single-frame send/receive
5. WSS server listener
6. path routing to `agentId`
7. timeout and ping management

Build client first, then server.

Reason:

- `acl inspect` and `acl send` need client transport first
- inbound hosting depends on listener and routing, which can come second

## 6. ACP Runtime / Client Enforcement Layer

Build this before exposing hosted agents to arbitrary inbound traffic.

Implementation order:

1. initialize request/response validation
2. conservative client capability builder
3. exact session/new profile with `cwd="/"` and `mcpServers=[]`
4. prompt content validation
5. single-session and single-prompt enforcement
6. permission rejection handling
7. cancel path and timeout handling

The ACP layer should be transport-agnostic and operate on raw ACP JSON-RPC messages.

## 7. Stdio Adapter Implementation

Implementation order:

1. spawn process
2. stdin writer
3. stdout reader
4. stderr logger
5. fatal invalid-stdout handling
6. lifecycle termination and crash reporting
7. `serviceRoot` mapping support in daemon boundary

The stdio adapter is required for inbound peer daemon hosting.
It is not required for the first outbound-only transport tests, but it is required for the first real end-to-end cross-peer call.

## 8. CLI Implementation Order

Implement commands in this order:

1. `acl resolve`
2. `acl inspect`
3. `acl send`
4. `acl call`

Reason:

- `resolve` validates contacts + directory integration
- `inspect` validates resolution + trust + transport + initialize
- `send` validates the first full end-to-end ACP turn
- `call` adds REPL and cancel complexity last

Output modes order:

1. human-readable output
2. `--json`
3. `--jsonl`

`--jsonl` should be added only after stable internal event boundaries exist.

## 9. Contacts Store Implementation

The contacts schema is frozen and must be implemented now.

Implementation order:

1. JSON schema validation
2. load/store
3. exact alias resolution
4. exact `agentId` resolution
5. pin read/write
6. verification metadata persistence

The contacts store must be available before:

- trust pin enforcement
- stable `resolve`
- stable `inspect`

## 10. Conformance Test Implementation Order

Build the conformance harness early, but enable cases progressively.

Recommended order:

1. fixture format and test harness skeleton
2. exact resolve tests
3. inspect tests
4. send tests
5. call tests
6. policy rejection tests
7. cancel tests
8. adapter invalid stdout tests
9. adapter crash tests
10. trust pin mismatch tests

The test harness should support:

- launching two peer daemons locally
- launching fixture ACP agents through stdio adapters
- driving CLI commands
- asserting JSON and JSONL output

## Phase Plan

## Phase 0: Foundation And Interface Freeze

### Objective

Freeze package boundaries, shared types, and core interfaces before implementation branches diverge.

### Deliverables

- repository skeleton
- `acl-types` package
- interface definitions for:
  - directory
  - contacts
  - trust
  - transport
  - ACP profile
  - adapter
  - peer daemon service

### Dependencies

- frozen MVP spec

### Acceptance Criteria

- all implementation packages compile against shared interfaces
- no package depends on concrete implementations from another package when an interface exists

### Risks

- leaking transport details into ACP layer
- leaking CLI concerns into daemon core

## Phase 1: Contacts Store And Mock Directory

### Objective

Implement exact target resolution with no network dependency on a real directory service.

### Deliverables

- `contacts-store`
- `directory-client` interface binding
- `directory-mock`
- exact lookup fixture data
- `acl resolve`

### Dependencies

- Phase 0

### Acceptance Criteria

- exact alias resolution works
- exact `agentId` resolution works
- unresolved targets fail deterministically
- no code path depends on search

### Risks

- implicit fuzzy resolution creeping in
- contacts schema drift from frozen spec

## Phase 2: WSS Transport And Trust

### Objective

Implement secure peer-to-peer transport with `peerId` derivation and trust pin enforcement.

### Deliverables

- `transport-wss` client
- `transport-wss` server
- TLS validation
- SPKI extraction
- `peerId` derivation
- trust pin comparison
- `acl inspect`

### Dependencies

- Phase 0
- Phase 1 for target endpoints

### Acceptance Criteria

- WSS client can connect to a local test server
- observed `peerId` is derived and exposed
- `inspect` shows endpoint and `peerId`
- pin mismatch fails closed

### Risks

- certificate handling portability issues
- incorrect SPKI hashing implementation

## Phase 3: ACP Profile Enforcement Layer

### Objective

Implement the ACL-specific ACP runtime profile and enforcement logic.

### Deliverables

- initialize ordering enforcement
- conservative client capability builder
- prompt content validation
- `session/new` profile enforcement
- single-session enforcement
- single-prompt enforcement
- timeout and cancel logic
- permission rejection logic

### Dependencies

- Phase 0
- Phase 2 transport I/O

### Acceptance Criteria

- initialize must be first
- invalid content types are rejected locally
- second prompt while first is active is rejected locally
- prompt idle timeout produces `session/cancel`

### Risks

- mixing transport state and ACP state
- mishandling trailing updates after cancel

## Phase 4: Stdio Adapter

### Objective

Implement the local hosted-agent boundary for inbound calls.

### Deliverables

- stdio process launcher
- stdin/stdout ACP proxying
- stderr logging
- invalid stdout detection
- adapter crash reporting

### Dependencies

- Phase 0

### Acceptance Criteria

- adapter can proxy valid ACP traffic
- invalid ACP on stdout is fatal
- adapter exit mid-turn is surfaced correctly

### Risks

- process cleanup leaks
- newline framing mismatch with agent implementations

## Phase 5: Peer Daemon End-To-End Core

### Objective

Wire resolution, trust, transport, ACP profile, and adapter hosting into a single daemon.

### Deliverables

- outbound orchestrator
- inbound listener
- endpoint router
- hosted agent registry
- `serviceRoot` mapping behavior
- first end-to-end remote call path

### Dependencies

- Phase 1
- Phase 2
- Phase 3
- Phase 4

### Acceptance Criteria

- two local daemons can talk over WSS
- one daemon can route inbound connection to a hosted stdio ACP agent
- a one-shot prompt can complete successfully over the full path

### Risks

- orchestration races between daemon, transport, and adapter
- unclear failure propagation on mid-turn crashes

## Phase 6: CLI `send` And Output Modes

### Objective

Ship the first operator-usable remote call flow.

### Deliverables

- `acl send`
- human output
- `--json`
- initial `--jsonl` event model
- stable exit-code mapping

### Dependencies

- Phase 5

### Acceptance Criteria

- `acl send` performs exact resolution, inspect-grade trust checks, one fresh session, one prompt, and close
- `--json` includes raw initialize and prompt result payloads
- stdin is only read when message argument is `-`

### Risks

- output format churn before event model stabilizes
- poor separation between user-facing and machine-facing output

## Phase 7: CLI `call`, Policy Hardening, And Conformance

### Objective

Add the interactive session mode and complete MVP conformance validation.

### Deliverables

- `acl call`
- `/exit`
- `/cancel`
- full policy enforcement integration
- conformance suite

### Dependencies

- Phase 6

### Acceptance Criteria

- interactive multi-turn call works
- cancel path works
- permission rejection path works
- all MVP conformance tests pass

### Risks

- REPL control handling colliding with ordinary prompt text
- state machine bugs surfacing only under repeated turns

## Milestones

### Milestone A: Local Resolution Ready

Reached when:

- interfaces are frozen
- contacts store works
- mock directory exact lookup works
- `acl resolve` works

### Milestone B: Transport And Trust Ready

Reached when:

- WSS connect works
- TLS validation works
- `peerId` derivation works
- `acl inspect` works

### Milestone C: First End-To-End Working Call

Reached when:

- two daemons communicate over WSS
- inbound daemon routes to stdio adapter
- outbound daemon completes `initialize -> session/new -> session/prompt`
- `acl send` succeeds once end-to-end

This is the most important early milestone.

### Milestone D: MVP Complete

Reached when:

- `acl call` works
- policy engine rules are enforced
- conformance suite passes

## Parallelization Guidance

Can be parallelized after Phase 0:

- contacts store
- mock directory
- WSS transport
- trust utilities
- CLI shell scaffolding

Can be parallelized after Phase 2:

- ACP profile layer
- adapter implementation
- conformance harness skeleton

Should not be parallelized too early:

- full daemon orchestration
- interactive CLI
- policy engine final behavior

Those parts depend heavily on stable interfaces and transport behavior.

## Recommended First End-To-End Slice

The recommended thin vertical slice is:

1. mock directory exact lookup
2. contacts exact resolution
3. WSS client/server with TLS
4. `peerId` derivation
5. minimal ACP initialize/new/prompt flow
6. stdio adapter hosting a fixture ACP agent
7. `acl send`

Do not build `acl call` before this slice works.

## Deferred Until After First End-To-End Working Call

- `acl call`
- JSONL output polish
- full policy limit enforcement
- all adapter failure edge paths
- optional future real directory client implementation

## Risks Summary

Highest-risk implementation areas:

- incorrect trust binding between TLS and `peerId`
- leaking more than one session or prompt onto one connection
- invalid ACP framing between WSS and stdio
- race conditions around cancel and trailing updates
- allowing implementation shortcuts to bypass the frozen contacts schema

## Completion Standard

Implementation should be considered ready for MVP freeze only when:

- Milestone C is achieved
- then Phase 7 conformance passes without broad spec changes

If the first end-to-end call requires spec changes, fix the implementation unless the frozen spec is provably impossible to satisfy.
