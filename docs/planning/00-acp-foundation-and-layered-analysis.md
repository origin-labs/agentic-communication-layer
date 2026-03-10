# ACP Foundation And Layered Analysis

## Purpose

This document records the initial protocol-driven architecture analysis before the MVP scope was simplified.
It is retained because it explains which parts of ACP are strong foundations and which concerns must live outside ACP.

## Protocol Source Of Truth

The analysis in this document is based on the local ACP documentation under `docs/`, especially:

- `docs/protocol/overview.mdx`
- `docs/protocol/initialization.mdx`
- `docs/protocol/transports.mdx`
- `docs/protocol/session-setup.mdx`
- `docs/protocol/prompt-turn.mdx`
- `docs/protocol/content.mdx`
- `docs/protocol/tool-calls.mdx`
- `docs/protocol/schema.mdx`
- `docs/protocol/extensibility.mdx`

## What ACP Solves Well

ACP already standardizes the core bilateral session protocol:

- `initialize`
- optional `authenticate`
- `session/new`
- optional `session/load`
- `session/prompt`
- `session/update`
- `session/cancel`

It also standardizes:

- JSON-RPC request/response and notification semantics
- capability negotiation during initialization
- session lifecycle rules
- prompt turn streaming via `session/update`
- permission mediation through `session/request_permission`
- extension points via `_meta` and underscore-prefixed custom methods

## What ACP Does Not Solve

ACP does not define:

- global naming
- public discovery
- private address books
- peer identity outside a specific connection
- trust pinning
- endpoint selection
- directory governance
- payments
- marketplace logic

Those concerns must sit above ACP.

## Initial Layered Architecture

The initial architecture separated the system into:

1. transport
2. ACP protocol runtime
3. session orchestration
4. identity
5. discovery
6. routing
7. policy/trust
8. future payments

This was correct structurally, but it was broader than the MVP needed.

## Key Findings

### ACP Is Directional

ACP is not a symmetric peer protocol.
For any given conversation:

- caller acts as ACP client
- callee acts as ACP agent

This is compatible with peer-to-peer networking, but not with a symmetric “both sides speak the same ACP role at once” model.

### ACP Is Transport-Agnostic

The transport docs explicitly allow custom bidirectional transports, as long as JSON-RPC message format and lifecycle semantics are preserved.
That means ACP can safely run over something other than stdio.

### Remote Safety Must Be Conservative

ACP client capabilities such as filesystem and terminal access are optional and capability-gated.
For remote agent-to-agent calls, the safe default is to advertise none of them.

### Runtime Compatibility Must Be Determined By `initialize`

Any directory or manifest data can only be advisory.
Actual compatibility must be determined through ACP initialization.

## Risks Identified At This Stage

- Building too much control-plane complexity before proving calls work
- Mixing naming, runtime transport, and session semantics into one layer
- Depending on draft ACP features for correctness
- Accidentally exposing caller-side tools to remote agents

## Outcome

This analysis established the correct role for ACP:

- ACP is the session/call substrate
- non-ACP concerns must be layered around it

The later simplified MVP architecture keeps that conclusion and removes the unnecessary outer system complexity.
