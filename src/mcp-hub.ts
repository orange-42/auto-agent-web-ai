import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from 'fs';
import path from 'path';

interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

export class MCPHub {
  private clients: Map<string, Client> = new Map();
  private configs: Record<string, MCPServerConfig> = {};
  private toolsCache: any[] | null = null;

  constructor(configPath: string) {
    const config: MCPConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    this.configs = config.mcpServers;
  }

  async initialize() {
    console.log("🚀 Initializing Feishu Agent MCP Hub...");
    const promises = Object.entries(this.configs).map(async ([name, config]) => {
      try {
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: { ...(process.env as any), ...(config.env as any) }
        });

        const client = new Client({
          name: "feishu-to-code-agent",
          version: "1.0.0"
        }, {
          capabilities: {}
        });

        await client.connect(transport);
        this.clients.set(name, client);
        console.log(`✅ Connected to MCP server: ${name}`);
      } catch (error) {
        console.error(`❌ Failed to connect to MCP server ${name}:`, error instanceof Error ? error.message : String(error));
      }
    });

    await Promise.allSettled(promises);
    // 预热工具缓存
    await this.getAllTools();
  }

  async getAllTools() {
    if (this.toolsCache) return this.toolsCache;

    console.log("📡 Fetching tools from all MCP servers...");
    const allTools: any[] = [];
    for (const [name, client] of this.clients.entries()) {
      try {
        const response = await client.listTools();
        if (response?.tools) {
          for (const tool of response.tools) {
            allTools.push({
              ...tool,
              serverName: name,
              fullName: `${name}:${tool.name}`
            });
          }
        }
      } catch (error) {
        console.error(`⚠️ Skipping tools for ${name}:`, error);
      }
    }
    this.toolsCache = allTools;
    return allTools;
  }

  private logToolCall(serverName: string, toolName: string, args: any, response: any) {
    const timestamp = new Date().toISOString();
    const harnessDir = path.join(process.cwd(), ".harness");
    if (!fs.existsSync(harnessDir)) fs.mkdirSync(harnessDir, { recursive: true });
    const logPath = path.join(harnessDir, "mcp_tools.log");
    const logEntry = `\n[${timestamp}] 🛠️ SERVER: ${serverName} | TOOL: ${toolName}\n` +
                     `👉 ARGS: ${JSON.stringify(args, null, 2)}\n` +
                     `✅ RESPONSE: ${JSON.stringify(response, null, 2)}\n` +
                     `--------------------------------------------------\n`;
    fs.appendFileSync(logPath, logEntry);
  }

  public async callTool(fullName: string, args: any) {
    // 💡 保持向后兼容：解析 server:tool 格式
    const [serverName, toolName] = fullName.includes(':') ? fullName.split(':') : fullName.split('__');
    
    if (!serverName || !toolName) {
      throw new Error(`Invalid tool name format: ${fullName}. Expected 'server:tool' or 'server__tool'`);
    }

    // 🚀 核心加固：参数自动对齐 (Parameter Adapter)
    // 专门针对 Gemma 等模型的“参数名幻觉”
    let adaptedArgs = { ...args };
    if (serverName === 'lark-feishu') {
        if (toolName === 'fetch_doc' || toolName === 'resolve_wiki_token') {
            if (adaptedArgs.url && !adaptedArgs.doc_url_or_token) {
                adaptedArgs.doc_url_or_token = adaptedArgs.url;
                delete adaptedArgs.url;
            }
        }
        if (toolName === 'search_wiki_node' && adaptedArgs.name && !adaptedArgs.title) {
            adaptedArgs.title = adaptedArgs.name;
        }
    }

    const server = this.clients.get(serverName);
    if (!server) throw new Error(`MCP Server ${serverName} not found. Available servers: ${Array.from(this.clients.keys()).join(', ')}`);
    
    const response = await server.callTool({ name: toolName, arguments: adaptedArgs });
    
    // 📝 记录审计日志 (记录修正后的参数)
    this.logToolCall(serverName, toolName, adaptedArgs, response);
    
    return response;
  }

  public getTools(toolNames: string[]): any[] | undefined {
    if (!this.toolsCache || toolNames.length === 0) return undefined;
    return this.toolsCache.filter(t => toolNames.includes(t.serverName) || toolNames.includes(t.fullName));
  }

  async stop() {
    for (const client of this.clients.values()) {
      await client.close();
    }
    this.toolsCache = null;
  }
}
