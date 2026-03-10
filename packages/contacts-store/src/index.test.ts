import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ContactsFile } from "@acl/acl-types";
import { JsonContactsStore } from "./index.js";

const tempDirs: string[] = [];

async function createStore(file: ContactsFile): Promise<JsonContactsStore> {
  const dir = await mkdtemp(join(tmpdir(), "acl-contacts-"));
  tempDirs.push(dir);
  const path = join(dir, "contacts.json");
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  return new JsonContactsStore(path);
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("JsonContactsStore", () => {
  it("accepts a valid frozen contacts schema", async () => {
    const store = await createStore({
      version: 1,
      contacts: [
        {
          alias: "reviewer",
          agentId: "acme.reviewer.agent",
          endpoint: {
            transport: "wss",
            url: "wss://peer.acme.dev/agents/acme.reviewer.agent",
            priority: 0
          },
          pinnedPeerId: "peer_spki_sha256_example",
          authRef: "keychain://acl/acme.reviewer.agent",
          verification: {
            source: "directory",
            verifiedAt: "2026-03-09T00:30:00Z",
            directoryUpdatedAt: "2026-03-09T00:10:00Z",
            endpointVerifiedAt: "2026-03-09T00:30:00Z"
          }
        }
      ]
    });

    const contacts = await store.loadContacts();
    expect(contacts.contacts).toHaveLength(1);
    expect(contacts.contacts[0]?.alias).toBe("reviewer");
  });

  it("rejects invalid aliases", async () => {
    const store = await createStore({
      version: 1,
      contacts: [
        {
          alias: "Reviewer",
          agentId: "acme.reviewer.agent",
          endpoint: {
            transport: "wss",
            url: "wss://peer.acme.dev/agents/acme.reviewer.agent",
            priority: 0
          }
        }
      ]
    });

    await expect(store.loadContacts()).rejects.toMatchObject({
      message: "Contacts file contacts are invalid",
      exitCode: 1
    });
  });

  it("rejects duplicate aliases", async () => {
    const store = await createStore({
      version: 1,
      contacts: [
        {
          alias: "reviewer",
          agentId: "acme.reviewer.agent",
          endpoint: {
            transport: "wss",
            url: "wss://peer.acme.dev/agents/acme.reviewer.agent",
            priority: 0
          }
        },
        {
          alias: "reviewer",
          agentId: "acme.writer.agent",
          endpoint: {
            transport: "wss",
            url: "wss://peer.acme.dev/agents/acme.writer.agent",
            priority: 1
          }
        }
      ]
    });

    await expect(store.loadContacts()).rejects.toMatchObject({
      message: "Contacts file aliases must be unique",
      exitCode: 1
    });
  });

  it("rejects duplicate agentIds", async () => {
    const store = await createStore({
      version: 1,
      contacts: [
        {
          alias: "reviewer-a",
          agentId: "acme.reviewer.agent",
          endpoint: {
            transport: "wss",
            url: "wss://peer-a.acme.dev/agents/acme.reviewer.agent",
            priority: 0
          }
        },
        {
          alias: "reviewer-b",
          agentId: "acme.reviewer.agent",
          endpoint: {
            transport: "wss",
            url: "wss://peer-b.acme.dev/agents/acme.reviewer.agent",
            priority: 1
          }
        }
      ]
    });

    await expect(store.loadContacts()).rejects.toMatchObject({
      message: "Contacts file agentIds must be unique",
      exitCode: 1
    });
  });

  it("rejects malformed verification metadata", async () => {
    const store = await createStore({
      version: 1,
      contacts: [
        {
          alias: "reviewer",
          agentId: "acme.reviewer.agent",
          endpoint: {
            transport: "wss",
            url: "wss://peer.acme.dev/agents/acme.reviewer.agent",
            priority: 0
          },
          verification: {
            source: "directory",
            verifiedAt: 123
          } as never
        }
      ]
    });

    await expect(store.loadContacts()).rejects.toMatchObject({
      message: "Contacts file contacts are invalid",
      exitCode: 1
    });
  });
});
