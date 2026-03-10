import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { CliError } from "@acl/acl-types";

export interface StdioAdapter {
  send(message: string): Promise<void>;
  receive(): Promise<string>;
  close(): Promise<void>;
}

export interface HostedAgentConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export async function openStdioAdapter(config: HostedAgentConfig): Promise<StdioAdapter> {
  const child = spawn(config.command, config.args, {
    env: {
      ...process.env,
      ...(config.env ?? {})
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  return new LineBufferedStdioAdapter(child);
}

class LineBufferedStdioAdapter implements StdioAdapter {
  private readonly queue: string[] = [];
  private readonly waiters: Array<{ resolve(value: string): void; reject(error: Error): void }> = [];
  private buffer = "";
  private terminalError: Error | null = null;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.child.stdout.on("data", (chunk: Buffer | string) => {
      this.buffer += chunk.toString();
      let newlineIndex = this.buffer.indexOf("\n");

      while (newlineIndex >= 0) {
        const line = this.buffer.slice(0, newlineIndex).trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);

        if (line.length > 0) {
          try {
            JSON.parse(line);
          } catch (error) {
            this.fail(new CliError("Adapter emitted invalid ACP JSON on stdout", 8, { line, error }));
            this.child.kill("SIGKILL");
            return;
          }

          const waiter = this.waiters.shift();
          if (waiter) {
            waiter.resolve(line);
          } else {
            this.queue.push(line);
          }
        }

        newlineIndex = this.buffer.indexOf("\n");
      }
    });

    this.child.once("error", (error) => {
      this.fail(new CliError("Failed to start stdio adapter", 8, error));
    });

    this.child.once("exit", (code, signal) => {
      this.fail(
        new CliError("Stdio adapter exited", 8, {
          code,
          signal
        })
      );
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

  async send(message: string): Promise<void> {
    if (this.terminalError) {
      throw this.terminalError;
    }

    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${message}\n`, (error) => {
        if (error) {
          reject(new CliError("Failed to write ACP message to adapter stdin", 8, error));
          return;
        }
        resolve();
      });
    });
  }

  async receive(): Promise<string> {
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
    if (this.child.exitCode !== null || this.child.killed) {
      return;
    }

    this.child.stdin.end();
    this.child.kill("SIGTERM");

    await new Promise<void>((resolve) => {
      this.child.once("exit", () => resolve());
    });
  }
}
