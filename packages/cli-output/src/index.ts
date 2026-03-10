import { type InspectResult, type ResolvedTarget, type SendResult } from "@acl/acl-types";

export function formatResolvedTarget(result: ResolvedTarget): string {
  return [`agentId: ${result.agentId}`, `endpoint: ${result.endpoint.url}`, `source: ${result.source}`].join("\n");
}

export function formatInspectResult(result: InspectResult): string {
  return [
    `agentId: ${result.target.agentId}`,
    `endpoint: ${result.target.endpoint.url}`,
    `peerId: ${result.peerId}`,
    `protocolVersion: ${result.initialize.protocolVersion}`,
    `agentInfo.name: ${result.initialize.agentInfo?.name ?? ""}`
  ].join("\n");
}

export function formatSendResult(result: SendResult): string {
  return result.aggregatedText;
}
