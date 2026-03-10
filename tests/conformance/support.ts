import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ContactRecord, type Visibility } from "../../packages/acl-types/src/index.js";
import { MockDirectoryClient } from "../../packages/directory-mock/src/index.js";
import { JsonContactsStore } from "../../packages/contacts-store/src/index.js";
import { PeerDaemon } from "../../packages/peer-daemon/src/index.js";
import { derivePeerIdFromCertificatePem } from "../../packages/trust/src/index.js";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureAgentPath = fileURLToPath(new URL("../fixtures/fixture-acp-agent.mjs", import.meta.url));
const generateDevCaScript = fileURLToPath(new URL("../../scripts/generate-dev-ca.sh", import.meta.url));

export interface TestHarness {
  env: Record<string, string>;
  contactsPath: string;
  directoryPath: string;
  serverPeerId: string;
  createClientDaemon(): PeerDaemon;
  writeContacts(contacts: ContactRecord[]): Promise<void>;
  cleanup(): Promise<void>;
}

export interface CliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface HarnessOptions {
  visibility?: Visibility;
  authRequired?: boolean;
}

export async function createHarness(options: HarnessOptions = {}): Promise<TestHarness> {
  const tempDir = await mkdtemp(join(tmpdir(), "acl-mvp-"));
  const tlsDir = join(tempDir, "tls");
  const contactsPath = join(tempDir, "contacts.json");
  const directoryPath = join(tempDir, "directory.json");

  await execFileAsync("bash", [generateDevCaScript, tlsDir], {
    cwd: repoRoot
  });

  await writeFile(contactsPath, `${JSON.stringify({ version: 1, contacts: [] }, null, 2)}\n`, "utf8");
  await writeFile(directoryPath, `${JSON.stringify({ version: 1, agents: [] }, null, 2)}\n`, "utf8");
  const serverPeerId = derivePeerIdFromCertificatePem(await readFile(join(tlsDir, "server.cert.pem"), "utf8"));

  const daemon = new PeerDaemon(new JsonContactsStore(contactsPath), new MockDirectoryClient(directoryPath));
  daemon.registerHostedAgent({
    agentId: "acme.reviewer.agent",
    serviceRoot: "/srv/fixture-agent",
    adapter: {
      command: process.execPath,
      args: [fixtureAgentPath],
      env: options.authRequired
        ? {
            ACL_FIXTURE_AUTH_REQUIRED: "1"
          }
        : undefined
    }
  });

  const server = await daemon.startServer({
    host: "127.0.0.1",
    port: 0,
    certPath: join(tlsDir, "server.cert.pem"),
    keyPath: join(tlsDir, "server.key.pem")
  });

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
            summary: "Fixture review agent",
            protocols: { acp: [1] },
            endpoints: [
              {
                transport: "wss",
                url: `wss://127.0.0.1:${server.port}/agents/acme.reviewer.agent`,
                priority: 0
              }
            ],
            serviceCapabilities: ["code.review"],
            visibility: options.visibility ?? "public",
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

  return {
    env: {
      ACL_CONTACTS_FILE: contactsPath,
      ACL_DIRECTORY_FIXTURE: directoryPath,
      ACL_TLS_CA_CERT: join(tlsDir, "ca.cert.pem")
    },
    contactsPath,
    directoryPath,
    serverPeerId,
    createClientDaemon() {
      return new PeerDaemon(
        new JsonContactsStore(contactsPath),
        new MockDirectoryClient(directoryPath),
        {
          transport: {
            caCertPath: join(tlsDir, "ca.cert.pem")
          }
        }
      );
    },
    async writeContacts(contacts: ContactRecord[]) {
      await writeFile(contactsPath, `${JSON.stringify({ version: 1, contacts }, null, 2)}\n`, "utf8");
    },
    async cleanup() {
      await daemon.stopServer().catch(() => undefined);
      await server.close().catch(() => undefined);
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

export async function runCli(args: string[], env: Record<string, string>, stdinText?: string): Promise<CliRunResult> {
  const child = spawn("pnpm", ["exec", "tsx", "apps/acl-cli/src/index.ts", ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  if (stdinText !== undefined) {
    child.stdin.end(stdinText);
  } else {
    child.stdin.end();
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("close", (code) => resolve(code));
  });

  return {
    stdout,
    stderr,
    exitCode
  };
}

export function spawnCli(args: string[], env: Record<string, string>): ChildProcessWithoutNullStreams {
  return spawn("pnpm", ["exec", "tsx", "apps/acl-cli/src/index.ts", ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
}

export async function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  pattern: RegExp,
  stream: "stdout" | "stderr",
  timeoutMs = 5_000
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${pattern} on ${stream}. Output: ${buffer}`));
    }, timeoutMs);

    const handler = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      if (pattern.test(buffer)) {
        cleanup();
        resolve(buffer);
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      child[stream].off("data", handler);
    };

    child[stream].on("data", handler);
  });
}

export async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<CliRunResult> {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("close", (code) => resolve(code));
  });

  return {
    stdout,
    stderr,
    exitCode
  };
}
