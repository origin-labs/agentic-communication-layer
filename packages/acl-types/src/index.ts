export type Visibility = "public" | "unlisted";

export interface EndpointRecord {
  transport: "wss";
  url: string;
  priority: number;
}

export interface AgentRecord {
  agentId: string;
  handle: string;
  displayName: string;
  summary: string;
  protocols: {
    acp: number[];
  };
  endpoints: EndpointRecord[];
  serviceCapabilities: string[];
  visibility: Visibility;
  version: string;
  updatedAt: string;
}

export interface VerificationMetadata {
  source: "directory" | "manual";
  verifiedAt: string;
  directoryUpdatedAt?: string;
  endpointVerifiedAt?: string;
}

export interface ContactRecord {
  alias?: string;
  agentId: string;
  endpoint: EndpointRecord;
  pinnedPeerId?: string;
  authRef?: string;
  verification?: VerificationMetadata;
}

export interface ContactsFile {
  version: 1;
  contacts: ContactRecord[];
}

export interface ResolvedTarget {
  source: "contact-alias" | "contact-agent" | "directory";
  agentId: string;
  endpoint: EndpointRecord;
  contact?: ContactRecord;
  directoryRecord?: AgentRecord;
}

export interface DirectoryClient {
  getAgent(agentId: string): Promise<AgentRecord | null>;
}

export interface ContactsStore {
  loadContacts(): Promise<ContactsFile>;
  saveContacts(file: ContactsFile): Promise<void>;
  resolveExact(target: string): Promise<ResolvedTarget | null>;
  updatePinnedPeerId(agentId: string, pinnedPeerId: string, verification?: VerificationMetadata): Promise<void>;
}

export type TrustPinStatus =
  | { status: "untrusted"; observedPeerId: string }
  | { status: "matched"; observedPeerId: string; expectedPeerId: string }
  | { status: "mismatch"; observedPeerId: string; expectedPeerId: string };

export interface InspectResult {
  target: ResolvedTarget;
  peerId: string;
  initialize: InitializeResult;
}

export interface SendResult {
  target: ResolvedTarget;
  peerId: string;
  initialize: InitializeResult;
  sessionId: string;
  promptResult: PromptResult;
  aggregatedText: string;
  locallyCancelled: boolean;
}

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params: TParams;
}

export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc: "2.0";
  method: string;
  params: TParams;
}

export interface InitializeRequest extends JsonRpcRequest<{
  protocolVersion: number;
  clientCapabilities: {
    fs: {
      readTextFile: false;
      writeTextFile: false;
    };
    terminal: false;
  };
  clientInfo: {
    name: string;
    title: string;
    version: string;
  };
}> {
  method: "initialize";
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: {
      image?: boolean;
      audio?: boolean;
      embeddedContext?: boolean;
    };
    sessionCapabilities?: Record<string, unknown>;
  };
  agentInfo?: {
    name?: string;
    title?: string;
    version?: string;
  };
  authMethods?: Array<{
    id: string;
    name: string;
    description?: string | null;
  }>;
}

export interface NewSessionRequest extends JsonRpcRequest<{
  cwd: "/";
  mcpServers: [];
}> {
  method: "session/new";
}

export interface NewSessionResult {
  sessionId: string;
}

export type PromptContentBlock =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string; title?: string; description?: string; size?: number }
  | { type: "resource"; resource: { uri: string; text: string; mimeType?: string } };

export interface PromptRequest extends JsonRpcRequest<{
  sessionId: string;
  prompt: PromptContentBlock[];
}> {
  method: "session/prompt";
}

export interface PromptResult {
  stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
  [key: string]: unknown;
}

export interface SessionUpdateNotification extends JsonRpcNotification<{
  sessionId: string;
  update: Record<string, unknown>;
}> {
  method: "session/update";
}

export interface SessionCancelNotification extends JsonRpcNotification<{
  sessionId: string;
}> {
  method: "session/cancel";
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: T;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcFailure;
export type JsonRpcMessage<TParams = unknown, TResult = unknown> =
  | JsonRpcRequest<TParams>
  | JsonRpcNotification<TParams>
  | JsonRpcResponse<TResult>;

export interface AcpConnection {
  sendFrame(message: string): Promise<void>;
  receiveFrame(): Promise<string>;
  close(): Promise<void>;
}

export interface PeerTransport extends AcpConnection {
  readonly peerId: string;
}

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export const ACL_PROTOCOL_VERSION = 1;
export const ACL_CLIENT_INFO = {
  name: "acl-cli",
  title: "ACL CLI",
  version: "0.1.0"
} as const;
