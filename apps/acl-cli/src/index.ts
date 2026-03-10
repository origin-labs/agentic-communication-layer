#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError, type PromptContentBlock } from "@acl/acl-types";
import { formatInspectResult, formatResolvedTarget, formatSendResult } from "@acl/cli-output";
import { JsonContactsStore } from "@acl/contacts-store";
import { MockDirectoryClient } from "@acl/directory-mock";
import { PeerDaemon } from "@acl/peer-daemon";

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

async function main() {
  const { command, args, json } = parseArgs(process.argv.slice(2));
  const contacts = new JsonContactsStore(join(homedir(), ".config", "acl", "contacts.json"));
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
      const prompt: PromptContentBlock[] = [{ type: "text", text: promptText }];
      const result = await daemon.send(target, prompt);
      console.log(json ? JSON.stringify(result, null, 2) : formatSendResult(result));
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
