import { execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe("ACL mailbox conformance", () => {
  it("stores sender, reply-to, subject, and body as mailbox metadata", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "acl-mailbox-"));
    tempDirs.push(tempDir);

    const tlsDir = join(tempDir, "tls");
    const mailboxPath = join(tempDir, "mailbox.jsonl");
    const directoryPath = join(tempDir, "directory.json");
    await execFileAsync("bash", [generateDevCaScript, tlsDir], {
      cwd: repoRoot
    });

    const peer = spawnCli(
      [
        "peer",
        "serve",
        "--agent-id",
        "acme.mailbox.agent",
        "--example",
        "mailbox",
        "--env",
        `ACL_MAILBOX_FILE=${mailboxPath}`,
        "--cert",
        join(tlsDir, "server.cert.pem"),
        "--key",
        join(tlsDir, "server.key.pem"),
        "--port",
        "0"
      ],
      {}
    );
    children.push(peer);

    const startup = await waitForOutput(peer, /Peer daemon listening at wss:\/\/127\.0\.0\.1:\d+\/agents\/acme\.mailbox\.agent/, "stdout");
    const endpoint = startup.match(/Peer daemon listening at (wss:\/\/127\.0\.0\.1:\d+\/agents\/acme\.mailbox\.agent)/)?.[1];
    expect(endpoint).toBeTruthy();

    await writeFile(
      directoryPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: [
            {
              agentId: "acme.mailbox.agent",
              handle: "acme.mailbox.agent",
              displayName: "Acme Mailbox",
              summary: "Structured mailbox",
              protocols: { acp: [1] },
              endpoints: [
                {
                  transport: "wss",
                  url: endpoint,
                  priority: 0
                }
              ],
              serviceCapabilities: ["mailbox"],
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

    const send = await runCli(
      [
        "mail",
        "send",
        "acme.mailbox.agent",
        "Investigate ACP alerting behavior",
        "--from",
        "codex.mailbox.agent",
        "--reply-to",
        "codex.mailbox.agent",
        "--subject",
        "ACP alerting"
      ],
      env
    );

    expect(send.exitCode).toBe(0);
    expect(send.stdout.trim()).toBe("Message stored");

    const lines = (await readFile(mailboxPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBe(1);
    const record = JSON.parse(lines[0]);
    expect(record.from).toBe("codex.mailbox.agent");
    expect(record.replyTo).toBe("codex.mailbox.agent");
    expect(record.subject).toBe("ACP alerting");
    expect(record.body).toBe("Investigate ACP alerting behavior");
    expect(record.promptText).toBe("Investigate ACP alerting behavior");
  });
});
