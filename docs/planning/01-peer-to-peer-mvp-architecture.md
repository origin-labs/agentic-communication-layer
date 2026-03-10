# Peer-To-Peer MVP Architecture

## Purpose

This document records the simplified architecture that was locked for the MVP after reducing scope to the smallest practical working system.

## Locked MVP Model

The MVP separates the system into three layers:

1. Global Directory
2. Peer Layer
3. ACP Session Layer

The directory resolves names.
Peers connect to each other.
ACP runs inside the peer connection.

## Runtime Topology

```text
Directory
    |
resolve name
    |
Local Peer Daemon
    |
Peer Transport (WSS)
    |
Remote Peer Daemon
    |
ACP Agent Adapter
```

## Locked Decisions

### ACP Is Unchanged

ACP remains the conversation/session protocol.
The MVP does not add wrappers around ACP messages and does not modify ACP semantics.

### Directory Is Discovery Only

The directory is never on the runtime path.
It only answers:

- who is this agent
- where can I reach it

### Peer Transport Carries Raw ACP Frames

The peer transport is WSS in the MVP.
It carries raw ACP JSON-RPC messages unchanged.

Rules:

- one ACP JSON-RPC message per WebSocket frame
- payload is raw ACP JSON
- no ACL transport envelope
- `initialize` is always the first application message

### Identity Has Two Layers

`peerId`

- daemon-level identity
- derived from public key
- used for trust pinning
- not human-facing

`agentId`

- globally unique human-facing identifier
- directory-visible
- may be hosted by a daemon that hosts multiple agents

### No File Transfer Layer

The MVP has no raw file transfer subsystem.
Agents exchange only:

- text
- structured content encoded as text or resource text
- resource links

If a file is needed, the caller reads it locally and sends excerpts or references.

### Remote Security Defaults Are Strict

Outbound defaults:

- `fs.readTextFile = false`
- `fs.writeTextFile = false`
- `terminal = false`
- `mcpServers = []`

Permission requests are rejected by default.

## ACP Content Constraint

The MVP must not introduce custom ACP content block types.
Only these ACP-compatible content types are allowed:

- `text`
- `resource_link`
- `resource`

`resource` may only be sent if the remote agent advertised `promptCapabilities.embeddedContext`.

## What Was Explicitly Removed

- payments
- reputation
- marketplace logic
- federation
- decentralized naming
- file transfer protocol
- automatic remote tool execution
- full ecosystem control plane

## Outcome

This architecture is the minimal network needed to make agent-to-agent communication work:

1. discover by name
2. connect peer to peer
3. run ACP
4. exchange messages
