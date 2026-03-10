#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

let sessionId = null;
let activePromptRequestId = null;

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

      if (block.type === "resource_link" && typeof block.name === "string") {
        return `resource:${block.name}`;
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

async function handleMessage(line) {
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
          name: "fixture-acp-agent",
          title: "Fixture ACP Agent",
          version: "0.1.0"
        },
        authMethods: []
      }
    });
    return;
  }

  if (message.method === "session/new") {
    sessionId = `sess_${randomUUID().replaceAll("-", "")}`;
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
    activePromptRequestId = message.id;
    const promptText = textFromPrompt(message.params?.prompt);
    const responseText = promptText ? `Echo: ${promptText}` : "Echo:";

    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: message.params?.sessionId ?? sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: responseText
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

    activePromptRequestId = null;
    return;
  }

  if (message.method === "session/cancel") {
    if (activePromptRequestId !== null) {
      send({
        jsonrpc: "2.0",
        id: activePromptRequestId,
        result: {
          stopReason: "cancelled"
        }
      });
      activePromptRequestId = null;
    }
    return;
  }

  if (Object.prototype.hasOwnProperty.call(message, "id")) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32601,
        message: `Method not found: ${message.method ?? "unknown"}`
      }
    });
  }
}

for await (const line of rl) {
  await handleMessage(line);
}
