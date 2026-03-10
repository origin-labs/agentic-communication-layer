#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import {
  CliError,
  type DirectoryClient,
  type DirectoryRegistryClient,
  type NamespaceRecord,
  type PromptContentBlock,
  type PublishAgentRequest
} from "@acl/acl-types";
import { formatInspectResult, formatResolvedTarget, formatSendResult } from "@acl/cli-output";
import { JsonContactsStore } from "@acl/contacts-store";
import { createHttpDirectoryClient } from "@acl/directory-client";
import { startDirectoryServer } from "@acl/directory-server";
import { MockDirectoryClient } from "@acl/directory-mock";
import { PeerDaemon, type PeerSession } from "@acl/peer-daemon";
import { derivePeerIdFromCertificatePem } from "@acl/trust";

let activeJsonl = false;

const HANDLE_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.agent$/;
const EXAMPLE_ECHO_AGENT_PATH = fileURLToPath(new URL("../../../examples/echo-acp-agent.mjs", import.meta.url));
const EXAMPLE_MAILBOX_AGENT_PATH = fileURLToPath(new URL("../../../examples/mailbox-acp-agent.mjs", import.meta.url));
const EXAMPLE_CLAUDE_AGENT_PATH = fileURLToPath(new URL("../../../examples/claude-acp-agent.mjs", import.meta.url));
const EMPTY_DIRECTORY_CLIENT: DirectoryClient = {
  async getAgent() {
    return null;
  }
};

type CommandName = "resolve" | "inspect" | "send" | "call" | "mail" | "peer" | "registry" | "manifest";
type MailSubcommandName = "send";
type PeerSubcommandName = "serve";
type RegistrySubcommandName = "serve" | "claim" | "verify" | "namespace" | "publish" | "show" | "search";
type ManifestSubcommandName = "init";

interface ParsedArgs {
  command?: string;
  args: string[];
  json: boolean;
  jsonl: boolean;
  help: boolean;
  directoryUrl?: string;
}

interface CommandHelpSpec {
  name: string;
  summary: string;
  usage: string[];
  examples: string[];
  flags: string[];
  notes?: string[];
}

const COMMAND_HELP: Record<CommandName, CommandHelpSpec> = {
  resolve: {
    name: "resolve",
    summary: "Resolve a target by exact alias or agentId",
    usage: ["acl resolve <target>", "acl help resolve"],
    examples: ["acl resolve acme.reviewer.agent", "acl resolve reviewer --json"],
    flags: ["--json             Print the resolved target as JSON"]
  },
  inspect: {
    name: "inspect",
    summary: "Open WSS, derive peerId, and run ACP initialize",
    usage: ["acl inspect <target>", "acl inspect <target> --json"],
    examples: ["acl inspect acme.reviewer.agent", "acl inspect reviewer --json"],
    flags: ["--json             Print the inspect result as JSON"]
  },
  send: {
    name: "send",
    summary: "Send one prompt over a fresh ACP session",
    usage: ["acl send <target> <message>", "acl send <target> -", "acl send <target> <message> --jsonl"],
    examples: [
      "acl send acme.reviewer.agent \"review this plan\"",
      "printf '%s' 'review this plan' | acl send acme.reviewer.agent -",
      "acl send reviewer \"review this plan\" --json"
    ],
    flags: [
      "--json             Print the final send result as JSON",
      "--jsonl            Stream normalized lifecycle events as JSON Lines"
    ],
    notes: ["Use '-' as the message argument to read prompt text from stdin."]
  },
  call: {
    name: "call",
    summary: "Open one live ACP session and enter interactive mode",
    usage: ["acl call <target>", "acl call <target> --jsonl"],
    examples: ["acl call acme.reviewer.agent", "acl call reviewer --jsonl"],
    flags: ["--jsonl            Stream normalized lifecycle and prompt events as JSON Lines"],
    notes: ["Local controls: /exit closes the command, /cancel cancels the active prompt."]
  },
  mail: {
    name: "mail",
    summary: "Send structured mailbox messages with sender and reply metadata",
    usage: ["acl mail <subcommand>", "acl help mail", "acl help mail <subcommand>"],
    examples: [
      "acl mail send acme.mailbox.agent \"hello\" --from codex.mailbox.agent --reply-to codex.mailbox.agent",
      "printf '%s' 'hello' | acl mail send acme.mailbox.agent - --from codex.mailbox.agent"
    ],
    flags: []
  },
  peer: {
    name: "peer",
    summary: "Run a local WSS peer daemon that hosts an ACP stdio agent",
    usage: ["acl peer <subcommand>", "acl help peer", "acl help peer <subcommand>"],
    examples: [
      "acl peer serve --agent-id acme.reviewer.agent --example echo --cert ./.acl/tls/server.cert.pem --key ./.acl/tls/server.key.pem",
      "acl peer serve --agent-id acme.reviewer.agent --command node --arg ./examples/echo-acp-agent.mjs --cert ./.acl/tls/server.cert.pem --key ./.acl/tls/server.key.pem"
    ],
    flags: []
  },
  registry: {
    name: "registry",
    summary: "Manage the directory service and registry records",
    usage: ["acl registry <subcommand>", "acl help registry", "acl help registry <subcommand>"],
    examples: [
      "acl registry serve",
      "acl registry claim acme",
      "acl registry verify acme acl-verify-...",
      "acl registry publish ./agent.json"
    ],
    flags: ["--directory-url <url>   Override ACL_DIRECTORY_URL for registry operations"]
  },
  manifest: {
    name: "manifest",
    summary: "Generate and inspect agent manifest files",
    usage: ["acl manifest <subcommand>", "acl help manifest", "acl help manifest <subcommand>"],
    examples: [
      "acl manifest init acme.reviewer.agent",
      "acl manifest init acme.reviewer.agent --capability code.review --out ./agent.json"
    ],
    flags: []
  }
};

const MAIL_HELP: Record<MailSubcommandName, CommandHelpSpec> = {
  send: {
    name: "mail send",
    summary: "Send a structured mailbox message over a fresh ACP session",
    usage: [
      "acl mail send <target> <body> --from <agentId>",
      "acl mail send <target> - --from <agentId> --reply-to <agentId> --subject <text>"
    ],
    examples: [
      "acl mail send acme.mailbox.agent \"hello\" --from codex.mailbox.agent --reply-to codex.mailbox.agent",
      "printf '%s' 'investigate acp alerts' | acl mail send acme.mailbox.agent - --from claude.code.agent --reply-to claude.code.agent --subject \"ACP alerting\" --json"
    ],
    flags: [
      "--from <agentId>     Sender agentId to attach to the mail envelope",
      "--reply-to <target>  Reply route or agentId for responses, defaults to --from",
      "--subject <text>     Optional subject line",
      "--json               Print the final send result as JSON",
      "--jsonl              Stream normalized lifecycle events as JSON Lines"
    ],
    notes: [
      "mail send encodes the envelope as an ACP resource block and the body as a text block.",
      "The target agent must advertise embeddedContext support to receive structured mail."
    ]
  }
};

const PEER_HELP: Record<PeerSubcommandName, CommandHelpSpec> = {
  serve: {
    name: "peer serve",
    summary: "Run a WSS peer daemon hosting one local ACP stdio agent",
    usage: [
      "acl peer serve --agent-id <agentId> --example echo --cert <path> --key <path>",
      "acl peer serve --agent-id <agentId> --command <path> --arg <value> --cert <path> --key <path>"
    ],
    examples: [
      "acl peer serve --agent-id acme.reviewer.agent --example echo --cert ./.acl/tls/server.cert.pem --key ./.acl/tls/server.key.pem",
      "acl peer serve --agent-id acme.reviewer.agent --host 127.0.0.1 --port 7443 --command node --arg ./examples/echo-acp-agent.mjs --cert ./.acl/tls/server.cert.pem --key ./.acl/tls/server.key.pem",
      "acl peer serve --agent-id acme.reviewer.agent --command /usr/local/bin/my-agent --arg acp --service-root /srv/my-agent --cert ./.acl/tls/server.cert.pem --key ./.acl/tls/server.key.pem"
    ],
    flags: [
      "--agent-id <id>      Hosted agentId ending in .agent",
      "--example <name>     Bundled example agent: echo, mailbox, or claude",
      "--command <path>     Executable path for a stdio ACP agent",
      "--arg <value>        Argument for --command, repeatable",
      "--env <KEY=VALUE>    Environment variable for --command, repeatable",
      "--service-root <dir> Local service root, default current directory",
      "--host <host>        Bind host, default 127.0.0.1",
      "--port <port>        Bind port, default 7443, 0 allowed",
      "--cert <path>        TLS certificate path",
      "--key <path>         TLS private key path"
    ],
    notes: [
      "Exactly one agentId is hosted per peer serve process in MVP.",
      "Use 'pnpm dev:tls ./.acl/tls' to generate a local CA and server certificate for testing."
    ]
  }
};

const REGISTRY_HELP: Record<RegistrySubcommandName, CommandHelpSpec> = {
  serve: {
    name: "registry serve",
    summary: "Run a local file-backed directory service",
    usage: ["acl registry serve", "acl registry serve --host 127.0.0.1 --port 4040 --state-file ./.acl/directory-state.json"],
    examples: ["acl registry serve", "acl registry serve --port 4040 --state-file ./.acl/directory-state.json"],
    flags: [
      "--host <host>       Bind host, default 127.0.0.1",
      "--port <port>       Bind port, default 4040",
      "--state-file <path> Directory state file, default ./.acl/directory-state.json"
    ]
  },
  claim: {
    name: "registry claim",
    summary: "Claim a namespace and receive a verification challenge",
    usage: ["acl registry claim <namespace>", "acl registry claim <namespace> --json"],
    examples: ["acl registry claim acme", "acl registry claim foo.bar --json"],
    flags: [
      "--json             Print the namespace claim response as JSON",
      "--directory-url <url> Override the target directory URL"
    ]
  },
  verify: {
    name: "registry verify",
    summary: "Verify a claimed namespace using the issued challenge proof",
    usage: ["acl registry verify <namespace> <proof>", "acl registry verify <namespace> <proof> --json"],
    examples: ["acl registry verify acme acl-verify-deadbeef", "acl registry verify foo.bar acl-verify-deadbeef --json"],
    flags: [
      "--json             Print the verification response as JSON",
      "--directory-url <url> Override the target directory URL"
    ]
  },
  namespace: {
    name: "registry namespace",
    summary: "Show namespace claim status",
    usage: ["acl registry namespace <namespace>", "acl registry namespace <namespace> --json"],
    examples: ["acl registry namespace acme", "acl registry namespace foo.bar --json"],
    flags: [
      "--json             Print the namespace record as JSON",
      "--directory-url <url> Override the target directory URL"
    ]
  },
  publish: {
    name: "registry publish",
    summary: "Publish or update an agent record from a manifest file",
    usage: ["acl registry publish <manifest.json>", "acl registry publish <manifest.json> --json"],
    examples: ["acl registry publish ./agent.json", "acl registry publish ./agent.json --json"],
    flags: [
      "--json             Print the published agent record as JSON",
      "--directory-url <url> Override the target directory URL"
    ],
    notes: ["Manifest files must include agentId, displayName, summary, protocols, endpoints, serviceCapabilities, visibility, and version."]
  },
  show: {
    name: "registry show",
    summary: "Fetch an agent record by exact agentId",
    usage: ["acl registry show <agentId>", "acl registry show <agentId> --json"],
    examples: ["acl registry show acme.reviewer.agent", "acl registry show acme.reviewer.agent --json"],
    flags: [
      "--json             Print the agent record as JSON",
      "--directory-url <url> Override the target directory URL"
    ]
  },
  search: {
    name: "registry search",
    summary: "Search public agent records",
    usage: ["acl registry search <query>", "acl registry search <query> --json"],
    examples: ["acl registry search review", "acl registry search architecture --json"],
    flags: [
      "--json             Print the search response as JSON",
      "--limit <n>        Limit results, default 20",
      "--directory-url <url> Override the target directory URL"
    ]
  }
};

const MANIFEST_HELP: Record<ManifestSubcommandName, CommandHelpSpec> = {
  init: {
    name: "manifest init",
    summary: "Generate a registry manifest with sensible defaults",
    usage: ["acl manifest init <agentId>", "acl manifest init <agentId> --out ./agent.json"],
    examples: [
      "acl manifest init acme.reviewer.agent",
      "acl manifest init acme.reviewer.agent --endpoint wss://peer.acme.dev/agents/acme.reviewer.agent",
      "acl manifest init acme.reviewer.agent --capability code.review --capability architecture.plan --out ./agent.json"
    ],
    flags: [
      "--display-name <name>  Override the derived display name",
      "--summary <text>       Override the default summary",
      "--endpoint <url>       Override the default endpoint placeholder",
      "--visibility <value>   public or unlisted, default public",
      "--version <value>      Manifest version, default 0.1.0",
      "--capability <value>   Add a service capability, repeatable",
      "--out <path>           Write the manifest to a file instead of stdout"
    ],
    notes: [
      "The generated manifest is valid input for 'acl registry publish'.",
      "If --endpoint is omitted, ACL generates a placeholder WSS endpoint for the agentId."
    ]
  }
};

const COMMAND_ORDER: CommandName[] = ["resolve", "inspect", "send", "call", "mail", "peer", "registry", "manifest"];
const MAIL_ORDER: MailSubcommandName[] = ["send"];
const PEER_ORDER: PeerSubcommandName[] = ["serve"];
const REGISTRY_ORDER: RegistrySubcommandName[] = ["serve", "claim", "verify", "namespace", "publish", "show", "search"];
const MANIFEST_ORDER: ManifestSubcommandName[] = ["init"];

function isCommandName(value: string | undefined): value is CommandName {
  return value !== undefined && value in COMMAND_HELP;
}

function isMailSubcommandName(value: string | undefined): value is MailSubcommandName {
  return value !== undefined && value in MAIL_HELP;
}

function isPeerSubcommandName(value: string | undefined): value is PeerSubcommandName {
  return value !== undefined && value in PEER_HELP;
}

function isRegistrySubcommandName(value: string | undefined): value is RegistrySubcommandName {
  return value !== undefined && value in REGISTRY_HELP;
}

function isManifestSubcommandName(value: string | undefined): value is ManifestSubcommandName {
  return value !== undefined && value in MANIFEST_HELP;
}

function formatRootHelp(): string {
  const lines = [
    "ACL is a minimal agent-to-agent CLI built on ACP.",
    "",
    "Usage:",
    "  acl <command> [flags]",
    "  acl help [command]",
    "",
    "Available Commands:"
  ];

  for (const name of COMMAND_ORDER) {
    lines.push(`  ${name.padEnd(8)} ${COMMAND_HELP[name].summary}`);
  }

  lines.push(
    "",
    "Global Flags:",
    "  --json                Print structured JSON output when supported",
    "  --jsonl               Stream normalized JSON Lines events when supported",
    "  --directory-url <url> Override ACL_DIRECTORY_URL",
    "  -h, --help            Show help for the command or subcommand",
    "",
    "Examples:",
    "  acl resolve acme.reviewer.agent",
    "  acl inspect acme.reviewer.agent",
    "  acl send acme.reviewer.agent \"review this design\"",
    "  acl call acme.reviewer.agent",
    "  acl mail send acme.mailbox.agent \"hello\" --from codex.mailbox.agent",
    "  acl peer serve --agent-id acme.reviewer.agent --example echo --cert ./.acl/tls/server.cert.pem --key ./.acl/tls/server.key.pem",
    "  acl registry serve",
    "  acl registry claim acme",
    "  acl manifest init acme.reviewer.agent"
  );

  return lines.join("\n");
}

function formatCommandHelp(spec: CommandHelpSpec): string {
  const lines = [`${spec.name} - ${spec.summary}`, "", "Usage:"];

  for (const usageLine of spec.usage) {
    lines.push(`  ${usageLine}`);
  }

  lines.push("", "Examples:");
  for (const example of spec.examples) {
    lines.push(`  ${example}`);
  }

  if (spec.flags.length > 0) {
    lines.push("", "Flags:");
    for (const flag of spec.flags) {
      lines.push(`  ${flag}`);
    }
  }

  if (spec.notes && spec.notes.length > 0) {
    lines.push("", "Notes:");
    for (const note of spec.notes) {
      lines.push(`  ${note}`);
    }
  }

  return lines.join("\n");
}

function formatMailRootHelp(): string {
  const lines = [
    "mail - Send structured mailbox messages with sender and reply metadata",
    "",
    "Usage:",
    "  acl mail <subcommand>",
    "",
    "Available Subcommands:"
  ];

  for (const name of MAIL_ORDER) {
    lines.push(`  ${name.padEnd(10)} ${MAIL_HELP[name].summary}`);
  }

  lines.push(
    "",
    "Examples:",
    "  acl mail send acme.mailbox.agent \"hello\" --from codex.mailbox.agent --reply-to codex.mailbox.agent"
  );
  return lines.join("\n");
}

function formatPeerRootHelp(): string {
  const lines = [
    "peer - Run a local WSS peer daemon that hosts an ACP stdio agent",
    "",
    "Usage:",
    "  acl peer <subcommand>",
    "",
    "Available Subcommands:"
  ];

  for (const name of PEER_ORDER) {
    lines.push(`  ${name.padEnd(10)} ${PEER_HELP[name].summary}`);
  }

  lines.push(
    "",
    "Examples:",
    "  acl peer serve --agent-id acme.reviewer.agent --example echo --cert ./.acl/tls/server.cert.pem --key ./.acl/tls/server.key.pem"
  );
  return lines.join("\n");
}

function formatRegistryRootHelp(): string {
  const lines = [
    "registry - Manage the directory service and registry records",
    "",
    "Usage:",
    "  acl registry <subcommand>",
    "",
    "Available Subcommands:"
  ];

  for (const name of REGISTRY_ORDER) {
    lines.push(`  ${name.padEnd(10)} ${REGISTRY_HELP[name].summary}`);
  }

  lines.push("", "Examples:", "  acl registry serve", "  acl registry claim acme", "  acl registry publish ./agent.json");
  return lines.join("\n");
}

function formatManifestRootHelp(): string {
  const lines = [
    "manifest - Generate and inspect agent manifest files",
    "",
    "Usage:",
    "  acl manifest <subcommand>",
    "",
    "Available Subcommands:"
  ];

  for (const name of MANIFEST_ORDER) {
    lines.push(`  ${name.padEnd(10)} ${MANIFEST_HELP[name].summary}`);
  }

  lines.push("", "Examples:", "  acl manifest init acme.reviewer.agent", "  acl manifest init acme.reviewer.agent --out ./agent.json");
  return lines.join("\n");
}

function extractStringOption(args: string[], flagName: string): { args: string[]; value?: string } {
  const nextArgs: string[] = [];
  let value: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === flagName) {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) {
        throw new CliError(`Missing value for ${flagName}`, 1);
      }
      value = next;
      index += 1;
      continue;
    }

    if (current.startsWith(`${flagName}=`)) {
      value = current.slice(flagName.length + 1);
      continue;
    }

    nextArgs.push(current);
  }

  return { args: nextArgs, value };
}

function extractRepeatedStringOption(args: string[], flagName: string): { args: string[]; values: string[] } {
  const nextArgs: string[] = [];
  const values: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === flagName) {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) {
        throw new CliError(`Missing value for ${flagName}`, 1);
      }
      values.push(next);
      index += 1;
      continue;
    }

    if (current.startsWith(`${flagName}=`)) {
      values.push(current.slice(flagName.length + 1));
      continue;
    }

    nextArgs.push(current);
  }

  return { args: nextArgs, values };
}

function parseEnvAssignments(assignments: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    if (separator <= 0) {
      throw new CliError(`Invalid --env value: ${assignment}. Expected KEY=VALUE`, 1);
    }
    const key = assignment.slice(0, separator);
    const value = assignment.slice(separator + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new CliError(`Invalid environment variable name: ${key}`, 1);
    }
    env[key] = value;
  }
  return env;
}

function parseArgs(argv: string[]): ParsedArgs {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const [command, ...rest] = normalizedArgv;
  const json = rest.includes("--json");
  const jsonl = rest.includes("--jsonl");
  const help = command === "-h" || command === "--help" || rest.includes("-h") || rest.includes("--help");
  const stripped = rest.filter((arg) => arg !== "--json" && arg !== "--jsonl" && arg !== "-h" && arg !== "--help");
  const withDirectoryUrl = extractStringOption(stripped, "--directory-url");
  return { command, args: withDirectoryUrl.args, json, jsonl, help, directoryUrl: withDirectoryUrl.value };
}

function maybeRenderHelp(parsed: ParsedArgs): string | null {
  if (!parsed.command || parsed.command === "-h" || parsed.command === "--help") {
    return formatRootHelp();
  }

  if (parsed.command === "help") {
    if (parsed.args.length === 0) {
      return formatRootHelp();
    }
    const [topic, subtopic] = parsed.args;
    if (topic === "registry") {
      if (!subtopic) {
        return formatRegistryRootHelp();
      }
      if (!isRegistrySubcommandName(subtopic)) {
        throw new CliError(`Unknown help topic: registry ${subtopic}`, 1);
      }
      return formatCommandHelp(REGISTRY_HELP[subtopic]);
    }

    if (topic === "peer") {
      if (!subtopic) {
        return formatPeerRootHelp();
      }
      if (!isPeerSubcommandName(subtopic)) {
        throw new CliError(`Unknown help topic: peer ${subtopic}`, 1);
      }
      return formatCommandHelp(PEER_HELP[subtopic]);
    }

    if (topic === "mail") {
      if (!subtopic) {
        return formatMailRootHelp();
      }
      if (!isMailSubcommandName(subtopic)) {
        throw new CliError(`Unknown help topic: mail ${subtopic}`, 1);
      }
      return formatCommandHelp(MAIL_HELP[subtopic]);
    }

    if (topic === "manifest") {
      if (!subtopic) {
        return formatManifestRootHelp();
      }
      if (!isManifestSubcommandName(subtopic)) {
        throw new CliError(`Unknown help topic: manifest ${subtopic}`, 1);
      }
      return formatCommandHelp(MANIFEST_HELP[subtopic]);
    }

    if (!isCommandName(topic)) {
      throw new CliError(`Unknown help topic: ${topic}`, 1);
    }
    return formatCommandHelp(COMMAND_HELP[topic]);
  }

  if (parsed.command === "mail" && parsed.help) {
    const subcommand = parsed.args[0];
    if (!subcommand) {
      return formatMailRootHelp();
    }
    if (!isMailSubcommandName(subcommand)) {
      throw new CliError(`Unsupported mail command: ${subcommand}`, 1);
    }
    return formatCommandHelp(MAIL_HELP[subcommand]);
  }

  if (parsed.command === "peer" && parsed.help) {
    const subcommand = parsed.args[0];
    if (!subcommand) {
      return formatPeerRootHelp();
    }
    if (!isPeerSubcommandName(subcommand)) {
      throw new CliError(`Unsupported peer command: ${subcommand}`, 1);
    }
    return formatCommandHelp(PEER_HELP[subcommand]);
  }

  if (parsed.command === "registry" && parsed.help) {
    const subcommand = parsed.args[0];
    if (!subcommand) {
      return formatRegistryRootHelp();
    }
    if (!isRegistrySubcommandName(subcommand)) {
      throw new CliError(`Unsupported registry command: ${subcommand}`, 1);
    }
    return formatCommandHelp(REGISTRY_HELP[subcommand]);
  }

  if (parsed.command === "manifest" && parsed.help) {
    const subcommand = parsed.args[0];
    if (!subcommand) {
      return formatManifestRootHelp();
    }
    if (!isManifestSubcommandName(subcommand)) {
      throw new CliError(`Unsupported manifest command: ${subcommand}`, 1);
    }
    return formatCommandHelp(MANIFEST_HELP[subcommand]);
  }

  if (parsed.help) {
    if (!isCommandName(parsed.command)) {
      throw new CliError(`Unsupported command: ${parsed.command}`, 1);
    }
    return formatCommandHelp(COMMAND_HELP[parsed.command]);
  }

  return null;
}

async function readPromptArg(arg: string | undefined): Promise<string> {
  if (!arg) {
    throw new CliError("Missing prompt argument. Run 'acl help send'.", 1);
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

function buildMailPrompt(
  body: string,
  envelope: {
    from: string;
    replyTo: string;
    subject?: string;
  }
): PromptContentBlock[] {
  const envelopeDocument = {
    schema: "acl-mail-v1",
    from: envelope.from,
    replyTo: envelope.replyTo,
    subject: envelope.subject ?? null,
    sentAt: new Date().toISOString()
  };

  return [
    {
      type: "resource",
      resource: {
        uri: "urn:acl:mail-envelope",
        mimeType: "application/json",
        text: JSON.stringify(envelopeDocument)
      }
    },
    {
      type: "text",
      text: body
    }
  ];
}

function emitJsonlEvent(event: string, payload: unknown): void {
  process.stdout.write(`${JSON.stringify({ event, payload })}\n`);
}

function formatNamespaceRecord(record: NamespaceRecord): string {
  const lines = [`namespace: ${record.namespace}`, `status: ${record.status}`, `verificationMethod: ${record.verificationMethod}`];
  if (record.challenge) {
    lines.push(`challenge.name: ${record.challenge.name}`, `challenge.value: ${record.challenge.value}`);
  }
  if (record.verifiedAt) {
    lines.push(`verifiedAt: ${record.verifiedAt}`);
  }
  return lines.join("\n");
}

function formatAgentRecord(record: PublishAgentRequest & { agentId: string; updatedAt?: string }): string {
  return [
    `agentId: ${record.agentId}`,
    `displayName: ${record.displayName}`,
    `visibility: ${record.visibility}`,
    `version: ${record.version}`,
    `updatedAt: ${record.updatedAt ?? ""}`
  ].join("\n");
}

function formatSearchResults(results: { results: Array<{ agentId: string; displayName: string; summary: string }>; nextCursor: string | null }): string {
  if (results.results.length === 0) {
    return "No registry results found";
  }
  return results.results
    .map((record) => [record.agentId, `  displayName: ${record.displayName}`, `  summary: ${record.summary}`].join("\n"))
    .join("\n");
}

function createLookupDirectoryClient(directoryUrl: string | undefined, directoryFixturePath?: string): DirectoryClient {
  if (directoryUrl) {
    return createHttpDirectoryClient(directoryUrl);
  }
  if (directoryFixturePath) {
    return new MockDirectoryClient(directoryFixturePath);
  }
  return EMPTY_DIRECTORY_CLIENT;
}

function createRegistryClient(directoryUrl: string | undefined): DirectoryRegistryClient {
  if (!directoryUrl) {
    throw new CliError("Registry commands require ACL_DIRECTORY_URL or --directory-url. Run 'acl help registry'.", 1);
  }
  return createHttpDirectoryClient(directoryUrl);
}

function parseManifestDocument(document: Record<string, unknown>): { agentId: string; request: PublishAgentRequest } {
  if (typeof document.agentId !== "string") {
    throw new CliError("Manifest must include agentId", 1);
  }

  return {
    agentId: document.agentId,
    request: {
      displayName: String(document.displayName ?? ""),
      summary: String(document.summary ?? ""),
      protocols: document.protocols as PublishAgentRequest["protocols"],
      endpoints: document.endpoints as PublishAgentRequest["endpoints"],
      serviceCapabilities: Array.isArray(document.serviceCapabilities)
        ? document.serviceCapabilities.map((value) => String(value))
        : [],
      visibility: document.visibility as PublishAgentRequest["visibility"],
      version: String(document.version ?? "")
    }
  };
}

async function readManifestFile(path: string): Promise<{ agentId: string; request: PublishAgentRequest }> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return parseManifestDocument(parsed);
}

function titleCaseSegment(segment: string): string {
  return segment
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function deriveDisplayName(agentId: string): string {
  const labels = agentId.split(".").slice(0, -1);
  return labels.map(titleCaseSegment).join(" ");
}

function createDefaultManifest(agentId: string): { agentId: string; request: PublishAgentRequest } {
  return {
    agentId,
    request: {
      displayName: deriveDisplayName(agentId),
      summary: "ACP agent published through ACL",
      protocols: {
        acp: [1]
      },
      endpoints: [
        {
          transport: "wss",
          url: `wss://example.com/agents/${agentId}`,
          priority: 0
        }
      ],
      serviceCapabilities: [],
      visibility: "public",
      version: "0.1.0"
    }
  };
}

async function runManifestCommand(args: string[], options: { json: boolean; jsonl: boolean }): Promise<void> {
  if (options.jsonl) {
    throw new CliError("--jsonl is not supported for manifest commands", 1);
  }

  const [subcommand, ...rest] = args;
  if (!subcommand) {
    console.log(formatManifestRootHelp());
    return;
  }

  if (!isManifestSubcommandName(subcommand)) {
    throw new CliError(`Unsupported manifest command: ${subcommand}`, 1);
  }

  switch (subcommand) {
    case "init": {
      const displayNameOption = extractStringOption(rest, "--display-name");
      const summaryOption = extractStringOption(displayNameOption.args, "--summary");
      const endpointOption = extractStringOption(summaryOption.args, "--endpoint");
      const visibilityOption = extractStringOption(endpointOption.args, "--visibility");
      const versionOption = extractStringOption(visibilityOption.args, "--version");
      const outOption = extractStringOption(versionOption.args, "--out");
      const capabilityOption = extractRepeatedStringOption(outOption.args, "--capability");
      const [agentId] = capabilityOption.args;

      if (!agentId) {
        throw new CliError("Missing agentId. Run 'acl help manifest init'.", 1);
      }
      if (!HANDLE_PATTERN.test(agentId) || agentId.split(".").length < 3) {
        throw new CliError("manifest init requires a lowercase namespaced agentId ending in .agent", 1, { agentId });
      }
      if (capabilityOption.args.length > 1) {
        throw new CliError(`Unexpected arguments for manifest init: ${capabilityOption.args.slice(1).join(" ")}`, 1);
      }

      const manifest = createDefaultManifest(agentId);
      if (displayNameOption.value) {
        manifest.request.displayName = displayNameOption.value;
      }
      if (summaryOption.value) {
        manifest.request.summary = summaryOption.value;
      }
      if (endpointOption.value) {
        manifest.request.endpoints[0] = {
          transport: "wss",
          url: endpointOption.value,
          priority: 0
        };
      }
      if (visibilityOption.value) {
        if (visibilityOption.value !== "public" && visibilityOption.value !== "unlisted") {
          throw new CliError("--visibility must be public or unlisted", 1);
        }
        manifest.request.visibility = visibilityOption.value;
      }
      if (versionOption.value) {
        manifest.request.version = versionOption.value;
      }
      if (capabilityOption.values.length > 0) {
        manifest.request.serviceCapabilities = capabilityOption.values;
      }

      const document = {
        agentId: manifest.agentId,
        ...manifest.request
      };
      const serialized = `${JSON.stringify(document, null, 2)}\n`;

      if (outOption.value) {
        const outputPath = resolvePath(outOption.value);
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, serialized, "utf8");
        if (options.json) {
          console.log(
            JSON.stringify(
              {
                path: outputPath,
                manifest: document
              },
              null,
              2
            )
          );
        } else {
          console.log(`Wrote manifest: ${outputPath}`);
        }
        return;
      }

      console.log(serialized.trimEnd());
      return;
    }
  }
}

async function runMailCommand(
  daemon: PeerDaemon,
  args: string[],
  options: { json: boolean; jsonl: boolean }
): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand) {
    console.log(formatMailRootHelp());
    return;
  }

  if (!isMailSubcommandName(subcommand)) {
    throw new CliError(`Unsupported mail command: ${subcommand}`, 1);
  }

  switch (subcommand) {
    case "send": {
      const fromOption = extractStringOption(rest, "--from");
      const replyToOption = extractStringOption(fromOption.args, "--reply-to");
      const subjectOption = extractStringOption(replyToOption.args, "--subject");
      const [target, bodyArg, ...unexpected] = subjectOption.args;

      if (unexpected.length > 0) {
        throw new CliError(`Unexpected arguments for mail send: ${unexpected.join(" ")}`, 1);
      }
      if (!target) {
        throw new CliError("Missing target. Run 'acl help mail send'.", 1);
      }
      if (!fromOption.value) {
        throw new CliError("mail send requires --from <agentId>", 1);
      }
      if (!HANDLE_PATTERN.test(fromOption.value)) {
        throw new CliError("mail send requires a lowercase sender agentId ending in .agent", 1, {
          from: fromOption.value
        });
      }

      const body = await readPromptArg(bodyArg);
      const prompt = buildMailPrompt(body, {
        from: fromOption.value,
        replyTo: replyToOption.value ?? fromOption.value,
        subject: subjectOption.value
      });

      if (options.jsonl) {
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
          const result = await session.prompt(prompt, {
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

      const result = await daemon.send(target, prompt);
      console.log(options.json ? JSON.stringify(result, null, 2) : formatSendResult(result));
      if (result.locallyCancelled) {
        process.exitCode = 7;
      }
      return;
    }
  }
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

function resolveExampleAgent(exampleName: string): { command: string; args: string[] } {
  if (exampleName === "echo") {
    return {
      command: process.execPath,
      args: [EXAMPLE_ECHO_AGENT_PATH]
    };
  }

  if (exampleName === "mailbox") {
    return {
      command: process.execPath,
      args: [EXAMPLE_MAILBOX_AGENT_PATH]
    };
  }

  if (exampleName === "claude") {
    return {
      command: process.execPath,
      args: [EXAMPLE_CLAUDE_AGENT_PATH]
    };
  }

  throw new CliError(`Unsupported example agent: ${exampleName}`, 1, {
    supported: ["echo", "mailbox", "claude"]
  });
}

async function runPeerServe(args: string[], options: { json: boolean; jsonl: boolean }): Promise<void> {
  if (options.jsonl) {
    throw new CliError("--jsonl is not supported for peer serve", 1);
  }

  const hostOption = extractStringOption(args, "--host");
  const portOption = extractStringOption(hostOption.args, "--port");
  const certOption = extractStringOption(portOption.args, "--cert");
  const keyOption = extractStringOption(certOption.args, "--key");
  const agentIdOption = extractStringOption(keyOption.args, "--agent-id");
  const serviceRootOption = extractStringOption(agentIdOption.args, "--service-root");
  const exampleOption = extractStringOption(serviceRootOption.args, "--example");
  const commandOption = extractStringOption(exampleOption.args, "--command");
  const argOption = extractRepeatedStringOption(commandOption.args, "--arg");
  const envOption = extractRepeatedStringOption(argOption.args, "--env");

  if (envOption.args.length > 0) {
    throw new CliError(`Unexpected arguments for peer serve: ${envOption.args.join(" ")}`, 1);
  }

  const host = hostOption.value ?? "127.0.0.1";
  const port = portOption.value ? Number.parseInt(portOption.value, 10) : 7443;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliError("peer serve requires a valid TCP port; use 0 for an ephemeral port", 1);
  }

  const certPath = certOption.value ? resolvePath(certOption.value) : null;
  const keyPath = keyOption.value ? resolvePath(keyOption.value) : null;
  const agentId = agentIdOption.value;
  const serviceRoot = resolvePath(serviceRootOption.value ?? process.cwd());

  if (!certPath || !keyPath) {
    throw new CliError("peer serve requires --cert and --key", 1);
  }
  if (!agentId) {
    throw new CliError("peer serve requires --agent-id", 1);
  }
  if (!HANDLE_PATTERN.test(agentId)) {
    throw new CliError("peer serve requires a lowercase agentId ending in .agent", 1, { agentId });
  }

  const hasExample = Boolean(exampleOption.value);
  const hasCommand = Boolean(commandOption.value);
  if (hasExample === hasCommand) {
    throw new CliError("peer serve requires exactly one of --example or --command", 1);
  }

  const adapterEnv = envOption.values.length > 0 ? parseEnvAssignments(envOption.values) : undefined;
  const adapter = hasExample
    ? {
        ...resolveExampleAgent(exampleOption.value!),
        env: adapterEnv
      }
    : {
        command: commandOption.value!,
        args: argOption.values,
        env: adapterEnv
      };

  const daemon = new PeerDaemon(
    new JsonContactsStore(process.env.ACL_CONTACTS_FILE ?? join(homedir(), ".config", "acl", "contacts.json")),
    EMPTY_DIRECTORY_CLIENT
  );
  daemon.registerHostedAgent({
    agentId,
    serviceRoot,
    adapter
  });

  const server = await daemon.startServer({
    host,
    port,
    certPath,
    keyPath
  });

  const certificatePem = await readFile(certPath, "utf8");
  const peerId = derivePeerIdFromCertificatePem(certificatePem);
  const endpoint = `wss://${server.port === 443 ? host : `${host}:${server.port}`}/agents/${agentId}`;
  const payload = {
    host,
    port: server.port,
    agentId,
    serviceRoot,
    endpoint,
    peerId
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`Peer daemon listening at ${endpoint}`);
    console.log(`peerId: ${peerId}`);
    console.log(`agentId: ${agentId}`);
    console.log(`serviceRoot: ${serviceRoot}`);
  }

  await new Promise<void>((resolve, reject) => {
    const shutdown = () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      void daemon
        .stopServer()
        .then(resolve, reject);
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function runRegistryServe(args: string[]): Promise<void> {
  const hostOption = extractStringOption(args, "--host");
  const portOption = extractStringOption(hostOption.args, "--port");
  const stateFileOption = extractStringOption(portOption.args, "--state-file");
  if (stateFileOption.args.length > 0) {
    throw new CliError(`Unexpected arguments for registry serve: ${stateFileOption.args.join(" ")}`, 1);
  }

  const host = hostOption.value ?? "127.0.0.1";
  const port = portOption.value ? Number.parseInt(portOption.value, 10) : 4040;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError("registry serve requires a valid TCP port", 1);
  }

  const stateFilePath = resolvePath(stateFileOption.value ?? join(process.cwd(), ".acl", "directory-state.json"));
  const server = await startDirectoryServer({
    host,
    port,
    stateFilePath
  });

  console.log(`Directory server listening at http://${server.host}:${server.port}`);
  console.log(`State file: ${stateFilePath}`);

  await new Promise<void>((resolve, reject) => {
    const shutdown = () => {
      void server.close().then(resolve, reject);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function runRegistryCommand(args: string[], options: { json: boolean; jsonl: boolean; directoryUrl?: string }): Promise<void> {
  if (options.jsonl) {
    throw new CliError("--jsonl is not supported for registry commands", 1);
  }

  const [subcommand, ...rest] = args;
  if (!subcommand) {
    console.log(formatRegistryRootHelp());
    return;
  }

  if (!isRegistrySubcommandName(subcommand)) {
    throw new CliError(`Unsupported registry command: ${subcommand}`, 1);
  }

  if (subcommand === "serve") {
    await runRegistryServe(rest);
    return;
  }

  const registry = createRegistryClient(options.directoryUrl ?? process.env.ACL_DIRECTORY_URL);

  switch (subcommand) {
    case "claim": {
      const namespace = rest[0];
      if (!namespace) throw new CliError("Missing namespace. Run 'acl help registry claim'.", 1);
      const record = await registry.claimNamespace({
        namespace,
        verificationMethod: "dns_txt"
      });
      console.log(options.json ? JSON.stringify(record, null, 2) : formatNamespaceRecord(record));
      return;
    }
    case "verify": {
      const namespace = rest[0];
      const proof = rest[1];
      if (!namespace || !proof) throw new CliError("Usage: acl registry verify <namespace> <proof>", 1);
      const record = await registry.verifyNamespace(namespace, { proof });
      console.log(options.json ? JSON.stringify(record, null, 2) : formatNamespaceRecord(record));
      return;
    }
    case "namespace": {
      const namespace = rest[0];
      if (!namespace) throw new CliError("Missing namespace. Run 'acl help registry namespace'.", 1);
      const record = await registry.getNamespace(namespace);
      if (!record) {
        throw new CliError(`Namespace not found: ${namespace}`, 2);
      }
      console.log(options.json ? JSON.stringify(record, null, 2) : formatNamespaceRecord(record));
      return;
    }
    case "publish": {
      const manifestPath = rest[0];
      if (!manifestPath) throw new CliError("Missing manifest path. Run 'acl help registry publish'.", 1);
      const manifest = await readManifestFile(manifestPath);
      const record = await registry.putAgent(manifest.agentId, manifest.request);
      console.log(options.json ? JSON.stringify(record, null, 2) : formatAgentRecord(record));
      return;
    }
    case "show": {
      const agentId = rest[0];
      if (!agentId) throw new CliError("Missing agentId. Run 'acl help registry show'.", 1);
      const record = await registry.getAgent(agentId);
      if (!record) {
        throw new CliError(`Agent not found: ${agentId}`, 2);
      }
      console.log(options.json ? JSON.stringify(record, null, 2) : formatAgentRecord(record));
      return;
    }
    case "search": {
      const limitOption = extractStringOption(rest, "--limit");
      const query = limitOption.args.join(" ").trim();
      if (!query) throw new CliError("Missing search query. Run 'acl help registry search'.", 1);
      const parsedLimit = limitOption.value ? Number.parseInt(limitOption.value, 10) : null;
      if (parsedLimit !== null && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
        throw new CliError("--limit must be a positive integer", 1);
      }
      const limit = parsedLimit ?? undefined;
      const results = await registry.search(query, limit);
      console.log(options.json ? JSON.stringify(results, null, 2) : formatSearchResults(results));
      return;
    }
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const { command, args, json, jsonl, directoryUrl } = parsed;
  activeJsonl = jsonl;
  if (json && jsonl) {
    throw new CliError("Choose only one of --json or --jsonl", 1);
  }

  const helpText = maybeRenderHelp(parsed);
  if (helpText) {
    console.log(helpText);
    return;
  }

  if (command === "registry") {
    await runRegistryCommand(args, { json, jsonl, directoryUrl });
    return;
  }

  if (command === "peer") {
    const [subcommand, ...rest] = args;
    if (!subcommand) {
      console.log(formatPeerRootHelp());
      return;
    }
    if (!isPeerSubcommandName(subcommand)) {
      throw new CliError(`Unsupported peer command: ${subcommand}`, 1);
    }
    switch (subcommand) {
      case "serve":
        await runPeerServe(rest, { json, jsonl });
        return;
    }
  }

  if (command === "manifest") {
    await runManifestCommand(args, { json, jsonl });
    return;
  }

  const contactsFilePath =
    process.env.ACL_CONTACTS_FILE ?? join(homedir(), ".config", "acl", "contacts.json");
  const contacts = new JsonContactsStore(contactsFilePath);
  const directoryFixturePath = process.env.ACL_DIRECTORY_FIXTURE;
  const directory = createLookupDirectoryClient(directoryUrl ?? process.env.ACL_DIRECTORY_URL, directoryFixturePath);
  const daemon = new PeerDaemon(contacts, directory, {
    transport: {
      caCertPath: process.env.ACL_TLS_CA_CERT
    }
  });

  if (command === "mail") {
    await runMailCommand(daemon, args, { json, jsonl });
    return;
  }

  switch (command) {
    case "resolve": {
      const target = args[0];
      if (!target) throw new CliError("Missing target. Run 'acl help resolve'.", 1);
      const resolved = await daemon.resolveTarget(target);
      console.log(json ? JSON.stringify(resolved, null, 2) : formatResolvedTarget(resolved));
      return;
    }
    case "inspect": {
      const target = args[0];
      if (!target) throw new CliError("Missing target. Run 'acl help inspect'.", 1);
      const result = await daemon.inspect(target);
      console.log(json ? JSON.stringify(result, null, 2) : formatInspectResult(result));
      return;
    }
    case "send": {
      const target = args[0];
      if (!target) throw new CliError("Missing target. Run 'acl help send'.", 1);
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
      if (!target) throw new CliError("Missing target. Run 'acl help call'.", 1);
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

main().catch((error: unknown) => {
  if (activeJsonl) {
    emitJsonlEvent(
      "error",
      error instanceof CliError
        ? { message: error.message, details: error.details }
        : { message: error instanceof Error ? error.message : String(error) }
    );
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
