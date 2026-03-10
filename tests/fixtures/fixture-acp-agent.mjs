#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

let sessionId = null;
let activePrompt = null;
let nextPermissionRequestId = 10_000;
const pendingPermissionRequests = new Map();
const authRequired = process.env.ACL_FIXTURE_AUTH_REQUIRED === "1";
let authenticated = !authRequired;

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

function startHoldPrompt(promptRequestId, currentSessionId, promptText) {
  activePrompt = {
    requestId: promptRequestId,
    sessionId: currentSessionId,
    mode: "hold",
    promptText,
    timer: null
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

  activePrompt.timer = setTimeout(() => {
    if (!activePrompt || activePrompt.requestId !== promptRequestId) {
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
            text: " complete"
          }
        }
      }
    });

    finishPrompt("end_turn");
  }, 1500);
}

async function handleMessage(line) {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);

  if (Object.prototype.hasOwnProperty.call(message, "id") && Object.prototype.hasOwnProperty.call(message, "result")) {
    const pendingPermission = pendingPermissionRequests.get(message.id);
    if (!pendingPermission) {
      return;
    }

    pendingPermissionRequests.delete(message.id);
    const outcome = message.result?.outcome;
    if (outcome?.outcome === "cancelled") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: pendingPermission.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "Permission request cancelled"
            }
          }
        }
      });
      finishPrompt("cancelled");
      return;
    }

    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: pendingPermission.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Permission rejected"
          }
        }
      }
    });
    finishPrompt("end_turn");
    return;
  }

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
          version: "0.2.0"
        },
        authMethods: authRequired
          ? [
              {
                id: "fixture-auth",
                name: "Fixture Auth"
              }
            ]
          : []
      }
    });
    return;
  }

  if (message.method === "authenticate") {
    if (!authRequired) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32602,
          message: "authenticate_not_supported"
        }
      });
      return;
    }

    if (message.params?.methodId !== "fixture-auth") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32602,
          message: "invalid_auth_method"
        }
      });
      return;
    }

    authenticated = true;
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {}
    });
    return;
  }

  if (message.method === "session/new") {
    if (!authenticated) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32001,
          message: "auth_required"
        }
      });
      return;
    }

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
    const promptText = textFromPrompt(message.params?.prompt);

    if (promptText.startsWith("[invalid-stdout]")) {
      process.stdout.write("not-json\n");
      return;
    }

    if (promptText.startsWith("[crash]")) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params?.sessionId ?? sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "About to crash"
            }
          }
        }
      });
      process.exit(1);
    }

    if (promptText.startsWith("[hold]")) {
      startHoldPrompt(message.id, message.params?.sessionId ?? sessionId, promptText);
      return;
    }

    activePrompt = {
      requestId: message.id,
      sessionId: message.params?.sessionId ?? sessionId,
      mode: "normal",
      promptText,
      timer: null
    };

    if (promptText.startsWith("[permission]")) {
      const permissionRequestId = nextPermissionRequestId++;
      pendingPermissionRequests.set(permissionRequestId, {
        sessionId: activePrompt.sessionId,
        promptRequestId: activePrompt.requestId
      });

      send({
        jsonrpc: "2.0",
        id: permissionRequestId,
        method: "session/request_permission",
        params: {
          sessionId: activePrompt.sessionId,
          toolCall: {
            toolCallId: "tool_permission_fixture"
          },
          options: [
            {
              optionId: "reject-once",
              name: "Reject",
              kind: "reject_once"
            }
          ]
        }
      });
      return;
    }

    if (promptText.startsWith("[permission-cancel]")) {
      const permissionRequestId = nextPermissionRequestId++;
      pendingPermissionRequests.set(permissionRequestId, {
        sessionId: activePrompt.sessionId,
        promptRequestId: activePrompt.requestId
      });

      send({
        jsonrpc: "2.0",
        id: permissionRequestId,
        method: "session/request_permission",
        params: {
          sessionId: activePrompt.sessionId,
          toolCall: {
            toolCallId: "tool_permission_cancel_fixture"
          },
          options: [
            {
              optionId: "allow-once",
              name: "Allow once",
              kind: "allow_once"
            }
          ]
        }
      });
      return;
    }

    const responseText = promptText ? `Echo: ${promptText}` : "Echo:";

    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: activePrompt.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: responseText
          }
        }
      }
    });

    finishPrompt("end_turn");
    return;
  }

  if (message.method === "session/cancel") {
    if (activePrompt) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: activePrompt.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: " [cancel acknowledged]"
            }
          }
        }
      });
      finishPrompt("cancelled");
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
