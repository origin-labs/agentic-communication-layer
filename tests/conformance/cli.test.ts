import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, runCli, spawnCli, waitForExit, waitForOutput, type TestHarness } from "./support.js";

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
