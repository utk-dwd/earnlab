export interface EarnlabClientConfig {
  baseUrl: string;
  timeoutMs: number;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
