import { LLMMessage, ToolDefinition } from "../types";

export interface LLMResponse {
  content: string;
  tool_calls?: any[];
}

export abstract class LLMProvider {
  abstract generateResponse(messages: LLMMessage[], tools?: ToolDefinition[], signal?: AbortSignal): Promise<LLMResponse>;
}
