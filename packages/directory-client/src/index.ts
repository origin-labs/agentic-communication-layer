import {
  type AgentRecord,
  type ClaimNamespaceRequest,
  CliError,
  type DirectoryClient,
  type DirectoryRegistryClient,
  type NamespaceRecord,
  type PublishAgentRequest,
  type SearchAgentsResult,
  type VerifyNamespaceRequest
} from "@acl/acl-types";

interface DirectoryErrorResponse {
  error?: {
    message?: string;
    details?: unknown;
  };
}

function buildUrl(baseUrl: string, pathname: string, searchParams?: Record<string, string | undefined>): string {
  const url = new URL(pathname, baseUrl);
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    }
  }
  return url.toString();
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const text = await response.text();
    return text.length > 0 ? text : null;
  }

  return await response.json();
}

function errorExitCodeForStatus(status: number): number {
  if (status === 404) return 2;
  if (status === 400 || status === 409) return 1;
  return 8;
}

async function requestJson<T>(
  baseUrl: string,
  pathname: string,
  init: RequestInit,
  options: { allowNotFound?: boolean } = {}
): Promise<T | null> {
  let response: Response;
  try {
    response = await fetch(buildUrl(baseUrl, pathname), init);
  } catch (error) {
    throw new CliError("Directory request failed", 8, error);
  }

  if (response.status === 404 && options.allowNotFound) {
    return null;
  }

  const body = await parseResponseBody(response);
  if (!response.ok) {
    const errorBody = (body ?? {}) as DirectoryErrorResponse;
    throw new CliError(
      errorBody.error?.message ?? `Directory request failed with status ${response.status}`,
      errorExitCodeForStatus(response.status),
      errorBody.error?.details ?? body
    );
  }

  return body as T;
}

export class HttpDirectoryClient implements DirectoryRegistryClient {
  constructor(private readonly baseUrl: string) {}

  async getAgent(agentId: string): Promise<AgentRecord | null> {
    return await requestJson<AgentRecord>(this.baseUrl, `/v1/agents/${encodeURIComponent(agentId)}`, { method: "GET" }, {
      allowNotFound: true
    });
  }

  async getNamespace(namespace: string): Promise<NamespaceRecord | null> {
    return await requestJson<NamespaceRecord>(
      this.baseUrl,
      `/v1/namespaces/${encodeURIComponent(namespace)}`,
      { method: "GET" },
      { allowNotFound: true }
    );
  }

  async claimNamespace(request: ClaimNamespaceRequest): Promise<NamespaceRecord> {
    const response = await requestJson<NamespaceRecord>(this.baseUrl, "/v1/namespaces", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(request)
    });
    if (!response) {
      throw new CliError("Directory returned an empty namespace claim response", 8);
    }
    return response;
  }

  async verifyNamespace(namespace: string, request: VerifyNamespaceRequest): Promise<NamespaceRecord> {
    const response = await requestJson<NamespaceRecord>(
      this.baseUrl,
      `/v1/namespaces/${encodeURIComponent(namespace)}/verify`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(request)
      }
    );
    if (!response) {
      throw new CliError("Directory returned an empty namespace verification response", 8);
    }
    return response;
  }

  async putAgent(agentId: string, request: PublishAgentRequest): Promise<AgentRecord> {
    const response = await requestJson<AgentRecord>(this.baseUrl, `/v1/agents/${encodeURIComponent(agentId)}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(request)
    });
    if (!response) {
      throw new CliError("Directory returned an empty agent registration response", 8);
    }
    return response;
  }

  async search(query: string, limit?: number, cursor?: string): Promise<SearchAgentsResult> {
    const url = buildUrl(this.baseUrl, "/v1/search", {
      q: query,
      limit: limit !== undefined ? String(limit) : undefined,
      cursor
    });

    let searchResponse: Response;
    try {
      searchResponse = await fetch(url);
    } catch (error) {
      throw new CliError("Directory request failed", 8, error);
    }
    const body = await parseResponseBody(searchResponse);
    if (!searchResponse.ok) {
      const errorBody = (body ?? {}) as DirectoryErrorResponse;
      throw new CliError(
        errorBody.error?.message ?? `Directory request failed with status ${searchResponse.status}`,
        errorExitCodeForStatus(searchResponse.status),
        errorBody.error?.details ?? body
      );
    }

    return body as SearchAgentsResult;
  }
}

export function createHttpDirectoryClient(baseUrl: string): DirectoryRegistryClient {
  return new HttpDirectoryClient(baseUrl);
}

export type { DirectoryClient, DirectoryRegistryClient };
