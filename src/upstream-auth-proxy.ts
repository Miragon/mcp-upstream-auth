import { MCPServer } from "mcp-use/server";
import { MCPClient } from "mcp-use/client";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { randomUUID } from "node:crypto";
import { ServerSideOAuthProvider } from "./oauth-provider.js";
import { SessionStore } from "./session-store.js";
import { jsonSchemaToZod } from "./json-schema-to-zod.js";
import type { ServerEntry, UpstreamAuthProxyOptions } from "./types.js";

export class UpstreamAuthProxy {
  readonly server: MCPServer;
  readonly store = new SessionStore();

  private readonly baseUrl: string;
  private readonly servers: Record<string, ServerEntry>;
  private readonly registeredTools = new Set<string>();

  constructor(options: UpstreamAuthProxyOptions) {
    this.baseUrl = options.baseUrl;
    this.servers = options.servers;

    this.server = new MCPServer({
      name: options.name ?? "MCPProxy",
      version: options.version ?? "1.0.0",
      host: "0.0.0.0",
      oauth: options.oauth,
    });

    this.setupOAuthCallback();
    this.registerAuthTools();
    this.setupToolFilter();
  }

  async listen(port: number): Promise<void> {
    await this.server.listen(port);

    const names = Object.keys(this.servers).join(", ");
    console.log(`MCP Proxy running on ${this.baseUrl}/mcp`);
    console.log(`Upstream servers: ${names}`);
    console.log(
      `Each server exposes a {server}_authenticate tool. Forward tools appear after the browser flow finishes.`
    );
  }

  // --- OAuth callback route (upstream IdP → proxy) ---

  private setupOAuthCallback(): void {
    this.server.app.get("/oauth/callback/:serverName", async (c) => {
      const serverName = c.req.param("serverName");
      const code = c.req.query("code");
      const state = c.req.query("state");

      if (!code || !state) {
        return c.text("Missing code or state parameter", 400);
      }

      const pending = this.store.getPending(state);
      if (!pending) {
        return c.text("Unknown or expired OAuth state", 400);
      }

      if (pending.serverName !== serverName) {
        return c.text("Server name mismatch", 400);
      }

      try {
        const result = await auth(pending.provider, {
          serverUrl: this.servers[serverName].url,
          authorizationCode: code,
        });

        if (result !== "AUTHORIZED") {
          return c.text("Token exchange failed", 500);
        }

        await this.createUpstreamSession(
          pending.userId,
          serverName,
          this.servers[serverName].url,
          pending.provider
        );

        this.notifyToolsListChanged(pending.inboundSessionId);
        this.store.deletePending(state);

        return c.html(
          "<html><body><h1>Authentication successful!</h1><p>You can close this window and continue in Claude.</p></body></html>"
        );
      } catch (err: any) {
        return c.text(`OAuth error: ${err.message}`, 500);
      }
    });
  }

  // --- Register authenticate tool per upstream server ---

  private registerAuthTools(): void {
    for (const [serverName, config] of Object.entries(this.servers)) {
      const callbackUrl = `${this.baseUrl}/oauth/callback/${serverName}`;

      this.server.tool(
        {
          name: `${serverName}_authenticate`,
          description: `Start OAuth authentication with ${config.clientName ?? serverName}. Returns a URL the user must open in their browser. After completing the browser login the proxy automatically wires up the upstream tools and pushes a tools/list_changed notification.`,
        },
        async (_params: any, ctx: any) => {
          const userId: string = ctx.auth.user.userId;
          const inboundSessionId: string = ctx.session.sessionId;

          if (this.store.hasSession(userId, serverName)) {
            return {
              content: [
                { type: "text" as const, text: `Already authenticated with ${serverName}.` },
              ],
            };
          }

          const provider = new ServerSideOAuthProvider({
            callbackUrl,
            clientName: config.clientName ?? serverName,
          });

          const result = await auth(provider, { serverUrl: config.url });

          if (result === "AUTHORIZED") {
            await this.createUpstreamSession(userId, serverName, config.url, provider);
            this.notifyToolsListChanged(inboundSessionId);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Authenticated with ${serverName} (no redirect needed).`,
                },
              ],
            };
          }

          const authUrl = provider.authorizationUrl;
          if (!authUrl) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Failed to generate authorization URL for ${serverName}.`,
                },
              ],
              isError: true,
            };
          }

          const sdkState = authUrl.searchParams.get("state") ?? randomUUID();
          this.store.setPending(sdkState, { userId, serverName, provider, inboundSessionId });

          return {
            content: [
              {
                type: "text" as const,
                text: `Please open this URL to authenticate with ${serverName}:\n\n${authUrl.toString()}`,
              },
            ],
          };
        }
      );
    }
  }

  // --- Per-caller filter for tools/list ---

  private setupToolFilter(): void {
    (this.server as any).use("mcp:*", async (ctx: any, next: any) => {
      const result = await next();
      if (ctx.method !== "tools/list" || !Array.isArray(result)) {
        return result;
      }
      const userId: string | undefined = ctx.auth?.user?.userId;
      if (!userId) {
        return result;
      }
      return result.filter((tool: any) => {
        const name: string = tool.name;
        if (name.endsWith("_authenticate")) {
          return true;
        }
        const owningServer = Object.keys(this.servers).find((s) =>
          name.startsWith(`${s}_`)
        );
        if (!owningServer) {
          return true;
        }
        return this.store.hasSession(userId, owningServer);
      });
    });
  }

  // --- Nudge inbound session to refresh its tool list ---

  private notifyToolsListChanged(sessionId: string): void {
    const sessions: Map<string, any> | undefined = (this.server as any).sessions;
    const session = sessions?.get(sessionId);
    if (!session?.server?.sendToolListChanged) {
      return;
    }
    try {
      session.server.sendToolListChanged();
    } catch (err: any) {
      console.warn(
        `[notify] tools/list_changed for session ${sessionId} failed: ${err?.message ?? err}`
      );
    }
  }

  // --- Create upstream session and register forwarding tools ---

  private async createUpstreamSession(
    userId: string,
    serverName: string,
    url: string,
    provider: ServerSideOAuthProvider
  ): Promise<void> {
    const client = new MCPClient({
      mcpServers: {
        [serverName]: { url, authProvider: provider },
      },
    });

    const session = await client.createSession(serverName);
    this.store.setSession(userId, serverName, { client, session });

    const upstreamTools = await session.listTools();

    for (const tool of upstreamTools) {
      const proxyToolName = `${serverName}_${tool.name}`;

      if (this.registeredTools.has(proxyToolName)) {
        continue;
      }

      this.registeredTools.add(proxyToolName);

      const toolDef: any = {
        name: proxyToolName,
        description: tool.description ?? `[${serverName}] ${tool.name}`,
      };

      if (tool.inputSchema) {
        toolDef.schema = jsonSchemaToZod(tool.inputSchema);
      }

      this.server.tool(toolDef, async (params: any, ctx: any) => {
        const callerUserId: string = ctx.auth.user.userId;
        const userSession = this.store.getSession(callerUserId, serverName);

        if (!userSession) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Not authenticated with ${serverName}. Please call ${serverName}_authenticate first.`,
              },
            ],
            isError: true,
          };
        }

        try {
          const result = await userSession.session.callTool(tool.name, params);
          return result;
        } catch (err: any) {
          return {
            content: [
              { type: "text" as const, text: `Error calling ${tool.name}: ${err.message}` },
            ],
            isError: true,
          };
        }
      });
    }

    console.log(
      `[${serverName}] Registered ${upstreamTools.length} tools for user ${userId}`
    );
  }
}
