import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";
import { JsonContactsStore } from "../../packages/contacts-store/src/index.js";
import { MockDirectoryClient } from "../../packages/directory-mock/src/index.js";
import { PeerDaemon } from "../../packages/peer-daemon/src/index.js";
import { createHarness, runCli, spawnCli, waitForExit, type TestHarness } from "./support.js";

const harnesses: TestHarness[] = [];
const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const generateDevCaScript = fileURLToPath(new URL("../../scripts/generate-dev-ca.sh", import.meta.url));

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

    expect(result.exitCode).toBe(7);
    expect(result.stdout.trim()).toContain("[cancel acknowledged]");
  });

  it("maps auth_required session failures to authentication exit codes", async () => {
    const harness = await withHarness({ authRequired: true });
    const result = await runCli(["send", "acme.reviewer.agent", "needs auth"], harness.env);

    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("Remote agent requires authentication");
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

  it("rejects session/new until initialize completes", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "acl-init-order-"));
    const tlsDir = join(tempDir, "tls");
    const contactsPath = join(tempDir, "contacts.json");
    const directoryPath = join(tempDir, "directory.json");

    const delayedInitAgent = String.raw`
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      let initializeFinished = false;
      function send(message) {
        process.stdout.write(JSON.stringify(message) + "\n");
      }
      rl.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.method === "initialize") {
          setTimeout(() => {
            initializeFinished = true;
            send({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: {
                  promptCapabilities: {
                    embeddedContext: true
                  }
                },
                authMethods: []
              }
            });
          }, 200);
          return;
        }
        if (message.method === "session/new") {
          send({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              sessionId: initializeFinished ? "late-session" : "early-session"
            }
          });
        }
      });
    `;

    await execFileAsync("bash", [generateDevCaScript, tlsDir], {
      cwd: repoRoot
    });

    const daemon = new PeerDaemon(
      new JsonContactsStore(contactsPath),
      new MockDirectoryClient(directoryPath)
    );

    daemon.registerHostedAgent({
      agentId: "acme.reviewer.agent",
      serviceRoot: tempDir,
      adapter: {
        command: process.execPath,
        args: ["-e", delayedInitAgent]
      }
    });

    const server = await daemon.startServer({
      host: "127.0.0.1",
      port: 0,
      certPath: join(tlsDir, "server.cert.pem"),
      keyPath: join(tlsDir, "server.key.pem")
    });

    try {
      const ca = await readFile(join(tlsDir, "ca.cert.pem"), "utf8");
      const socket = new WebSocket(`wss://127.0.0.1:${server.port}/agents/acme.reviewer.agent`, {
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
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: {
              fs: {
                readTextFile: false,
                writeTextFile: false
              },
              terminal: false
            },
            clientInfo: {
              name: "probe",
              title: "probe",
              version: "0.0.0"
            }
          }
        })
      );

      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "session/new",
          params: {
            cwd: "/",
            mcpServers: []
          }
        })
      );

      const messages = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        const received: Array<Record<string, unknown>> = [];
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Timed out waiting for initialize/session-new responses"));
        }, 2_000);

        const cleanup = () => {
          clearTimeout(timeout);
          socket.off("message", onMessage);
          socket.off("error", onError);
        };

        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };

        const onMessage = (data: RawData) => {
          received.push(JSON.parse(String(data)) as Record<string, unknown>);
          if (received.length >= 2) {
            cleanup();
            resolve(received);
          }
        };

        socket.on("message", onMessage);
        socket.on("error", onError);
      });

      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 1,
            result: expect.objectContaining({
              protocolVersion: 1
            })
          }),
          expect.objectContaining({
            id: 2,
            error: expect.objectContaining({
              message: "initialize must complete before other ACP methods"
            })
          })
        ])
      );

      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.close(1000);
      });
    } finally {
      await daemon.stopServer().catch(() => undefined);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
