import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { connectWss, startWssServer } from "./index.js";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const generateDevCaScript = fileURLToPath(new URL("../../../scripts/generate-dev-ca.sh", import.meta.url));
const tempDirs: string[] = [];

async function createTlsFixture(): Promise<{
  caCertPath: string;
  certPath: string;
  keyPath: string;
  cleanup(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "acl-wss-"));
  tempDirs.push(dir);
  await execFileAsync("bash", [generateDevCaScript, dir], { cwd: repoRoot });
  return {
    caCertPath: join(dir, "ca.cert.pem"),
    certPath: join(dir, "server.cert.pem"),
    keyPath: join(dir, "server.key.pem"),
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("WSS transport heartbeat", () => {
  it("sends client ping frames", async () => {
    const tls = await createTlsFixture();
    const [cert, key] = await Promise.all([
      readFile(tls.certPath, "utf8"),
      readFile(tls.keyPath, "utf8")
    ]);

    const server = createServer({ cert, key });
    const wss = new WebSocketServer({ server });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address");
    }

    const pingReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for client ping")), 2_000);
      wss.on("connection", (socket) => {
        socket.once("ping", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    });

    const transport = await connectWss(`wss://127.0.0.1:${address.port}/agents/acme.reviewer.agent`, {
      caCertPath: tls.caCertPath,
      pingIntervalMs: 25,
      pingDeadMs: 500
    });

    await pingReceived;
    await transport.close();
    await new Promise<void>((resolve, reject) => {
      wss.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  it("fails the client transport when the server stops answering ping", async () => {
    const tls = await createTlsFixture();
    const [cert, key] = await Promise.all([
      readFile(tls.certPath, "utf8"),
      readFile(tls.keyPath, "utf8")
    ]);

    const server = createServer({ cert, key });
    const wss = new WebSocketServer({ server, autoPong: false });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address");
    }

    wss.on("connection", () => {
      // Intentionally do nothing; autoPong is disabled so the client heartbeat must fail.
    });

    const transport = await connectWss(`wss://127.0.0.1:${address.port}/agents/acme.reviewer.agent`, {
      caCertPath: tls.caCertPath,
      pingIntervalMs: 25,
      pingDeadMs: 100
    });

    await expect(transport.receiveFrame()).rejects.toMatchObject({
      message: "WSS transport heartbeat timed out"
    });

    await new Promise<void>((resolve, reject) => {
      wss.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  it("fails inbound transports when the remote client stops answering ping", async () => {
    const tls = await createTlsFixture();
    const server = await startWssServer({
      host: "127.0.0.1",
      port: 0,
      certPath: tls.certPath,
      keyPath: tls.keyPath,
      pingIntervalMs: 25,
      pingDeadMs: 100,
      async onConnection() {
        await new Promise<void>(() => undefined);
      }
    });

    const ca = await readFile(tls.caCertPath, "utf8");
    const socket = new WebSocket(`wss://127.0.0.1:${server.port}/agents/acme.reviewer.agent`, {
      ca,
      rejectUnauthorized: true,
      autoPong: false
    });

    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    const closeCode = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for server heartbeat close")), 2_000);
      socket.once("close", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    await server.close();
    expect(closeCode).toBeGreaterThanOrEqual(1000);
  });
});
