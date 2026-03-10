#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { CliError, type PromptContentBlock } from "@acl/acl-types";
import { formatInspectResult, formatResolvedTarget, formatSendResult } from "@acl/cli-output";
import { JsonContactsStore } from "@acl/contacts-store";
import { MockDirectoryClient } from "@acl/directory-mock";
import { PeerDaemon, type PeerSession } from "@acl/peer-daemon";

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  const json = rest.includes("--json");
  const cleanArgs = rest.filter((arg) => arg !== "--json");
  return { command, args: cleanArgs, json };
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

async function runInteractiveCall(session: PeerSession): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
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
          wroteText = true;
          process.stdout.write(text);
        }
      })
      .then((result) => {
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
  const { command, args, json } = parseArgs(process.argv.slice(2));
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
      const result = await daemon.send(target, buildTextPrompt(promptText));
      console.log(json ? JSON.stringify(result, null, 2) : formatSendResult(result));
      return;
    }
    case "call": {
      const target = args[0];
      if (!target) throw new CliError("Missing target", 1);
      if (json) {
        throw new CliError("--json is not supported for acl call in this slice", 1);
      }

      const session = await daemon.openSession(target);
      try {
        await runInteractiveCall(session);
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
