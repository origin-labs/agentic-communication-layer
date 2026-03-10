# ACL MVP Task Breakdown

## Purpose

This document converts the frozen MVP specification and implementation plan into a concrete execution backlog.
It is intended to be implementation-oriented and directly usable for engineering task sequencing.

Source of truth:

- `planning/02-mvp-implementation-spec.md`
- `planning/04-implementation-plan.md`

Locked operational decisions reflected here:

- WSS test environments use a generated local CA
- the conformance fixture ACP agent is implemented in-repo

## 1. Workstreams

Workstreams for the ACL MVP:

1. repo scaffolding
2. shared types and interfaces
3. contacts store
4. mock directory
5. WSS transport
6. TLS / `peerId` trust
7. ACP runtime / profile enforcement
8. stdio adapter
9. peer daemon outbound path
10. peer daemon inbound path
11. CLI
12. conformance suite
13. local CA / dev tooling
14. docs / dev setup

## 2. Tasks

### WS1. Repo Scaffolding

#### ACL-001

- Title: Create repository package/module skeleton
- Scope:
  - create package/module layout from implementation plan
  - create placeholder entrypoints for all core packages
- Dependencies: none
- Definition of done:
  - repository contains all planned package roots
  - packages can be imported/referenced by name
- Suggested owner type: infra

#### ACL-002

- Title: Establish shared build/test tooling baseline
- Scope:
  - configure package build tooling
  - configure test runner baseline
  - configure formatting/lint hooks
- Dependencies: ACL-001
- Definition of done:
  - all packages can be built or typechecked in CI/dev
  - no-op test run succeeds
- Suggested owner type: infra

### WS2. Shared Types And Interfaces

#### ACL-010

- Title: Define shared core types package
- Scope:
  - shared types for `agentId`, `peerId`, contacts, directory records, errors, CLI result envelopes
- Dependencies: ACL-001
- Definition of done:
  - shared types compile
  - no concrete subsystem package redefines these canonical core shapes
- Suggested owner type: protocol

#### ACL-011

- Title: Freeze subsystem interfaces
- Scope:
  - directory interface
  - contacts store interface
  - trust interface
  - transport interface
  - ACP profile interface
  - adapter interface
  - daemon service interface
- Dependencies: ACL-010
- Definition of done:
  - interfaces are documented in code
  - downstream packages can compile against interfaces only
- Suggested owner type: protocol

### WS3. Contacts Store

#### ACL-020

- Title: Implement contacts schema validation
- Scope:
  - validate frozen contacts file structure
  - validate aliases, endpoint shape, verification metadata
- Dependencies: ACL-010, ACL-011
- Definition of done:
  - valid contacts file is accepted
  - malformed file is rejected with structured error
- Suggested owner type: protocol

#### ACL-021

- Title: Implement contacts load/store
- Scope:
  - read contacts JSON from disk
  - persist contacts JSON to disk
- Dependencies: ACL-020
- Definition of done:
  - contacts can be loaded and round-tripped without semantic drift
- Suggested owner type: infra

#### ACL-022

- Title: Implement exact contact resolution
- Scope:
  - exact alias lookup
  - exact `agentId` lookup
- Dependencies: ACL-021
- Definition of done:
  - resolution order matches spec
  - no fuzzy matching exists
- Suggested owner type: protocol

#### ACL-023

- Title: Implement trust pin persistence helpers
- Scope:
  - read/write `pinnedPeerId`
  - update verification metadata
- Dependencies: ACL-021
- Definition of done:
  - contact trust metadata can be updated atomically
- Suggested owner type: infra

### WS4. Mock Directory

#### ACL-030

- Title: Define directory record fixture format
- Scope:
  - fixture schema for exact agent record lookup
  - canonical test data layout
- Dependencies: ACL-010, ACL-011
- Definition of done:
  - fixture format validated through shared types
- Suggested owner type: protocol

#### ACL-031

- Title: Implement mock directory exact lookup
- Scope:
  - in-process mock directory backend
  - exact `agentId` lookup only
- Dependencies: ACL-030
- Definition of done:
  - exact lookup returns record or not found
  - search is absent or explicitly unimplemented
- Suggested owner type: infra

#### ACL-032

- Title: Implement directory client abstraction
- Scope:
  - clean client wrapper over directory interface
  - swappable implementation binding
- Dependencies: ACL-011, ACL-031
- Definition of done:
  - caller code depends on directory client interface, not mock directly
- Suggested owner type: protocol

### WS5. WSS Transport

#### ACL-040

- Title: Implement WSS client connection
- Scope:
  - connect to `wss://{host}/agents/{agentId}`
  - send/receive text frames
- Dependencies: ACL-011, ACL-002
- Definition of done:
  - client can open a WSS connection and exchange text frames
- Suggested owner type: infra
- Risk flag: medium

#### ACL-041

- Title: Implement WSS server listener
- Scope:
  - accept WSS connections
  - route based on endpoint path
- Dependencies: ACL-011, ACL-002
- Definition of done:
  - inbound server accepts valid endpoint paths and rejects invalid ones
- Suggested owner type: infra
- Risk flag: medium

#### ACL-042

- Title: Enforce one ACP message per text frame
- Scope:
  - frame-level send/receive helpers
  - raw ACP payload handling
- Dependencies: ACL-040, ACL-041
- Definition of done:
  - transport layer treats each received frame as exactly one ACP JSON-RPC message
  - no ACL envelope exists
- Suggested owner type: protocol
- Risk flag: high

#### ACL-043

- Title: Implement transport timeout and ping behavior
- Scope:
  - connect timeout
  - initialize start timeout
  - ping interval and dead timeout
- Dependencies: ACL-040, ACL-041
- Definition of done:
  - timeouts are configurable and enforced
- Suggested owner type: infra

### WS6. TLS / peerId Trust

#### ACL-050

- Title: Implement TLS SPKI extraction
- Scope:
  - extract leaf certificate SPKI bytes from WSS connection
- Dependencies: ACL-040, ACL-041
- Definition of done:
  - test utility can derive raw SPKI bytes from live connection
- Suggested owner type: infra
- Risk flag: high

#### ACL-051

- Title: Implement `peerId` derivation
- Scope:
  - compute `peer_spki_sha256_*` identifier from SPKI bytes
- Dependencies: ACL-050
- Definition of done:
  - deterministic `peerId` derivation matches expected fixtures
- Suggested owner type: protocol
- Risk flag: high

#### ACL-052

- Title: Implement trust pin comparison
- Scope:
  - compare observed `peerId` with stored `pinnedPeerId`
  - generate mismatch result
- Dependencies: ACL-023, ACL-051
- Definition of done:
  - match and mismatch outcomes are explicit and testable
- Suggested owner type: protocol
- Risk flag: high

#### ACL-053

- Title: Wire trust checks into outbound connection flow
- Scope:
  - expose observed `peerId`
  - enforce fail-closed behavior on mismatch
  - preserve `inspect` as observational only
- Dependencies: ACL-052, ACL-040
- Definition of done:
  - inspect shows `peerId` without pinning
  - connection to pinned contact fails on mismatch
- Suggested owner type: protocol
- Risk flag: high

### WS7. ACP Runtime / Profile Enforcement

#### ACL-060

- Title: Implement initialize ordering enforcement
- Scope:
  - require `initialize` as first application message
  - reject non-`initialize` first message inbound
- Dependencies: ACL-042
- Definition of done:
  - inbound non-`initialize` is rejected deterministically
- Suggested owner type: protocol
- Risk flag: high

#### ACL-061

- Title: Implement conservative client capability builder
- Scope:
  - generate remote-safe `initialize` request payload
- Dependencies: ACL-010, ACL-011
- Definition of done:
  - builder always emits `fs=false`, `terminal=false` profile
- Suggested owner type: protocol

#### ACL-062

- Title: Implement prompt content validation
- Scope:
  - allow only `text`, `resource_link`, and conditional `resource`
  - reject forbidden content types
- Dependencies: ACL-010, ACL-011
- Definition of done:
  - invalid content is rejected before send
- Suggested owner type: protocol

#### ACL-063

- Title: Implement `session/new` profile enforcement
- Scope:
  - enforce `cwd="/"` and `mcpServers=[]`
- Dependencies: ACL-011
- Definition of done:
  - all outbound fresh sessions match frozen profile
- Suggested owner type: protocol

#### ACL-064

- Title: Implement single-session and single-prompt enforcement
- Scope:
  - exactly one ACP session per WSS connection
  - exactly one in-flight prompt per session
- Dependencies: ACL-011, ACL-060
- Definition of done:
  - concurrent misuse is rejected locally and testably
- Suggested owner type: protocol
- Risk flag: high

#### ACL-065

- Title: Implement permission rejection algorithm
- Scope:
  - reject by default
  - choose reject option if present
  - cancel if no reject option
- Dependencies: ACL-011
- Definition of done:
  - permission request handling matches frozen policy rules
- Suggested owner type: protocol
- Risk flag: high

#### ACL-066

- Title: Implement prompt timeout and cancel handling
- Scope:
  - prompt idle timeout
  - `session/cancel`
  - trailing update acceptance
- Dependencies: ACL-064, ACL-065, ACL-043
- Definition of done:
  - idle turns are cancelled correctly
  - trailing updates are accepted until final prompt result
- Suggested owner type: protocol
- Risk flag: high

### WS8. Stdio Adapter

#### ACL-070

- Title: Implement stdio adapter process launcher
- Scope:
  - spawn local ACP agent process
  - manage stdin/stdout/stderr handles
- Dependencies: ACL-011, ACL-002
- Definition of done:
  - adapter process can be started and stopped cleanly
- Suggested owner type: infra
- Risk flag: medium

#### ACL-071

- Title: Implement ACP proxying over stdio
- Scope:
  - newline-delimited stdin writes
  - stdout reads
  - raw ACP message forwarding
- Dependencies: ACL-070
- Definition of done:
  - valid ACP message exchange works across stdio
- Suggested owner type: infra
- Risk flag: high

#### ACL-072

- Title: Implement invalid stdout detection and fatal handling
- Scope:
  - detect non-ACP or invalid JSON on stdout
  - terminate adapter and surface failure
- Dependencies: ACL-071
- Definition of done:
  - invalid stdout fails connection deterministically
- Suggested owner type: protocol
- Risk flag: high

#### ACL-073

- Title: Implement stderr logging isolation
- Scope:
  - capture stderr for logs only
  - ensure stderr never becomes ACP content
- Dependencies: ACL-070
- Definition of done:
  - stderr is observable in logs and never forwarded as protocol content
- Suggested owner type: infra
- Risk flag: high

### WS9. Peer Daemon Outbound Path

#### ACL-080

- Title: Implement exact resolution service
- Scope:
  - contacts first
  - directory exact lookup fallback
- Dependencies: ACL-022, ACL-032
- Definition of done:
  - one service returns resolved endpoint + source metadata
- Suggested owner type: protocol

#### ACL-081

- Title: Implement outbound inspect flow
- Scope:
  - resolve
  - WSS connect
  - derive `peerId`
  - initialize
  - return inspect result
- Dependencies: ACL-080, ACL-053, ACL-060, ACL-061
- Definition of done:
  - outbound inspect works end-to-end
- Suggested owner type: protocol

#### ACL-082

- Title: Implement outbound one-shot send flow
- Scope:
  - resolve
  - trust checks
  - initialize
  - authenticate if needed
  - session/new
  - session/prompt
  - collect result
  - close
- Dependencies: ACL-081, ACL-063, ACL-064, ACL-066
- Definition of done:
  - one-shot prompt completes end-to-end over WSS
- Suggested owner type: protocol
- Risk flag: high

### WS10. Peer Daemon Inbound Path

#### ACL-090

- Title: Implement hosted agent registry
- Scope:
  - register hosted `agentId` to stdio adapter config
  - route endpoint path to hosted config
- Dependencies: ACL-010, ACL-011
- Definition of done:
  - daemon can resolve inbound endpoint path to one hosted agent config
- Suggested owner type: protocol

#### ACL-091

- Title: Implement inbound WSS to adapter bridge
- Scope:
  - accept inbound WSS
  - spawn stdio adapter
  - proxy ACP traffic
- Dependencies: ACL-041, ACL-071, ACL-090
- Definition of done:
  - remote caller can reach hosted local ACP agent through daemon
- Suggested owner type: infra
- Risk flag: high

#### ACL-092

- Title: Implement inbound policy boundary
- Scope:
  - reject non-empty `mcpServers`
  - enforce content restrictions
  - enforce one session / one prompt
  - map `cwd="/"` to `serviceRoot`
- Dependencies: ACL-062, ACL-063, ACL-064, ACL-091
- Definition of done:
  - inbound daemon enforces frozen profile before forwarding to adapter
- Suggested owner type: protocol
- Risk flag: high

### WS11. CLI

#### ACL-100

- Title: Implement `acl resolve`
- Scope:
  - command parsing
  - human and JSON output
- Dependencies: ACL-080
- Definition of done:
  - exact resolution is available from CLI
- Suggested owner type: cli

#### ACL-101

- Title: Implement `acl inspect`
- Scope:
  - command parsing
  - human and JSON output
  - observational trust display
- Dependencies: ACL-081
- Definition of done:
  - inspect shows endpoint, source, `peerId`, and raw initialize data
- Suggested owner type: cli

#### ACL-102

- Title: Implement `acl send`
- Scope:
  - command parsing
  - fresh-session one-shot send
  - stdin only when message arg is `-`
  - human, JSON, and JSONL output
- Dependencies: ACL-082
- Definition of done:
  - send works for direct arg and stdin `-`
  - JSON and JSONL outputs match spec
- Suggested owner type: cli
- Risk flag: medium

#### ACL-103

- Title: Implement `acl call`
- Scope:
  - interactive REPL
  - one live session for command lifetime
  - `/exit`
  - `/cancel`
  - human and JSONL output
- Dependencies: ACL-082, ACL-066
- Definition of done:
  - multi-turn interactive flow works
- Suggested owner type: cli
- Risk flag: high

#### ACL-104

- Title: Implement exit-code mapping
- Scope:
  - map internal error classes to frozen exit codes
- Dependencies: ACL-101, ACL-102
- Definition of done:
  - CLI exits match spec for all implemented paths
- Suggested owner type: cli

### WS12. Conformance Suite

#### ACL-110

- Title: Build conformance harness skeleton
- Scope:
  - test runner scaffolding
  - fixture loading
  - daemon process lifecycle helpers
  - CLI invocation helpers
- Dependencies: ACL-002
- Definition of done:
  - test harness can launch daemons and invoke CLI commands
- Suggested owner type: test

#### ACL-111

- Title: Implement in-repo fixture ACP agent
- Scope:
  - minimal ACP agent for test scenarios
  - deterministic prompt/update behavior
  - controllable permission and crash scenarios
- Dependencies: ACL-010, ACL-011
- Definition of done:
  - fixture agent runs through stdio and supports scripted scenarios
- Suggested owner type: test
- Risk flag: high

#### ACL-112

- Title: Add exact resolution and inspect conformance tests
- Scope:
  - exact contact lookup
  - exact directory lookup
  - inspect success
  - inspect `peerId` reporting
- Dependencies: ACL-100, ACL-101, ACL-110
- Definition of done:
  - tests pass in CI
- Suggested owner type: test

#### ACL-113

- Title: Add one-shot send conformance tests
- Scope:
  - successful send
  - oversized prompt rejection
  - unsupported content rejection
- Dependencies: ACL-102, ACL-110, ACL-111
- Definition of done:
  - send-path tests pass in CI
- Suggested owner type: test

#### ACL-114

- Title: Add cancel and permission path conformance tests
- Scope:
  - permission rejection
  - cancel path
  - trailing update acceptance
- Dependencies: ACL-065, ACL-066, ACL-103, ACL-110, ACL-111
- Definition of done:
  - cancel/permission tests pass in CI
- Suggested owner type: test
- Risk flag: high

#### ACL-115

- Title: Add adapter failure conformance tests
- Scope:
  - invalid stdout
  - adapter crash mid-turn
- Dependencies: ACL-072, ACL-091, ACL-110, ACL-111
- Definition of done:
  - adapter failure behaviors are covered in CI
- Suggested owner type: test
- Risk flag: high

#### ACL-116

- Title: Add trust pin conformance tests
- Scope:
  - matching pin success
  - mismatched pin fail-closed warning
- Dependencies: ACL-053, ACL-110
- Definition of done:
  - trust pin tests pass in CI
- Suggested owner type: test
- Risk flag: high

### WS13. Local CA / Dev Tooling

#### ACL-120

- Title: Implement local CA generation tooling
- Scope:
  - generate development CA
  - issue test leaf certs for WSS endpoints
- Dependencies: ACL-002
- Definition of done:
  - local dev and CI can generate trusted test certs through one repeatable flow
- Suggested owner type: infra
- Risk flag: medium

#### ACL-121

- Title: Wire local CA into test environment bootstrap
- Scope:
  - trust generated CA in test harness
  - provision certs for fixture daemons
- Dependencies: ACL-120, ACL-110
- Definition of done:
  - conformance tests run with generated local CA-backed WSS
- Suggested owner type: infra

### WS14. Docs / Dev Setup

#### ACL-130

- Title: Write developer setup guide for local CA and fixture environment
- Scope:
  - local CA generation
  - running mock directory fixtures
  - launching local daemons and fixture agents
- Dependencies: ACL-120, ACL-121
- Definition of done:
  - new developer can reproduce local test environment from docs
- Suggested owner type: docs

#### ACL-131

- Title: Write implementation notes for frozen MVP boundaries
- Scope:
  - exact resolution only
  - no search in runtime
  - no session/load in CLI
  - no file transfer
  - remote-safe defaults
- Dependencies: ACL-011
- Definition of done:
  - engineering notes exist to prevent scope drift during implementation
- Suggested owner type: docs

## 3. Execution Order

### Strict Dependency Order

Phase order:

1. ACL-001 -> ACL-002
2. ACL-010 -> ACL-011
3. ACL-020 -> ACL-021 -> ACL-022 -> ACL-023
4. ACL-030 -> ACL-031 -> ACL-032
5. ACL-040 + ACL-041 -> ACL-042 + ACL-043
6. ACL-050 -> ACL-051 -> ACL-052 -> ACL-053
7. ACL-060 + ACL-061 + ACL-062 + ACL-063 -> ACL-064 -> ACL-065 -> ACL-066
8. ACL-070 -> ACL-071 -> ACL-072 + ACL-073
9. ACL-090 -> ACL-091 -> ACL-092
10. ACL-080 -> ACL-081 -> ACL-082
11. ACL-100 -> ACL-101 -> ACL-102 -> ACL-103 -> ACL-104
12. ACL-110 -> ACL-111 -> ACL-112 -> ACL-113 -> ACL-114 -> ACL-115 -> ACL-116
13. ACL-120 -> ACL-121
14. ACL-130 + ACL-131

### What Can Run In Parallel

After ACL-011:

- ACL-020 through ACL-023
- ACL-030 through ACL-032
- ACL-040 and ACL-041
- ACL-120

After ACL-042 and ACL-011:

- ACL-050 through ACL-053
- ACL-060 through ACL-066
- ACL-070 through ACL-073
- ACL-110

After first stable daemon core interfaces:

- CLI work can begin in parallel with test harness

### What Must Wait

- ACL-082 `send` must wait for:
  - resolution
  - trust
  - transport
  - ACP profile core
- ACL-091 inbound bridge must wait for:
  - WSS server
  - stdio adapter
  - hosted agent registry
- ACL-103 `call` must wait for:
  - stable `send`
  - timeout/cancel handling

## 4. Thin Vertical Slice, Stabilization Slice, Completion Slice

### First Thin Vertical Slice

Goal:

- exact resolution -> WSS connect -> `peerId` derivation -> initialize -> session/new -> session/prompt -> response

Tasks:

- ACL-001
- ACL-002
- ACL-010
- ACL-011
- ACL-020
- ACL-021
- ACL-022
- ACL-030
- ACL-031
- ACL-032
- ACL-040
- ACL-041
- ACL-042
- ACL-050
- ACL-051
- ACL-060
- ACL-061
- ACL-063
- ACL-070
- ACL-071
- ACL-090
- ACL-091
- ACL-080
- ACL-081
- ACL-082
- ACL-100
- ACL-101
- ACL-102

Output:

- first successful `acl send`

### Second Stabilization Slice

Goal:

- harden the protocol profile and runtime boundaries

Tasks:

- ACL-023
- ACL-043
- ACL-052
- ACL-053
- ACL-062
- ACL-064
- ACL-065
- ACL-066
- ACL-072
- ACL-073
- ACL-092
- ACL-104
- ACL-120
- ACL-121

Output:

- trust mismatch fail-closed
- invalid adapter stdout handling
- prompt cancel and permission rejection behavior

### Conformance / Completion Slice

Goal:

- interactive CLI and full MVP conformance

Tasks:

- ACL-103
- ACL-110
- ACL-111
- ACL-112
- ACL-113
- ACL-114
- ACL-115
- ACL-116
- ACL-130
- ACL-131

Output:

- complete MVP conformance suite
- interactive `acl call`
- stable developer setup docs

## 5. Per-Package Checklists

### `packages/acl-types`

- ACL-010
- ACL-011

Checklist:

- core type definitions
- directory record types
- contact types
- trust types
- CLI result envelope types
- error class taxonomy types

### `packages/contacts-store`

- ACL-020
- ACL-021
- ACL-022
- ACL-023

Checklist:

- schema validation
- load/store
- exact alias lookup
- exact `agentId` lookup
- trust metadata update helpers

### `packages/directory-client`

- ACL-032

Checklist:

- exact lookup interface
- implementation binding surface

### `packages/directory-mock`

- ACL-030
- ACL-031

Checklist:

- fixture loader
- exact `agentId` lookup
- deterministic not-found behavior

### `packages/transport-wss`

- ACL-040
- ACL-041
- ACL-042
- ACL-043
- ACL-050

Checklist:

- client connect
- server listen
- frame I/O
- timeouts
- ping/pong
- SPKI extraction hook

### `packages/trust`

- ACL-051
- ACL-052
- ACL-053

Checklist:

- `peerId` derivation
- pin comparison
- mismatch result model
- inspect-only observational mode

### `packages/acp-profile`

- ACL-060
- ACL-061
- ACL-062
- ACL-063
- ACL-064
- ACL-065
- ACL-066

Checklist:

- initialize-first enforcement
- remote-safe client capability builder
- prompt validator
- session/new profile enforcement
- concurrency rules
- permission rejection handling
- timeout/cancel handling

### `packages/adapter-stdio`

- ACL-070
- ACL-071
- ACL-072
- ACL-073

Checklist:

- process launcher
- stdout ACP reader
- stdin ACP writer
- stderr logger
- invalid stdout kill path

### `packages/peer-daemon`

- ACL-080
- ACL-081
- ACL-082
- ACL-090
- ACL-091
- ACL-092

Checklist:

- outbound resolution orchestration
- outbound inspect flow
- outbound send flow
- hosted agent registry
- inbound WSS to adapter bridge
- inbound profile boundary enforcement

### `packages/cli-output`

- supports ACL-100 through ACL-104

Checklist:

- human formatter
- JSON formatter
- JSONL event formatter
- raw ACP payload embedding in JSON/JSONL

### `apps/acl-cli`

- ACL-100
- ACL-101
- ACL-102
- ACL-103
- ACL-104

Checklist:

- command parsing
- exact resolution behavior
- observational inspect behavior
- stdin `-` handling for send
- interactive REPL for call
- `/exit` and `/cancel`
- exit code mapping

### `tests/conformance`

- ACL-110
- ACL-111
- ACL-112
- ACL-113
- ACL-114
- ACL-115
- ACL-116

Checklist:

- harness scaffolding
- in-repo fixture agent
- inspect tests
- send tests
- call tests
- cancel tests
- permission tests
- trust pin tests
- adapter failure tests

### `tests/integration`

- consume outputs from conformance tasks as broader scenario tests

### `tests/fixtures`

- directory records
- cert fixtures or CA bootstrap templates
- fixture ACP agent scenarios

## 6. Risk Flags

Highest integration risk tasks:

- ACL-042
  - one ACP message per frame enforcement
  - Risk: framing mismatch or hidden envelopes

- ACL-050 / ACL-051 / ACL-053
  - TLS SPKI extraction and `peerId` derivation
  - Risk: platform-specific certificate handling bugs

- ACL-060 / ACL-064 / ACL-066
  - ACP initialize ordering, concurrency, and cancel semantics
  - Risk: subtle protocol-state bugs

- ACL-071 / ACL-072 / ACL-073
  - stdio framing and stdout/stderr separation
  - Risk: hosted agents writing non-protocol output to stdout

- ACL-065
  - permission rejection path
  - Risk: remote agent expects option semantics that local policy mishandles

- ACL-082 / ACL-091 / ACL-092
  - end-to-end daemon orchestration
  - Risk: integration races across transport, ACP, and adapter boundaries

- ACL-114 / ACL-115 / ACL-116
  - conformance around cancel, adapter failures, and trust pins
  - Risk: implementation behavior diverges from spec under stress

## 7. Milestone Grouping

### M0 Foundation

Tasks:

- ACL-001
- ACL-002
- ACL-010
- ACL-011
- ACL-020
- ACL-021
- ACL-022
- ACL-023
- ACL-030
- ACL-031
- ACL-032
- ACL-120

Outcome:

- repository, interfaces, contacts, mock directory, and local CA tooling ready

### M1 First End-To-End Send

Tasks:

- ACL-040
- ACL-041
- ACL-042
- ACL-050
- ACL-051
- ACL-060
- ACL-061
- ACL-063
- ACL-070
- ACL-071
- ACL-080
- ACL-081
- ACL-082
- ACL-090
- ACL-091
- ACL-100
- ACL-101
- ACL-102

Outcome:

- first successful end-to-end `acl send`

### M2 Inbound/Outbound Hardening

Tasks:

- ACL-043
- ACL-052
- ACL-053
- ACL-062
- ACL-064
- ACL-065
- ACL-066
- ACL-072
- ACL-073
- ACL-092
- ACL-104

Outcome:

- trust pin enforcement
- content restrictions
- cancel and permission handling
- adapter failure handling

### M3 CLI Polish + Conformance

Tasks:

- ACL-103
- ACL-110
- ACL-111
- ACL-112
- ACL-113
- ACL-114
- ACL-115
- ACL-116
- ACL-121
- ACL-130
- ACL-131

Outcome:

- interactive CLI
- full conformance suite
- stable dev/test setup docs

## 8. Suggested Immediate Next Coding Target

Recommended first coding sequence:

1. ACL-001 create repository skeleton
2. ACL-010 define shared core types
3. ACL-011 freeze subsystem interfaces
4. ACL-020 through ACL-022 implement contacts validation and exact resolution
5. ACL-030 through ACL-032 implement mock directory exact lookup
6. ACL-040 implement WSS client connect
7. ACL-041 implement WSS server listener
8. ACL-050 and ACL-051 implement SPKI extraction and `peerId` derivation
9. ACL-060 implement initialize-first enforcement
10. ACL-061 implement conservative client capability builder
11. ACL-063 implement `session/new` profile enforcement
12. ACL-070 and ACL-071 implement stdio adapter spawn and ACP proxying
13. ACL-090 and ACL-091 implement hosted agent routing and inbound bridge
14. ACL-080 and ACL-081 implement outbound resolve + inspect flow
15. ACL-082 implement outbound one-shot send flow
16. ACL-100 through ACL-102 expose `resolve`, `inspect`, and `send` in CLI

The immediate end-state target is:

- exact resolution
- WSS connect
- `peerId` derivation
- ACP `initialize`
- ACP `session/new`
- ACP `session/prompt`
- final response returned through `acl send`

Do not start `acl call`, search, or broader conformance work until this path is working reliably.
