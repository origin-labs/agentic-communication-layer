#!/usr/bin/env node

/**
 * Claude-backed ACP stdio agent.
 *
 * Bridges the ACP protocol (initialize / session/new / session/prompt / session/cancel)
 * to the Claude API via OpenRouter, streaming responses as ACP session/update notifications.
 *
 * Env:
 *   OPENROUTER_API_KEY        – required, OpenRouter API key
 *   ACL_CLAUDE_MODEL          – override model (default: anthropic/claude-sonnet-4)
 *   ACL_CLAUDE_SYSTEM         – system prompt override
 *   ACL_CLAUDE_MAX_TOKENS     – max response tokens (default: 2048)
 */

import { randomUUID } from "node:crypto";
import readline from "node:readline";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  process.stderr.write("OPENROUTER_API_KEY is required\n");
  process.exit(1);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

const systemPrompt =
  process.env.ACL_CLAUDE_SYSTEM ??
  "You are an AI assistant reachable over the Agentic Communication Layer (ACL). " +
    "Answer concisely and helpfully.";

const model = process.env.ACL_CLAUDE_MODEL ?? "anthropic/claude-sonnet-4";
const maxTokens = parseInt(process.env.ACL_CLAUDE_MAX_TOKENS ?? "2048", 10);

let sessionId = null;
let activeAbort = null;
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

      if (block.type === "resource_link" && typeof block.uri === "string") {
        const name = typeof block.name === "string" ? block.name : block.uri;
        return `resource_link:${name}:${block.uri}`;
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function finishPrompt(requestId, stopReason) {
  send({
    jsonrpc: "2.0",
    id: requestId,
    result: { stopReason },
  });

  activeAbort = null;
  activePromptRequestId = null;
}

function emitTextChunk(currentSessionId, text) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: currentSessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
}

async function handlePrompt(requestId, currentSessionId, promptText) {
  activePromptRequestId = requestId;

  const abortController = new AbortController();
  activeAbort = abortController;

  try {
    const response = await fetch(OPENROUTER_BASE, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: promptText },
        ],
        max_tokens: maxTokens,
        stream: true,
      }),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      emitTextChunk(
        currentSessionId,
        `[API error ${response.status}: ${errorBody}]`
      );
      finishPrompt(requestId, "end_turn");
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) {
          continue;
        }

        const data = line.slice(6).trim();

        if (data === "[DONE]") {
          continue;
        }

        try {
          const event = JSON.parse(data);
          const delta = event.choices?.[0]?.delta?.content;

          if (typeof delta === "string" && delta.length > 0) {
            emitTextChunk(currentSessionId, delta);
          }
        } catch {
          // Skip malformed SSE chunks
        }
      }
    }

    finishPrompt(requestId, "end_turn");
  } catch (error) {
    if (error.name === "AbortError") {
      emitTextChunk(currentSessionId, " [cancel acknowledged]");
      finishPrompt(requestId, "cancelled");
      return;
    }

    emitTextChunk(
      currentSessionId,
      `[Error: ${error.message}]`
    );
    finishPrompt(requestId, "end_turn");
  }
}

for await (const line of rl) {
  if (!line.trim()) {
    continue;
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
            embeddedContext: true,
          },
          sessionCapabilities: {},
        },
        agentInfo: {
          name: "claude-acp-agent",
          title: "Claude ACP Agent",
          version: "0.2.0",
        },
        authMethods: [],
      },
    });
    continue;
  }

  if (message.method === "session/new") {
    sessionId = randomUUID();
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { sessionId },
    });
    continue;
  }

  if (message.method === "session/prompt") {
    const promptText = textFromPrompt(message.params?.prompt);
    const currentSessionId =
      message.params?.sessionId ?? sessionId ?? randomUUID();
    await handlePrompt(message.id, currentSessionId, promptText);
    continue;
  }

  if (message.method === "session/cancel") {
    if (activeAbort && !activeAbort.signal.aborted) {
      activeAbort.abort();
    }
    continue;
  }

  if (typeof message.id === "string" || typeof message.id === "number") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32601,
        message: `unsupported_method:${message.method ?? "unknown"}`,
      },
    });
  }
}
