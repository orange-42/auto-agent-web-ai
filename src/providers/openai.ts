import axios from "axios";
import { LLMMessage, ToolDefinition } from "../types";
import { LLMProvider, LLMResponse } from "./base";

export class OpenAIProvider extends LLMProvider {
  constructor(private apiKey: string, private baseUrl: string = "https://api.openai.com/v1") {
    super();
  }

  async generateResponse(messages: LLMMessage[], tools?: ToolDefinition[], signal?: AbortSignal): Promise<LLMResponse> {
    const response = await axios.post(`${this.baseUrl}/chat/completions`, {
      model: "gpt-4o",
      messages: messages,
      tools: tools?.map(t => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters
        }
      }))
    }, {
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      signal
    });

    const choice = response.data.choices[0].message;
    
    return {
      content: choice.content,
      tool_calls: choice.tool_calls
    };
  }
}
