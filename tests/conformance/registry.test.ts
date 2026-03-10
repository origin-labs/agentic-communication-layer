import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDirectoryServer, type DirectoryServerHandle } from "../../packages/directory-server/src/index.js";
import { createHarness, runCli, type TestHarness } from "./support.js";

const tempDirs: string[] = [];
const servers: DirectoryServerHandle[] = [];
const harnesses: TestHarness[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      await server.close().catch(() => undefined);
    }
  }

  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (harness) {
      await harness.cleanup().catch(() => undefined);
    }
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("ACL registry conformance", () => {
  it("claims, verifies, publishes, resolves, searches, and sends through a real directory service", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const tempDir = await mkdtemp(join(tmpdir(), "acl-registry-"));
    tempDirs.push(tempDir);
    const stateFilePath = join(tempDir, "directory-state.json");

    const server = await startDirectoryServer({
      host: "127.0.0.1",
      port: 0,
      stateFilePath
    });
    servers.push(server);

    const endpointUrl = JSON.parse(await readFile(harness.directoryPath, "utf8")).agents[0].endpoints[0].url as string;
    const manifestPath = join(tempDir, "agent.json");

    const env = {
      ...harness.env,
      ACL_DIRECTORY_URL: `http://127.0.0.1:${server.port}`
    };

    const claim = await runCli(["registry", "claim", "acme", "--json"], env);
    expect(claim.exitCode).toBe(0);
    const claimBody = JSON.parse(claim.stdout);
    expect(claimBody.namespace).toBe("acme");
    expect(claimBody.status).toBe("pending");
    expect(claimBody.challenge.value).toContain("acl-verify-");

    const verify = await runCli(["registry", "verify", "acme", claimBody.challenge.value, "--json"], env);
    expect(verify.exitCode).toBe(0);
    expect(JSON.parse(verify.stdout).status).toBe("verified");

    const manifestInit = await runCli(
      [
        "manifest",
        "init",
        "acme.reviewer.agent",
        "--display-name",
        "Acme Reviewer",
        "--summary",
        "Fixture review agent",
        "--endpoint",
        endpointUrl,
        "--capability",
        "code.review",
        "--out",
        manifestPath
      ],
      env
    );
    expect(manifestInit.exitCode).toBe(0);

    const publish = await runCli(["registry", "publish", manifestPath, "--json"], env);
    expect(publish.exitCode).toBe(0);
    expect(JSON.parse(publish.stdout).agentId).toBe("acme.reviewer.agent");

    const show = await runCli(["registry", "show", "acme.reviewer.agent", "--json"], env);
    expect(show.exitCode).toBe(0);
    expect(JSON.parse(show.stdout).displayName).toBe("Acme Reviewer");

    const search = await runCli(["registry", "search", "review", "--json"], env);
    expect(search.exitCode).toBe(0);
    expect(JSON.parse(search.stdout).results[0].agentId).toBe("acme.reviewer.agent");

    const resolve = await runCli(["resolve", "acme.reviewer.agent"], env);
    expect(resolve.exitCode).toBe(0);
    expect(resolve.stdout).toContain("source: directory");

    const send = await runCli(["send", "acme.reviewer.agent", "hello via registry"], env);
    expect(send.exitCode).toBe(0);
    expect(send.stdout.trim()).toBe("Echo: hello via registry");
  });
});
