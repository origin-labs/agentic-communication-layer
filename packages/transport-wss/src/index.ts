import { createServer } from "node:https";
import { readFile } from "node:fs/promises";
import { type AddressInfo } from "node:net";
import { type TLSSocket } from "node:tls";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { CliError, type PeerTransport } from "@acl/acl-types";
import { derivePeerIdFromCertificatePem } from "@acl/trust";

function rawCertificateToPem(rawCertificate: Buffer): string {
  const base64 = rawCertificate.toString("base64");
  const wrapped = base64.match(/.{1,64}/g)?.join("\n") ?? base64;
  return `-----BEGIN CERTIFICATE-----\n${wrapped}\n-----END CERTIFICATE-----`;
}

function derivePeerIdFromTlsSocket(tlsSocket: TLSSocket): string | null {
  const peerCertificate = tlsSocket.getPeerCertificate(true);
  if (!peerCertificate?.raw) {
    return null;
  }
  return derivePeerIdFromCertificatePem(rawCertificateToPem(peerCertificate.raw));
}

interface WebSocketWithTlsSocket extends WebSocket {
  _socket: TLSSocket;
}

class WsPeerTransport implements PeerTransport {
  private readonly queue: string[] = [];
  private readonly waiters: Array<{ resolve(value: string): void; reject(error: Error): void }> = [];
  private sendChain = Promise.resolve();
  private terminalError: Error | null = null;

  constructor(
    private readonly socket: WebSocket,
    public readonly peerId: string
  ) {
    this.socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        this.fail(new CliError("WSS transport only accepts UTF-8 text frames", 3));
        this.socket.close(1003, "Text frames only");
        return;
      }

      const payload = data.toString();
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.resolve(payload);
      } else {
        this.queue.push(payload);
      }
    });

    this.socket.on("close", () => {
      this.fail(new CliError("WSS transport closed", 3));
    });

    this.socket.on("error", (error: Error) => {
      this.fail(new CliError("WSS transport error", 3, error));
    });
  }

  private fail(error: Error): void {
    if (this.terminalError) {
      return;
    }
    this.terminalError = error;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error);
    }
  }

  async sendFrame(message: string): Promise<void> {
    if (this.terminalError) {
      throw this.terminalError;
    }

    const sendOperation = this.sendChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.socket.send(message, (error?: Error) => {
            if (error) {
              reject(new CliError("Failed to send WSS frame", 3, error));
              return;
            }
            resolve();
          });
        })
    );

    this.sendChain = sendOperation.catch(() => undefined);
    await sendOperation;
  }

  async receiveFrame(): Promise<string> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return queued;
    }
    if (this.terminalError) {
      throw this.terminalError;
    }

    return await new Promise<string>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return;
    }

    await new Promise<void>((resolve) => {
      if (this.socket.readyState === WebSocket.CLOSING) {
        this.socket.once("close", () => resolve());
        return;
      }

      this.socket.once("close", () => resolve());
      this.socket.close();
    });
  }
}

export interface ConnectWssOptions {
  caCertPath?: string;
  connectTimeoutMs?: number;
}

export async function connectWss(url: string, options: ConnectWssOptions = {}): Promise<PeerTransport> {
  const ca = options.caCertPath ? await readFile(options.caCertPath, "utf8") : undefined;
  const socket = new WebSocket(url, {
    ca,
    rejectUnauthorized: true
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new CliError(`Timed out connecting to ${url}`, 3));
    }, options.connectTimeoutMs ?? 10_000);

    socket.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });

    socket.once("error", (error: Error) => {
      clearTimeout(timeout);
      reject(new CliError(`Failed to connect to ${url}`, 3, error));
    });
  });

  const tlsSocket = (socket as WebSocketWithTlsSocket)._socket;
  const peerId = derivePeerIdFromTlsSocket(tlsSocket);
  if (!peerId) {
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
    });
    throw new CliError("TLS peer certificate not available", 3);
  }

  return new WsPeerTransport(socket, peerId);
}

export interface WssServerHandle {
  port: number;
  close(): Promise<void>;
}

export async function startWssServer(options: {
  host: string;
  port: number;
  certPath: string;
  keyPath: string;
  onConnection(pathname: string, transport: PeerTransport): Promise<void>;
}): Promise<WssServerHandle> {
  const [cert, key] = await Promise.all([
    readFile(options.certPath, "utf8"),
    readFile(options.keyPath, "utf8")
  ]);

  const server = createServer({ cert, key });
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `https://${request.headers.host ?? options.host}`);
    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      const tlsSocket = (ws as WebSocketWithTlsSocket)._socket;
      const peerId = derivePeerIdFromTlsSocket(tlsSocket) ?? "peer_spki_sha256_unknown";
      const transport = new WsPeerTransport(ws, peerId);
      void options.onConnection(url.pathname, transport).catch(async () => {
        await transport.close().catch(() => undefined);
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });

  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    async close() {
      await new Promise<void>((resolve, reject) => {
        wss.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
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
