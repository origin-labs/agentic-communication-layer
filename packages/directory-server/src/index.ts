import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type AgentRecord,
  type ClaimNamespaceRequest,
  type NamespaceRecord,
  type PublishAgentRequest,
  type SearchAgentsResult,
  type VerifyNamespaceRequest
} from "@acl/acl-types";

const HANDLE_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.agent$/;
const NAMESPACE_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;

interface DirectoryState {
  version: 1;
  namespaces: NamespaceRecord[];
  agents: AgentRecord[];
}

export interface DirectoryServerHandle {
  host: string;
  port: number;
  close(): Promise<void>;
}

export interface StartDirectoryServerOptions {
  host: string;
  port: number;
  stateFilePath: string;
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload, "utf8")
  });
  response.end(payload);
}

function error(response: ServerResponse, statusCode: number, message: string, details?: unknown): void {
  json(response, statusCode, {
    error: {
      message,
      details
    }
  });
}

function normalizeNamespace(namespace: string): string {
  const normalized = namespace.trim().toLowerCase();
  if (!NAMESPACE_PATTERN.test(normalized) || normalized.endsWith(".agent")) {
    throw new Error("Namespace must be lowercase ASCII labels without the .agent suffix");
  }
  return normalized;
}

function normalizeAgentId(agentId: string): string {
  const normalized = agentId.trim().toLowerCase();
  if (!HANDLE_PATTERN.test(normalized)) {
    throw new Error("agentId must be a lowercase namespaced handle ending in .agent");
  }

  const labels = normalized.split(".");
  if (labels.length < 3) {
    throw new Error("Public and unlisted registrations must be namespaced handles");
  }

  return normalized;
}

function namespaceForAgentId(agentId: string): string {
  const labels = agentId.split(".");
  return labels.slice(0, -2).join(".");
}

function createChallenge(namespace: string): NamespaceRecord["challenge"] {
  const token = randomBytes(16).toString("hex");
  return {
    type: "dns_txt",
    name: `_acl.${namespace}`,
    value: `acl-verify-${token}`
  };
}

async function parseJsonRequest<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw) as T;
}

async function ensureStateFile(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  try {
    await readFile(filePath, "utf8");
  } catch {
    const initialState: DirectoryState = {
      version: 1,
      namespaces: [],
      agents: []
    };
    await writeFile(filePath, `${JSON.stringify(initialState, null, 2)}\n`, "utf8");
  }
}

async function loadState(filePath: string): Promise<DirectoryState> {
  await ensureStateFile(filePath);
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<DirectoryState>;
  return {
    version: 1,
    namespaces: Array.isArray(parsed.namespaces) ? parsed.namespaces : [],
    agents: Array.isArray(parsed.agents) ? parsed.agents : []
  };
}

async function saveState(filePath: string, state: DirectoryState): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function matchesSearch(record: AgentRecord, query: string): boolean {
  const haystack = [
    record.agentId,
    record.displayName,
    record.summary,
    ...record.serviceCapabilities
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function validatePublishRequest(request: PublishAgentRequest): void {
  if (typeof request.displayName !== "string" || request.displayName.trim().length === 0) {
    throw new Error("displayName is required");
  }
  if (typeof request.summary !== "string" || request.summary.trim().length === 0) {
    throw new Error("summary is required");
  }
  if (!request.protocols || !Array.isArray(request.protocols.acp) || request.protocols.acp.length === 0) {
    throw new Error("protocols.acp is required");
  }
  if (!Array.isArray(request.endpoints) || request.endpoints.length === 0) {
    throw new Error("at least one endpoint is required");
  }
  for (const endpoint of request.endpoints) {
    if (endpoint.transport !== "wss" || typeof endpoint.url !== "string" || !Number.isInteger(endpoint.priority)) {
      throw new Error("endpoints must contain valid WSS endpoint records");
    }
  }
  if (!Array.isArray(request.serviceCapabilities)) {
    throw new Error("serviceCapabilities must be an array");
  }
  if (request.visibility !== "public" && request.visibility !== "unlisted") {
    throw new Error("visibility must be public or unlisted");
  }
  if (typeof request.version !== "string" || request.version.trim().length === 0) {
    throw new Error("version is required");
  }
}

export async function startDirectoryServer(options: StartDirectoryServerOptions): Promise<DirectoryServerHandle> {
  await ensureStateFile(options.stateFilePath);

  let mutationChain = Promise.resolve();

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? `${options.host}:${options.port}`}`);
      const pathname = requestUrl.pathname;

      if (request.method === "POST" && pathname === "/v1/namespaces") {
        const body = await parseJsonRequest<ClaimNamespaceRequest>(request);
        const namespace = normalizeNamespace(body.namespace);
        if (body.verificationMethod !== "dns_txt") {
          error(response, 400, "Only dns_txt verification is supported in ACL MVP");
          return;
        }

        await (mutationChain = mutationChain.then(async () => {
          const state = await loadState(options.stateFilePath);
          if (state.namespaces.find((record) => record.namespace === namespace)) {
            error(response, 409, "Namespace already exists", { namespace });
            return;
          }

          const record: NamespaceRecord = {
            namespace,
            status: "pending",
            verificationMethod: "dns_txt",
            createdAt: new Date().toISOString(),
            challenge: createChallenge(namespace)
          };
          state.namespaces.push(record);
          await saveState(options.stateFilePath, state);
          json(response, 201, record);
        }));
        return;
      }

      const namespaceMatch = /^\/v1\/namespaces\/([^/]+)(?:\/verify)?$/.exec(pathname);
      if (namespaceMatch) {
        const namespace = normalizeNamespace(decodeURIComponent(namespaceMatch[1] ?? ""));
        const isVerify = pathname.endsWith("/verify");

        if (request.method === "GET" && !isVerify) {
          const state = await loadState(options.stateFilePath);
          const record = state.namespaces.find((entry) => entry.namespace === namespace);
          if (!record) {
            error(response, 404, "Namespace not found", { namespace });
            return;
          }
          json(response, 200, record);
          return;
        }

        if (request.method === "POST" && isVerify) {
          const body = await parseJsonRequest<VerifyNamespaceRequest>(request);
          await (mutationChain = mutationChain.then(async () => {
            const state = await loadState(options.stateFilePath);
            const record = state.namespaces.find((entry) => entry.namespace === namespace);
            if (!record) {
              error(response, 404, "Namespace not found", { namespace });
              return;
            }
            if (record.status === "verified") {
              json(response, 200, record);
              return;
            }
            if (!record.challenge || body.proof !== record.challenge.value) {
              error(response, 400, "Namespace verification proof is invalid", { namespace });
              return;
            }
            record.status = "verified";
            record.verifiedAt = new Date().toISOString();
            delete record.challenge;
            await saveState(options.stateFilePath, state);
            json(response, 200, record);
          }));
          return;
        }
      }

      const agentMatch = /^\/v1\/agents\/([^/]+)$/.exec(pathname);
      if (agentMatch) {
        const agentId = normalizeAgentId(decodeURIComponent(agentMatch[1] ?? ""));

        if (request.method === "GET") {
          const state = await loadState(options.stateFilePath);
          const record = state.agents.find((entry) => entry.agentId === agentId);
          if (!record) {
            error(response, 404, "Agent not found", { agentId });
            return;
          }
          json(response, 200, record);
          return;
        }

        if (request.method === "PUT") {
          const body = await parseJsonRequest<PublishAgentRequest>(request);
          await (mutationChain = mutationChain.then(async () => {
            validatePublishRequest(body);
            const state = await loadState(options.stateFilePath);
            const namespace = namespaceForAgentId(agentId);
            const namespaceRecord = state.namespaces.find((entry) => entry.namespace === namespace);
            if (!namespaceRecord || namespaceRecord.status !== "verified") {
              error(response, 400, "Namespace must be verified before publishing agents", { namespace, agentId });
              return;
            }

            const record: AgentRecord = {
              agentId,
              handle: agentId,
              displayName: body.displayName,
              summary: body.summary,
              protocols: body.protocols,
              endpoints: body.endpoints,
              serviceCapabilities: body.serviceCapabilities,
              visibility: body.visibility,
              version: body.version,
              updatedAt: new Date().toISOString()
            };

            const existingIndex = state.agents.findIndex((entry) => entry.agentId === agentId);
            if (existingIndex >= 0) {
              state.agents[existingIndex] = record;
            } else {
              state.agents.push(record);
            }

            await saveState(options.stateFilePath, state);
            json(response, 200, record);
          }));
          return;
        }
      }

      if (request.method === "GET" && pathname === "/v1/search") {
        const query = requestUrl.searchParams.get("q") ?? "";
        const limitValue = Number.parseInt(requestUrl.searchParams.get("limit") ?? "20", 10);
        const limit = Number.isFinite(limitValue) ? Math.min(Math.max(limitValue, 1), 100) : 20;
        const state = await loadState(options.stateFilePath);
        const results = state.agents
          .filter((entry) => entry.visibility === "public")
          .filter((entry) => (query.length > 0 ? matchesSearch(entry, query) : true))
          .slice(0, limit);

        const payload: SearchAgentsResult = {
          results,
          nextCursor: null
        };
        json(response, 200, payload);
        return;
      }

      error(response, 404, "Route not found", { method: request.method, pathname });
    } catch (caught) {
      const errorObject = caught instanceof Error ? { message: caught.message } : { message: String(caught) };
      error(response, 500, "Directory server request failed", errorObject);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Directory server did not bind to a TCP address");
  }

  return {
    host: options.host,
    port: address.port,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}
