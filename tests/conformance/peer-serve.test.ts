import { execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, spawnCli, waitForExit, waitForOutput } from "./support.js";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const generateDevCaScript = fileURLToPath(new URL("../../scripts/generate-dev-ca.sh", import.meta.url));

const tempDirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  while (children.length > 0) {
    const child = children.pop();
    if (!child) {
      continue;
    }

    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
    }
    await waitForExit(child).catch(() => undefined);
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("ACL peer serve conformance", () => {
  it("serves a hosted example agent over WSS for inspect and send", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "acl-peer-serve-"));
    tempDirs.push(tempDir);

    const tlsDir = join(tempDir, "tls");
    const directoryPath = join(tempDir, "directory.json");
    await execFileAsync("bash", [generateDevCaScript, tlsDir], {
      cwd: repoRoot
    });

    const child = spawnCli(
      [
        "peer",
        "serve",
        "--agent-id",
        "acme.reviewer.agent",
        "--example",
        "echo",
        "--cert",
        join(tlsDir, "server.cert.pem"),
        "--key",
        join(tlsDir, "server.key.pem"),
        "--port",
        "0"
      ],
      {}
    );
    children.push(child);

    const startup = await waitForOutput(child, /Peer daemon listening at wss:\/\/127\.0\.0\.1:\d+\/agents\/acme\.reviewer\.agent/, "stdout");
    const endpointMatch = startup.match(/Peer daemon listening at (wss:\/\/127\.0\.0\.1:\d+\/agents\/acme\.reviewer\.agent)/);
    expect(endpointMatch?.[1]).toBeTruthy();

    await writeFile(
      directoryPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: [
            {
              agentId: "acme.reviewer.agent",
              handle: "acme.reviewer.agent",
              displayName: "Acme Reviewer",
              summary: "Peer served example agent",
              protocols: { acp: [1] },
              endpoints: [
                {
                  transport: "wss",
                  url: endpointMatch![1],
                  priority: 0
                }
              ],
              serviceCapabilities: ["echo"],
              visibility: "public",
              version: "0.1.0",
              updatedAt: new Date().toISOString()
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const env = {
      ACL_DIRECTORY_FIXTURE: directoryPath,
      ACL_TLS_CA_CERT: join(tlsDir, "ca.cert.pem")
    };

    const inspect = await runCli(["inspect", "acme.reviewer.agent"], env);
    expect(inspect.exitCode).toBe(0);
    expect(inspect.stdout).toContain("agentId: acme.reviewer.agent");
    expect(inspect.stdout).toContain("agentInfo.name: echo-acp-agent");

    const send = await runCli(["send", "acme.reviewer.agent", "hello from served peer"], env);
    expect(send.exitCode).toBe(0);
    expect(send.stdout.trim()).toBe("Echo: hello from served peer");
  });
});
