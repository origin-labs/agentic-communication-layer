import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type ContactRecord,
  type ContactsFile,
  type ContactsStore,
  type ResolvedTarget,
  CliError
} from "@acl/acl-types";

function isEndpointRecord(value: unknown): value is ContactRecord["endpoint"] {
  if (!value || typeof value !== "object") return false;
  const endpoint = value as Record<string, unknown>;
  return endpoint.transport === "wss" && typeof endpoint.url === "string" && typeof endpoint.priority === "number";
}

function isContactRecord(value: unknown): value is ContactRecord {
  if (!value || typeof value !== "object") return false;
  const contact = value as Record<string, unknown>;
  if (typeof contact.agentId !== "string") return false;
  if (contact.alias !== undefined && typeof contact.alias !== "string") return false;
  if (!isEndpointRecord(contact.endpoint)) return false;
  if (contact.pinnedPeerId !== undefined && typeof contact.pinnedPeerId !== "string") return false;
  if (contact.authRef !== undefined && typeof contact.authRef !== "string") return false;
  if (contact.verification !== undefined) {
    if (!contact.verification || typeof contact.verification !== "object") return false;
    const verification = contact.verification as Record<string, unknown>;
    if (verification.source !== "directory" && verification.source !== "manual") return false;
    if (typeof verification.verifiedAt !== "string") return false;
  }
  return true;
}

function validateContactsFile(value: unknown): ContactsFile {
  if (!value || typeof value !== "object") {
    throw new CliError("Contacts file is not a JSON object", 1);
  }
  const file = value as Record<string, unknown>;
  if (file.version !== 1) {
    throw new CliError("Contacts file version must be 1", 1);
  }
  if (!Array.isArray(file.contacts) || !file.contacts.every(isContactRecord)) {
    throw new CliError("Contacts file contacts are invalid", 1);
  }
  return file as unknown as ContactsFile;
}

export class JsonContactsStore implements ContactsStore {
  constructor(private readonly filePath: string) {}

  async loadContacts(): Promise<ContactsFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return validateContactsFile(JSON.parse(raw) as unknown);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return { version: 1, contacts: [] };
      }
      if (error instanceof CliError) throw error;
      throw new CliError("Failed to load contacts file", 1, error);
    }
  }

  async saveContacts(file: ContactsFile): Promise<void> {
    validateContactsFile(file);
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  }

  async resolveExact(target: string): Promise<ResolvedTarget | null> {
    const file = await this.loadContacts();
    const aliasMatch = file.contacts.find((contact) => contact.alias === target);
    if (aliasMatch) {
      return {
        source: "contact-alias",
        agentId: aliasMatch.agentId,
        endpoint: aliasMatch.endpoint,
        contact: aliasMatch
      };
    }
    const agentMatch = file.contacts.find((contact) => contact.agentId === target);
    if (!agentMatch) {
      return null;
    }
    return {
      source: "contact-agent",
      agentId: agentMatch.agentId,
      endpoint: agentMatch.endpoint,
      contact: agentMatch
    };
  }

  async updatePinnedPeerId(
    agentId: string,
    pinnedPeerId: string,
    verification?: ContactRecord["verification"]
  ): Promise<void> {
    const file = await this.loadContacts();
    const contact = file.contacts.find((entry) => entry.agentId === agentId);
    if (!contact) {
      throw new CliError(`Contact not found for ${agentId}`, 2);
    }
    contact.pinnedPeerId = pinnedPeerId;
    if (verification) {
      contact.verification = verification;
    }
    await this.saveContacts(file);
  }
}
