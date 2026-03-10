# ACL MVP Planning Documents

This directory captures the planning and architecture decisions for the ACL MVP.
It preserves the progression of the design, not just the final snapshot.

Documents:

1. `00-acp-foundation-and-layered-analysis.md`
   Initial protocol-grounded analysis of ACP as the session/call substrate and the first layered architecture.

2. `01-peer-to-peer-mvp-architecture.md`
   Simplified MVP architecture after reducing scope to the smallest practical agent-to-agent network.

3. `02-mvp-implementation-spec.md`
   Precise implementation-ready specification for the locked MVP.

4. `03-spec-hardening-review.md`
   Skeptical protocol-engineering review of the MVP spec, focused on gaps, failure modes, trust hardening, and final freeze recommendations.

5. `04-implementation-plan.md`
   Concrete build plan derived from the frozen MVP spec, including package boundaries, phases, sequencing, dependencies, and acceptance criteria.

6. `05-task-breakdown.md`
   Execution backlog derived from the frozen spec and implementation plan, organized by workstream, task dependencies, milestones, and package checklists.

Decision summary:

- ACP remains the conversation/session protocol.
- Runtime connectivity is peer-to-peer via WSS.
- The directory is naming and discovery only, never part of the runtime path.
- The transport carries raw ACP JSON-RPC frames unchanged.
- No file transfer subsystem exists in the MVP.
- Remote filesystem, terminal, and MCP server capabilities are disabled by default.
