import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createHarness, runCli, spawnCli, waitForExit, type TestHarness } from "./support.js";

const harnesses: TestHarness[] = [];

async function withHarness(options?: Parameters<typeof createHarness>[0]): Promise<TestHarness> {
  const harness = await createHarness(options);
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (harness) {
      await harness.cleanup();
    }
  }
});

describe("ACL hardening conformance", () => {
  it("supports exact lookup for unlisted records", async () => {
    const harness = await withHarness({ visibility: "unlisted" });
    const result = await runCli(["resolve", "acme.reviewer.agent"], harness.env);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("agentId: acme.reviewer.agent");
  });

  it("accepts matching pinned peerId contacts", async () => {
    const harness = await withHarness();
    await harness.writeContacts([
      {
        alias: "reviewer",
        agentId: "acme.reviewer.agent",
        endpoint: {
          transport: "wss",
          url: JSON.parse(await readFile(harness.directoryPath, "utf8")).agents[0].endpoints[0].url,
          priority: 0
        },
        pinnedPeerId: harness.serverPeerId
      }
    ]);

    const result = await runCli(["send", "reviewer", "pinned ok"], harness.env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("Echo: pinned ok");
  });

  it("fails closed on pinned peerId mismatch", async () => {
    const harness = await withHarness();
    await harness.writeContacts([
      {
        alias: "reviewer",
        agentId: "acme.reviewer.agent",
        endpoint: {
          transport: "wss",
          url: JSON.parse(await readFile(harness.directoryPath, "utf8")).agents[0].endpoints[0].url,
          priority: 0
        },
        pinnedPeerId: "peer_spki_sha256_mismatch"
      }
    ]);

    const result = await runCli(["send", "reviewer", "should fail"], harness.env);
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("Pinned peerId does not match observed peerId");
  });

  it("rejects oversized prompts locally before send", async () => {
    const harness = await withHarness();
    const daemon = harness.createClientDaemon();
    const session = await daemon.openSession("acme.reviewer.agent");

    await expect(
      session.prompt([{ type: "text", text: "x".repeat(262_145) }])
    ).rejects.toMatchObject({ exitCode: 9 });

    await session.close();
  });

  it("rejects unsupported prompt content locally before send", async () => {
    const harness = await withHarness();
    const daemon = harness.createClientDaemon();
    const session = await daemon.openSession("acme.reviewer.agent");

    await expect(
      session.prompt([{ type: "image", mimeType: "image/png", data: "abc" }] as unknown as never)
    ).rejects.toMatchObject({ exitCode: 9 });

    await session.close();
  });

  it("surfaces invalid adapter stdout as a connection failure", async () => {
    const harness = await withHarness();
    const result = await runCli(["send", "acme.reviewer.agent", "[invalid-stdout] trigger"], harness.env);

    expect(result.exitCode).toBe(8);
    expect(result.stderr).toContain("Hosted agent connection failed");
  });

  it("surfaces adapter crash mid-turn", async () => {
    const harness = await withHarness();
    const result = await runCli(["send", "acme.reviewer.agent", "[crash] trigger"], harness.env);

    expect(result.exitCode).toBe(8);
    expect(result.stderr).toContain("Hosted agent connection failed");
  });

  it("cancels permission requests with no reject option", async () => {
    const harness = await withHarness();
    const result = await runCli(["send", "acme.reviewer.agent", "[permission-cancel] request"], harness.env);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain("[cancel acknowledged]");
  });

  it("emits JSONL events for send", async () => {
    const harness = await withHarness();
    const result = await runCli(["send", "acme.reviewer.agent", "jsonl event", "--jsonl"], harness.env);
    const events = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(result.exitCode).toBe(0);
    expect(events.map((entry) => entry.event)).toEqual([
      "resolved",
      "connected",
      "initialized",
      "session_opened",
      "session_update",
      "prompt_result"
    ]);
  });

  it("rejects first non-initialize inbound message", async () => {
    const harness = await withHarness();
    const directory = JSON.parse(await readFile(harness.directoryPath, "utf8"));
    const url = directory.agents[0].endpoints[0].url as string;
    const ca = await readFile(harness.env.ACL_TLS_CA_CERT, "utf8");

    const socket = new WebSocket(url, {
      ca,
      rejectUnauthorized: true
    });

    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "session/new",
        params: {
          cwd: "/",
          mcpServers: []
        }
      })
    );

    const closeCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for inbound rejection")), 5_000);
      socket.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    expect(closeCode).toBeGreaterThanOrEqual(1000);
  });

  it("emits JSONL events for call", async () => {
    const harness = await withHarness();
    const child = spawnCli(["call", "acme.reviewer.agent", "--jsonl"], harness.env);

    child.stdin.write("call jsonl\n");
    child.stdin.write("/exit\n");
    child.stdin.end();

    const result = await waitForExit(child);
    const events = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).event);

    expect(result.exitCode).toBe(0);
    expect(events).toContain("resolved");
    expect(events).toContain("connected");
    expect(events).toContain("initialized");
    expect(events).toContain("session_opened");
    expect(events).toContain("session_update");
    expect(events).toContain("prompt_result");
  });
});
