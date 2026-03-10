import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, runCli, spawnCli, waitForExit, waitForOutput, type TestHarness } from "./support.js";

describe("ACL help UX", () => {
  it("shows root help with no command", async () => {
    const result = await runCli([], {});

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("Available Commands:");
    expect(result.stdout).toContain("resolve");
    expect(result.stdout).toContain("inspect");
    expect(result.stdout).toContain("send");
    expect(result.stdout).toContain("call");
    expect(result.stdout).toContain("mail");
    expect(result.stdout).toContain("peer");
    expect(result.stdout).toContain("registry");
    expect(result.stdout).toContain("manifest");
  });

  it("shows root help with acl help", async () => {
    const result = await runCli(["help"], {});

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("acl help [command]");
  });

  it("shows command help with acl help send", async () => {
    const result = await runCli(["help", "send"], {});

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("send - Send one prompt over a fresh ACP session");
    expect(result.stdout).toContain("acl send <target> <message>");
    expect(result.stdout).toContain("Use '-' as the message argument");
  });

  it("shows command help with --help on a subcommand", async () => {
    const result = await runCli(["resolve", "--help"], {});

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("resolve - Resolve a target by exact alias or agentId");
    expect(result.stdout).toContain("acl resolve <target>");
  });

  it("shows nested registry help", async () => {
    const result = await runCli(["help", "registry", "claim"], {});

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("registry claim - Claim a namespace");
    expect(result.stdout).toContain("acl registry claim <namespace>");
  });

  it("shows nested peer help", async () => {
    const result = await runCli(["help", "peer", "serve"], {});

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("peer serve - Run a WSS peer daemon hosting one local ACP stdio agent");
    expect(result.stdout).toContain("acl peer serve --agent-id <agentId>");
  });

  it("shows nested mail help", async () => {
    const result = await runCli(["help", "mail", "send"], {});

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mail send - Send a structured mailbox message over a fresh ACP session");
    expect(result.stdout).toContain("acl mail send <target> <body> --from <agentId>");
  });

  it("shows nested manifest help", async () => {
    const result = await runCli(["help", "manifest", "init"], {});

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("manifest init - Generate a registry manifest with sensible defaults");
    expect(result.stdout).toContain("acl manifest init <agentId>");
  });

  it("generates a manifest with defaults", async () => {
    const result = await runCli(["manifest", "init", "acme.reviewer.agent"], {});

    expect(result.exitCode).toBe(0);
    const manifest = JSON.parse(result.stdout);
    expect(manifest.agentId).toBe("acme.reviewer.agent");
    expect(manifest.displayName).toBe("Acme Reviewer");
    expect(manifest.summary).toBe("ACP agent published through ACL");
    expect(manifest.endpoints[0].url).toBe("wss://example.com/agents/acme.reviewer.agent");
    expect(manifest.visibility).toBe("public");
    expect(manifest.version).toBe("0.1.0");
  });
});

describe("ACL CLI conformance", () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("inspects a remote agent over WSS", async () => {
    const result = await runCli(["inspect", "acme.reviewer.agent"], harness.env);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("agentId: acme.reviewer.agent");
    expect(result.stdout).toContain("protocolVersion: 1");
    expect(result.stdout).toContain("peerId: peer_spki_sha256_");
  });

  it("sends a one-shot prompt", async () => {
    const result = await runCli(["send", "acme.reviewer.agent", "hello from test"], harness.env);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("Echo: hello from test");
  });

  it("rejects permission requests by default", async () => {
    const result = await runCli(["send", "acme.reviewer.agent", "[permission] please ask"], harness.env);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("Permission rejected");
  });

  it("supports interactive multi-turn call sessions", async () => {
    const child = spawnCli(["call", "acme.reviewer.agent"], harness.env);

    child.stdin.write("first turn\n");
    child.stdin.write("second turn\n");
    child.stdin.write("/exit\n");
    child.stdin.end();

    const result = await waitForExit(child);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Echo: first turn");
    expect(result.stdout).toContain("Echo: second turn");
  });

  it("cancels an active prompt and accepts trailing updates", async () => {
    const child = spawnCli(["call", "acme.reviewer.agent"], harness.env);

    child.stdin.write("[hold] cancel me\n");
    const streamedOutput = await waitForOutput(child, /Working on: \[hold\] cancel me/, "stdout");
    child.stdin.write("/cancel\n");
    child.stdin.write("/exit\n");
    child.stdin.end();

    const result = await waitForExit(child);
    const combinedStdout = `${streamedOutput}${result.stdout}`;

    expect(result.exitCode).toBe(0);
    expect(combinedStdout).toContain("Working on: [hold] cancel me");
    expect(combinedStdout).toContain("[cancel acknowledged]");
  });
});
