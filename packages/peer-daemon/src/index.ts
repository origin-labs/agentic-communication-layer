import {
  assertInitializeFirst,
  buildFreshSessionParams,
  buildInitializeRequest,
  buildJsonRpcError,
  enforcePromptContentBlocks,
  isJsonRpcFailure,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  parseJsonRpcMessage,
  validateInitializeResponse
} from "@acl/acp-profile";
import { openStdioAdapter, type HostedAgentConfig, type StdioAdapter } from "@acl/adapter-stdio";
import {
  type ContactsStore,
  type DirectoryClient,
  type InitializeResult,
  type InspectResult,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type PeerTransport,
  type PromptContentBlock,
  type PromptResult,
  type ResolvedTarget,
  type SendResult,
  CliError
} from "@acl/acl-types";
import { evaluateTrust } from "@acl/trust";
import { connectWss, startWssServer, type ConnectWssOptions, type WssServerHandle } from "@acl/transport-wss";

interface HostedAgentRegistration {
  agentId: string;
  serviceRoot: string;
  adapter: HostedAgentConfig;
}

interface PeerDaemonOptions {
  transport?: ConnectWssOptions;
}

interface InboundBridgeState {
  initializeRequestId: string | number | null;
  initializeResult: InitializeResult | null;
  sessionOpened: boolean;
  activePromptRequestId: string | number | null;
  pendingRequestIds: Set<string | number>;
}

function normalizeAgentPath(pathname: string): string | null {
  const match = /^\/agents\/([^/]+)$/.exec(pathname);
  return match?.[1] ?? null;
}

function serializeJson(message: unknown): string {
  return JSON.stringify(message);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getRejectOptionId(params: unknown): string | null {
  if (!isObjectRecord(params) || !Array.isArray(params.options)) {
    return null;
  }

  const options = params.options.filter(isObjectRecord);
  const rejectOnce = options.find((option) => option.kind === "reject_once" && typeof option.optionId === "string");
  if (typeof rejectOnce?.optionId === "string") {
    return rejectOnce.optionId;
  }

  const rejectAlways = options.find((option) => option.kind === "reject_always" && typeof option.optionId === "string");
  return typeof rejectAlways?.optionId === "string" ? rejectAlways.optionId : null;
}

function getSessionIdFromPermissionRequest(params: unknown): string | null {
  if (!isObjectRecord(params) || typeof params.sessionId !== "string") {
    return null;
  }
  return params.sessionId;
}

async function sendJsonRpcError(
  transport: PeerTransport,
  id: JsonRpcId,
  message: string,
  data?: unknown
): Promise<void> {
  if (typeof id !== "string" && typeof id !== "number") {
    return;
  }

  await transport.sendFrame(serializeJson(buildJsonRpcError(id, -32602, message, data)));
}

async function rejectPermissionRequest(
  transport: PeerTransport,
  request: JsonRpcRequest,
  sessionId: string | null
): Promise<void> {
  const rejectOptionId = getRejectOptionId(request.params);
  if (!rejectOptionId && sessionId) {
    await transport.sendFrame(
      serializeJson({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: {
          sessionId
        }
      })
    );
  }

  await transport.sendFrame(
    serializeJson({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        outcome: rejectOptionId
          ? {
              outcome: "selected",
              optionId: rejectOptionId
            }
          : {
              outcome: "cancelled"
            }
      }
    })
  );
}

export class PeerDaemon {
  private readonly hostedAgents = new Map<string, HostedAgentRegistration>();
  private server?: WssServerHandle;

  constructor(
    private readonly contactsStore: ContactsStore,
    private readonly directoryClient: DirectoryClient,
    private readonly options: PeerDaemonOptions = {}
  ) {}

  registerHostedAgent(registration: HostedAgentRegistration): void {
    this.hostedAgents.set(registration.agentId, registration);
  }

  async startServer(options: {
    host: string;
    port: number;
    certPath: string;
    keyPath: string;
  }): Promise<WssServerHandle> {
    this.server = await startWssServer({
      ...options,
      onConnection: async (pathname, transport) => {
        const agentId = normalizeAgentPath(pathname);
        if (!agentId) {
          await transport.close();
          return;
        }

        const registration = this.hostedAgents.get(agentId);
        if (!registration) {
          await transport.close();
          return;
        }

        await this.bridgeInboundConnection(transport, registration);
      }
    });

    return this.server;
  }

  async stopServer(): Promise<void> {
    await this.server?.close();
  }

  async resolveTarget(target: string): Promise<ResolvedTarget> {
    const fromContacts = await this.contactsStore.resolveExact(target);
    if (fromContacts) {
      return fromContacts;
    }

    const record = await this.directoryClient.getAgent(target);
    if (!record) {
      throw new CliError(`Target not found: ${target}`, 2);
    }

    const endpoint = record.endpoints[0];
    if (!endpoint) {
      throw new CliError(`No endpoint found for ${target}`, 2);
    }

    return {
      source: "directory",
      agentId: record.agentId,
      endpoint,
      directoryRecord: record
    };
  }

  async inspect(target: string): Promise<InspectResult> {
    const resolved = await this.resolveTarget(target);
    const { transport, initialize, peerId } = await this.openInitializedTransport(resolved);
    try {
      return {
        target: resolved,
        peerId,
        initialize
      };
    } finally {
      await transport.close().catch(() => undefined);
    }
  }

  async send(target: string, prompt: PromptContentBlock[]): Promise<SendResult> {
    const resolved = await this.resolveTarget(target);
    const { transport, initialize, peerId } = await this.openInitializedTransport(resolved);

    try {
      enforcePromptContentBlocks(prompt, initialize.agentCapabilities);

      await transport.sendFrame(
        serializeJson({
          jsonrpc: "2.0",
          id: 2,
          method: "session/new",
          params: buildFreshSessionParams()
        })
      );

      const sessionFrame = await transport.receiveFrame();
      const sessionMessage = parseJsonRpcMessage(sessionFrame, 6, "session/new response");
      if (!isJsonRpcResponse<{ sessionId: string }>(sessionMessage)) {
        throw new CliError("Expected JSON-RPC response to session/new", 6, sessionMessage);
      }
      if (isJsonRpcFailure(sessionMessage)) {
        throw new CliError(sessionMessage.error.message, 6, sessionMessage.error);
      }

      const sessionId = sessionMessage.result.sessionId;
      await transport.sendFrame(
        serializeJson({
          jsonrpc: "2.0",
          id: 3,
          method: "session/prompt",
          params: {
            sessionId,
            prompt
          }
        })
      );

      let aggregatedText = "";
      let promptResult: PromptResult | null = null;

      while (!promptResult) {
        const rawMessage = await transport.receiveFrame();
        const message = parseJsonRpcMessage(rawMessage, 8, "prompt turn");

        if (isJsonRpcNotification(message) && message.method === "session/update") {
          const updateEnvelope = isObjectRecord(message.params) ? message.params : null;
          const update = updateEnvelope && isObjectRecord(updateEnvelope.update) ? updateEnvelope.update : null;
          const content = update && isObjectRecord(update.content) ? update.content : null;

          if (
            update?.sessionUpdate === "agent_message_chunk" &&
            content?.type === "text" &&
            typeof content.text === "string"
          ) {
            aggregatedText += content.text;
          }
          continue;
        }

        if (isJsonRpcRequest(message) && message.method === "session/request_permission") {
          await rejectPermissionRequest(transport, message, getSessionIdFromPermissionRequest(message.params));
          continue;
        }

        if (!isJsonRpcResponse<PromptResult>(message)) {
          throw new CliError("Unexpected ACP message during prompt turn", 8, message);
        }
        if (isJsonRpcFailure(message)) {
          throw new CliError(message.error.message, 8, message.error);
        }
        promptResult = message.result;
      }

      return {
        target: resolved,
        peerId,
        initialize,
        sessionId,
        promptResult,
        aggregatedText
      };
    } finally {
      await transport.close().catch(() => undefined);
    }
  }

  private async openInitializedTransport(
    resolved: ResolvedTarget
  ): Promise<{ transport: PeerTransport; peerId: string; initialize: InitializeResult }> {
    const transport = await connectWss(resolved.endpoint.url, this.options.transport);
    const trust = evaluateTrust(resolved.contact, transport.peerId);
    if (trust.status === "mismatch") {
      await transport.close().catch(() => undefined);
      throw new CliError("Pinned peerId does not match observed peerId", 5, {
        endpoint: resolved.endpoint.url,
        ...trust
      });
    }

    await transport.sendFrame(serializeJson(buildInitializeRequest(1)));
    const frame = await transport.receiveFrame();
    const message = parseJsonRpcMessage(frame, 4, "initialize response");
    if (!isJsonRpcResponse<InitializeResult>(message)) {
      await transport.close().catch(() => undefined);
      throw new CliError("Expected JSON-RPC response to initialize", 4, message);
    }
    if (isJsonRpcFailure(message)) {
      await transport.close().catch(() => undefined);
      throw new CliError(message.error.message, 4, message.error);
    }

    return {
      transport,
      peerId: transport.peerId,
      initialize: validateInitializeResponse(message.result)
    };
  }

  private async bridgeInboundConnection(
    transport: PeerTransport,
    registration: HostedAgentRegistration
  ): Promise<void> {
    const adapter = await openStdioAdapter(registration.adapter);
    const state: InboundBridgeState = {
      initializeRequestId: null,
      initializeResult: null,
      sessionOpened: false,
      activePromptRequestId: null,
      pendingRequestIds: new Set<string | number>()
    };

    const failPendingRequests = async (error: unknown) => {
      for (const requestId of state.pendingRequestIds) {
        await sendJsonRpcError(transport, requestId, "Hosted agent connection failed", error).catch(() => undefined);
      }
      state.pendingRequestIds.clear();
    };

    const clientToAdapter = async () => {
      while (true) {
        const rawMessage = await transport.receiveFrame();
        const message = parseJsonRpcMessage(rawMessage, 4, "inbound WSS frame");

        if (state.initializeRequestId === null) {
          assertInitializeFirst(message);
        }

        if (isJsonRpcRequest(message)) {
          if (message.method === "initialize") {
            if (state.initializeRequestId !== null) {
              await sendJsonRpcError(transport, message.id, "initialize may only be sent once");
              continue;
            }

            state.initializeRequestId = message.id;
            state.pendingRequestIds.add(message.id);
          } else if (message.method === "session/load") {
            await sendJsonRpcError(transport, message.id, "session/load is not supported in ACL MVP");
            continue;
          } else if (message.method === "session/new") {
            if (state.sessionOpened) {
              await sendJsonRpcError(transport, message.id, "Only one ACP session is allowed per connection");
              continue;
            }

            const params = isObjectRecord(message.params) ? message.params : null;
            if (!params) {
              await sendJsonRpcError(transport, message.id, "session/new params must be an object");
              continue;
            }
            if (Array.isArray(params.mcpServers) && params.mcpServers.length > 0) {
              await sendJsonRpcError(transport, message.id, "mcpServers must be empty in ACL MVP");
              continue;
            }

            message.params = {
              ...params,
              cwd: registration.serviceRoot,
              mcpServers: []
            };
            state.sessionOpened = true;
            state.pendingRequestIds.add(message.id);
          } else if (message.method === "session/prompt") {
            if (!state.sessionOpened) {
              await sendJsonRpcError(transport, message.id, "session/new must succeed before session/prompt");
              continue;
            }
            if (state.activePromptRequestId !== null) {
              await sendJsonRpcError(transport, message.id, "Only one prompt may be in flight per session");
              continue;
            }

            const params = isObjectRecord(message.params) ? message.params : null;
            if (!params || !Array.isArray(params.prompt)) {
              await sendJsonRpcError(transport, message.id, "session/prompt params must include a prompt array");
              continue;
            }

            try {
              enforcePromptContentBlocks(
                params.prompt as PromptContentBlock[],
                state.initializeResult?.agentCapabilities
              );
            } catch (error) {
              const cliError = error instanceof CliError ? error : new CliError("Invalid prompt content", 9, error);
              await transport.sendFrame(serializeJson(buildJsonRpcError(message.id, -32602, cliError.message, cliError.details)));
              continue;
            }

            state.activePromptRequestId = message.id;
            state.pendingRequestIds.add(message.id);
          } else {
            state.pendingRequestIds.add(message.id);
          }
        }

        await adapter.send(serializeJson(message));
      }
    };

    const adapterToClient = async () => {
      while (true) {
        const rawMessage = await adapter.receive();
        const message = parseJsonRpcMessage(rawMessage, 8, "adapter stdout");

        if (isJsonRpcResponse(message)) {
          if (typeof message.id === "string" || typeof message.id === "number") {
            state.pendingRequestIds.delete(message.id);
          }

          if (message.id === state.initializeRequestId && !isJsonRpcFailure(message)) {
            state.initializeResult = validateInitializeResponse(message.result as InitializeResult);
          }

          if (message.id === state.activePromptRequestId) {
            state.activePromptRequestId = null;
          }
        }

        await transport.sendFrame(serializeJson(message));
      }
    };

    try {
      await Promise.race([clientToAdapter(), adapterToClient()]);
    } catch (error) {
      await failPendingRequests(error);
    } finally {
      await adapter.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  }
}

export type { HostedAgentRegistration };
