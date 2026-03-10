#!/usr/bin/env node

import { appendFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import readline from "node:readline";

const mailboxPath = process.env.ACL_MAILBOX_FILE;

if (!mailboxPath) {
  process.stderr.write("ACL_MAILBOX_FILE is required\n");
  process.exit(1);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

let sessionId = null;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function textFromPrompt(prompt) {
  if (!Array.isArray(prompt)) {
    return "";
  }

  return prompt
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }

      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }

      if (
        block.type === "resource" &&
        block.resource &&
        typeof block.resource === "object" &&
        typeof block.resource.text === "string"
      ) {
        return block.resource.text;
      }

      if (block.type === "resource_link" && typeof block.uri === "string") {
        const name = typeof block.name === "string" ? block.name : block.uri;
        return `resource_link:${name}:${block.uri}`;
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseMailEnvelopeResource(resource) {
  if (!resource || typeof resource !== "object") {
    return null;
  }

  if (resource.uri !== "urn:acl:mail-envelope" || typeof resource.text !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(resource.text);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    if (parsed.schema !== "acl-mail-v1") {
      return null;
    }

    return {
      from: typeof parsed.from === "string" ? parsed.from : null,
      replyTo: typeof parsed.replyTo === "string" ? parsed.replyTo : null,
      subject: typeof parsed.subject === "string" ? parsed.subject : null,
      sentAt: typeof parsed.sentAt === "string" ? parsed.sentAt : null
    };
  } catch {
    return null;
  }
}

function mailboxPayloadFromPrompt(prompt) {
  const payload = {
    envelope: null,
    body: "",
    attachments: []
  };

  if (!Array.isArray(prompt)) {
    return payload;
  }

  const bodyParts = [];

  for (const block of prompt) {
    if (!block || typeof block !== "object") {
      continue;
    }

    if (
      block.type === "resource" &&
      block.resource &&
      typeof block.resource === "object"
    ) {
      const envelope = parseMailEnvelopeResource(block.resource);
      if (envelope) {
        payload.envelope = envelope;
        continue;
      }

      if (typeof block.resource.text === "string") {
        bodyParts.push(block.resource.text);
      }
      continue;
    }

    if (block.type === "text" && typeof block.text === "string") {
      bodyParts.push(block.text);
      continue;
    }

    if (block.type === "resource_link" && typeof block.uri === "string") {
      payload.attachments.push({
        name: typeof block.name === "string" ? block.name : block.uri,
        uri: block.uri
      });
    }
  }

  payload.body = bodyParts.join("\n");
  return payload;
}

async function recordMessage(payload) {
  await mkdir(dirname(mailboxPath), { recursive: true });
  await appendFile(mailboxPath, `${JSON.stringify(payload)}\n`, "utf8");
}

rl.on("line", async (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);

  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: {
            image: false,
            audio: false,
            embeddedContext: true
          },
          sessionCapabilities: {}
        },
        agentInfo: {
          name: "mailbox-acp-agent",
          title: "Mailbox ACP Agent",
          version: "0.1.0"
        },
        authMethods: []
      }
    });
    return;
  }

  if (message.method === "session/new") {
    sessionId = randomUUID();
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        sessionId
      }
    });
    return;
  }

  if (message.method === "session/prompt") {
    const mail = mailboxPayloadFromPrompt(message.params?.prompt);
    const promptText = mail.body || textFromPrompt(message.params?.prompt);
    const currentSessionId = message.params?.sessionId ?? sessionId ?? randomUUID();

    await recordMessage({
      receivedAt: new Date().toISOString(),
      sessionId: currentSessionId,
      from: mail.envelope?.from ?? null,
      replyTo: mail.envelope?.replyTo ?? null,
      subject: mail.envelope?.subject ?? null,
      sentAt: mail.envelope?.sentAt ?? null,
      body: promptText,
      promptText,
      attachments: mail.attachments
    });

    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: currentSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Message stored"
          }
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        stopReason: "end_turn"
      }
    });
    return;
  }

  if (typeof message.id === "string" || typeof message.id === "number") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32601,
        message: `unsupported_method:${message.method ?? "unknown"}`
      }
    });
  }
});
