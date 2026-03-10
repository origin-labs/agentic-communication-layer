import {
  ACL_CLIENT_INFO,
  ACL_PROTOCOL_VERSION,
  CliError,
  type InitializeRequest,
  type InitializeResult,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type NewSessionRequest,
  type PromptContentBlock
} from "@acl/acl-types";

export const MAX_PROMPT_TOTAL_BYTES = 524_288;
export const MAX_TEXT_BLOCK_BYTES = 262_144;
export const MAX_RESOURCE_TEXT_BYTES = 262_144;
export const MAX_RESOURCE_LINK_URI_BYTES = 4_096;
export const MAX_PROMPT_BLOCKS = 32;
export const MAX_UPDATE_FRAME_BYTES = 262_144;
export const MAX_UPDATE_CUMULATIVE_BYTES_PER_TURN = 8_388_608;

export function buildInitializeRequest(id: string | number = 1): InitializeRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: ACL_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false
        },
        terminal: false
      },
      clientInfo: {
        ...ACL_CLIENT_INFO
      }
    }
  };
}

export function validateInitializeResponse(result: InitializeResult): InitializeResult {
  if (typeof result.protocolVersion !== "number") {
    throw new CliError("Initialize response missing protocolVersion", 4, result);
  }
  if (result.protocolVersion !== ACL_PROTOCOL_VERSION) {
    throw new CliError(`Unsupported ACP protocol version ${result.protocolVersion}`, 4, result);
  }
  return result;
}

export function enforcePromptContentBlocks(
  prompt: PromptContentBlock[],
  remoteCapabilities: InitializeResult["agentCapabilities"]
): void {
  for (const block of prompt) {
    if (block.type === "text" || block.type === "resource_link") {
      continue;
    }
    if (block.type === "resource") {
      if (!remoteCapabilities?.promptCapabilities?.embeddedContext) {
        throw new CliError("Remote agent does not advertise embeddedContext support", 9, block);
      }
      continue;
    }
    throw new CliError("Unsupported prompt content block type", 9, block);
  }
}

export function enforcePromptSizeLimits(prompt: PromptContentBlock[]): void {
  if (prompt.length > MAX_PROMPT_BLOCKS) {
    throw new CliError("Prompt exceeds maximum block count", 9, {
      maxBlocks: MAX_PROMPT_BLOCKS,
      actualBlocks: prompt.length
    });
  }

  let totalBytes = 0;

  for (const block of prompt) {
    if (block.type === "text") {
      const blockBytes = Buffer.byteLength(block.text, "utf8");
      if (blockBytes > MAX_TEXT_BLOCK_BYTES) {
        throw new CliError("Text prompt block exceeds maximum size", 9, {
          maxBytes: MAX_TEXT_BLOCK_BYTES,
          actualBytes: blockBytes
        });
      }
      totalBytes += blockBytes;
      continue;
    }

    if (block.type === "resource_link") {
      const uriBytes = Buffer.byteLength(block.uri, "utf8");
      if (uriBytes > MAX_RESOURCE_LINK_URI_BYTES) {
        throw new CliError("Resource link URI exceeds maximum size", 9, {
          maxBytes: MAX_RESOURCE_LINK_URI_BYTES,
          actualBytes: uriBytes
        });
      }
      totalBytes += uriBytes;
      totalBytes += Buffer.byteLength(block.name, "utf8");
      continue;
    }

    if (block.type === "resource") {
      const textBytes = Buffer.byteLength(block.resource.text, "utf8");
      if (textBytes > MAX_RESOURCE_TEXT_BYTES) {
        throw new CliError("Embedded resource text exceeds maximum size", 9, {
          maxBytes: MAX_RESOURCE_TEXT_BYTES,
          actualBytes: textBytes
        });
      }
      totalBytes += textBytes;
      totalBytes += Buffer.byteLength(block.resource.uri, "utf8");
      continue;
    }
  }

  if (totalBytes > MAX_PROMPT_TOTAL_BYTES) {
    throw new CliError("Prompt exceeds maximum total size", 9, {
      maxBytes: MAX_PROMPT_TOTAL_BYTES,
      actualBytes: totalBytes
    });
  }
}

export function getUtf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function buildFreshSessionParams(): { cwd: "/"; mcpServers: [] } {
  return {
    cwd: "/",
    mcpServers: []
  };
}

export function buildSessionNewRequest(id: JsonRpcId = 2): NewSessionRequest {
  if (typeof id !== "string" && typeof id !== "number") {
    throw new CliError("session/new requires a string or numeric request id", 1, id);
  }

  return {
    jsonrpc: "2.0",
    id,
    method: "session/new",
    params: buildFreshSessionParams()
  };
}

export function buildJsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown
): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data
    }
  };
}

export function assertInitializeFirst(message: unknown): void {
  if (!message || typeof message !== "object") {
    throw new CliError("First ACP message must be initialize", 4);
  }
  const method = (message as Record<string, unknown>).method;
  if (method !== "initialize") {
    throw new CliError("First ACP message must be initialize", 4, message);
  }
}

export function parseJsonRpcMessage(raw: string, exitCode: number, context: string): JsonRpcMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CliError(`Invalid ACP JSON in ${context}`, exitCode, { raw, error });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(`ACP message in ${context} must be a JSON object`, exitCode, parsed);
  }

  const message = parsed as Record<string, unknown>;
  if (message.jsonrpc !== "2.0") {
    throw new CliError(`ACP message in ${context} must use JSON-RPC 2.0`, exitCode, parsed);
  }

  return parsed as JsonRpcMessage;
}

export function isJsonRpcRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message;
}

export function isJsonRpcNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

export function isJsonRpcResponse<TResult = unknown>(message: JsonRpcMessage): message is JsonRpcResponse<TResult> {
  return "id" in message && ("result" in message || "error" in message) && !("method" in message);
}

export function isJsonRpcFailure<TResult = unknown>(message: JsonRpcResponse<TResult>): message is JsonRpcFailure {
  return "error" in message;
}
