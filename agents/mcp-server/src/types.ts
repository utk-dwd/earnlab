import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface EarnlabClientConfig {
  baseUrl: string;
  timeoutMs: number;
}

export type ToolResult = CallToolResult;

export function asToolResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

export function asToolError(message: string): ToolResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}
