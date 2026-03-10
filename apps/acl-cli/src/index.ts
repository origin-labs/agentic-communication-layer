#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { CliError, type PromptContentBlock } from "@acl/acl-types";
import { formatInspectResult, formatResolvedTarget, formatSendResult } from "@acl/cli-output";
import { JsonContactsStore } from "@acl/contacts-store";
import { MockDirectoryClient } from "@acl/directory-mock";
import { PeerDaemon, type PeerSession } from "@acl/peer-daemon";

let activeJsonl = false;

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  const json = rest.includes("--json");
  const jsonl = rest.includes("--jsonl");
  const cleanArgs = rest.filter((arg) => arg !== "--json" && arg !== "--jsonl");
  return { command, args: cleanArgs, json, jsonl };
}

async function readPromptArg(arg: string | undefined): Promise<string> {
  if (!arg) {
    throw new CliError("Missing prompt argument", 1);
  }
  if (arg !== "-") {
    return arg;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function buildTextPrompt(promptText: string): PromptContentBlock[] {
  return [{ type: "text", text: promptText }];
}

function emitJsonlEvent(event: string, payload: unknown): void {
  process.stdout.write(`${JSON.stringify({ event, payload })}\n`);
}

interface CallOutputOptions {
  jsonl: boolean;
}

async function runInteractiveCall(session: PeerSession, options: CallOutputOptions): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: options.jsonl ? undefined : process.stdout,
    terminal: process.stdin.isTTY
  });

  const queuedPrompts: string[] = [];
  let activePrompt: Promise<void> | null = null;
  let inputEnded = false;
  let exitRequested = false;
  let fatalError: unknown;
  let finished = false;

  const maybePrompt = () => {
    if (!process.stdin.isTTY || inputEnded || exitRequested || activePrompt) {
      return;
    }
    rl.setPrompt("acl> ");
    rl.prompt();
  };

  const maybeFinish = () => {
    if (!activePrompt && queuedPrompts.length === 0 && (inputEnded || exitRequested) && !finished) {
      finished = true;
      rl.close();
    }
  };

  const handleFatal = (error: unknown) => {
    if (!fatalError) {
      fatalError = error;
    }
    exitRequested = true;
    maybeFinish();
  };

  const pumpQueue = () => {
    if (activePrompt || queuedPrompts.length === 0) {
      maybeFinish();
      maybePrompt();
      return;
    }

    const promptText = queuedPrompts.shift()!;
    let wroteText = false;

    activePrompt = session
      .prompt(buildTextPrompt(promptText), {
        onTextChunk(text) {
          if (options.jsonl) {
            return;
          }
          wroteText = true;
          process.stdout.write(text);
        },
        onSessionUpdate(update) {
          if (options.jsonl) {
            emitJsonlEvent("session_update", update);
          }
        },
        onPermissionRequest(request) {
          if (options.jsonl) {
            emitJsonlEvent("permission_request", request);
          }
        }
      })
      .then((result) => {
        if (options.jsonl) {
          emitJsonlEvent("prompt_result", {
            prompt: promptText,
            promptResult: result.promptResult,
            aggregatedText: result.aggregatedText,
            locallyCancelled: result.locallyCancelled
          });
          return;
        }

        if (wroteText && !result.aggregatedText.endsWith("\n")) {
          process.stdout.write("\n");
        }
        if (result.promptResult.stopReason === "cancelled" && !wroteText) {
          process.stderr.write("Prompt cancelled\n");
        }
      })
      .catch((error) => {
        handleFatal(error);
      })
      .finally(() => {
        activePrompt = null;
        pumpQueue();
      });
  };

  const sigintHandler = () => {
    if (activePrompt) {
      void session.cancel().catch(handleFatal);
      return;
    }
    exitRequested = true;
    maybeFinish();
  };

  process.on("SIGINT", sigintHandler);

  rl.on("line", (line) => {
    const trimmed = line.trim();

    if (trimmed === "/exit") {
      exitRequested = true;
      maybeFinish();
      return;
    }

    if (trimmed === "/cancel") {
      if (activePrompt) {
        void session.cancel().catch(handleFatal);
      } else {
        process.stderr.write("No active prompt.\n");
        maybePrompt();
      }
      return;
    }

    if (trimmed.length === 0) {
      maybePrompt();
      return;
    }

    queuedPrompts.push(line);
    pumpQueue();
  });

  rl.on("close", () => {
    inputEnded = true;
    maybeFinish();
  });

  maybePrompt();

  while (!finished && !fatalError) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }

  process.off("SIGINT", sigintHandler);

  if (fatalError) {
    throw fatalError;
  }
}

async function main() {
  const { command, args, json, jsonl } = parseArgs(process.argv.slice(2));
  activeJsonl = jsonl;
  if (json && jsonl) {
    throw new CliError("Choose only one of --json or --jsonl", 1);
  }
  const contactsFilePath =
    process.env.ACL_CONTACTS_FILE ?? join(homedir(), ".config", "acl", "contacts.json");
  const contacts = new JsonContactsStore(contactsFilePath);
  const directoryFixturePath =
    process.env.ACL_DIRECTORY_FIXTURE ?? join(process.cwd(), "tests", "fixtures", "directory.json");
  const directory = new MockDirectoryClient(directoryFixturePath);
  const daemon = new PeerDaemon(contacts, directory, {
    transport: {
      caCertPath: process.env.ACL_TLS_CA_CERT
    }
  });

  switch (command) {
    case "resolve": {
      const target = args[0];
      if (!target) throw new CliError("Missing target", 1);
      const resolved = await daemon.resolveTarget(target);
      console.log(json ? JSON.stringify(resolved, null, 2) : formatResolvedTarget(resolved));
      return;
    }
    case "inspect": {
      const target = args[0];
      if (!target) throw new CliError("Missing target", 1);
      const result = await daemon.inspect(target);
      console.log(json ? JSON.stringify(result, null, 2) : formatInspectResult(result));
      return;
    }
    case "send": {
      const target = args[0];
      if (!target) throw new CliError("Missing target", 1);
      const promptText = await readPromptArg(args[1]);
      if (jsonl) {
        const resolved = await daemon.resolveTarget(target);
        emitJsonlEvent("resolved", resolved);
        const session = await daemon.openSessionResolved(resolved, {
          onConnected(resolvedTarget, peerId) {
            emitJsonlEvent("connected", {
              target: resolvedTarget,
              peerId
            });
          },
          onInitialized(initialize) {
            emitJsonlEvent("initialized", initialize);
          },
          onSessionOpened(sessionId) {
            emitJsonlEvent("session_opened", { sessionId });
          }
        });

        try {
          const result = await session.prompt(buildTextPrompt(promptText), {
            onSessionUpdate(update) {
              emitJsonlEvent("session_update", update);
            },
            onPermissionRequest(request) {
              emitJsonlEvent("permission_request", request);
            }
          });
          emitJsonlEvent("prompt_result", {
            promptResult: result.promptResult,
            aggregatedText: result.aggregatedText,
            locallyCancelled: result.locallyCancelled
          });
          if (result.locallyCancelled) {
            process.exitCode = 7;
          }
        } finally {
          await session.close().catch(() => undefined);
        }
        return;
      }

      const result = await daemon.send(target, buildTextPrompt(promptText));
      console.log(json ? JSON.stringify(result, null, 2) : formatSendResult(result));
      if (result.locallyCancelled) {
        process.exitCode = 7;
      }
      return;
    }
    case "call": {
      const target = args[0];
      if (!target) throw new CliError("Missing target", 1);
      if (json) {
        throw new CliError("--json is not supported for acl call", 1);
      }

      const resolved = await daemon.resolveTarget(target);
      if (jsonl) {
        emitJsonlEvent("resolved", resolved);
      }
      const session = await daemon.openSessionResolved(resolved, {
        onConnected(resolvedTarget, peerId) {
          if (jsonl) {
            emitJsonlEvent("connected", {
              target: resolvedTarget,
              peerId
            });
          }
        },
        onInitialized(initialize) {
          if (jsonl) {
            emitJsonlEvent("initialized", initialize);
          }
        },
        onSessionOpened(sessionId) {
          if (jsonl) {
            emitJsonlEvent("session_opened", { sessionId });
          }
        }
      });
      try {
        await runInteractiveCall(session, { jsonl });
      } finally {
        await session.close().catch(() => undefined);
      }
      return;
    }
    default:
      throw new CliError(`Unsupported command: ${command ?? ""}`, 1);
  }
}

main().catch(async (error: unknown) => {
  if (activeJsonl) {
    emitJsonlEvent("error", error instanceof CliError ? { message: error.message, details: error.details } : { message: error instanceof Error ? error.message : String(error) });
  }
  if (error instanceof CliError) {
    console.error(error.message);
    if (error.details !== undefined) {
      console.error(JSON.stringify(error.details, null, 2));
    }
    process.exit(error.exitCode);
  }
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
