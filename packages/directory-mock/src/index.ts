import { readFile } from "node:fs/promises";
import { type AgentRecord, type DirectoryClient } from "@acl/acl-types";

interface DirectoryFixture {
  version: number;
  agents: AgentRecord[];
}

export class MockDirectoryClient implements DirectoryClient {
  constructor(private readonly fixturePath: string) {}

  async getAgent(agentId: string): Promise<AgentRecord | null> {
    const raw = await readFile(this.fixturePath, "utf8");
    const fixture = JSON.parse(raw) as DirectoryFixture;
    return fixture.agents.find((record) => record.agentId === agentId) ?? null;
  }
}
