#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

let sessionId = null;
let activePrompt = null;

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

function finishPrompt(stopReason) {
  if (!activePrompt) {
    return;
  }

  if (activePrompt.timer) {
    clearTimeout(activePrompt.timer);
  }

  send({
    jsonrpc: "2.0",
    id: activePrompt.requestId,
    result: {
      stopReason
    }
  });

  activePrompt = null;
}

rl.on("line", (line) => {
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
          name: "echo-acp-agent",
          title: "Echo ACP Agent",
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
    const promptText = textFromPrompt(message.params?.prompt);
    const currentSessionId = message.params?.sessionId ?? sessionId;

    if (promptText.includes("[hold]")) {
      activePrompt = {
        requestId: message.id,
        sessionId: currentSessionId,
        timer: setTimeout(() => {
          if (!activePrompt || activePrompt.requestId !== message.id) {
            return;
          }

          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: currentSessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: `Echo: ${promptText}`
                }
              }
            }
          });
          finishPrompt("end_turn");
        }, 1500)
      };

      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: currentSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `Working on: ${promptText}`
            }
          }
        }
      });
      return;
    }

    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: currentSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `Echo: ${promptText}`
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

  if (message.method === "session/cancel") {
    if (!activePrompt) {
      return;
    }

    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: activePrompt.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "[cancel acknowledged]"
          }
        }
      }
    });

    finishPrompt("cancelled");
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
