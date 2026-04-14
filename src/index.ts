import { MCPServer, oauthWorkOSProvider } from "mcp-use/server";
import { MCPClient } from "mcp-use/client";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ServerSideOAuthProvider } from "./oauth-provider.js";
import { SessionStore } from "./session-store.js";
import { jsonSchemaToZod } from "./json-schema-to-zod.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Config ---

interface ServerEntry {
  url: string;
  clientName?: string;
}

const serversConfig: Record<string, ServerEntry> = JSON.parse(
  readFileSync(path.resolve(__dirname, "servers.json"), "utf-8")
);

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const PROXY_PORT = parseInt(process.env.PORT ?? "3000", 10);

// --- Inbound OAuth (proxy itself) ---
//
// Uses WorkOS AuthKit via mcp-use's built-in provider. Reads
// MCP_USE_OAUTH_WORKOS_SUBDOMAIN (required) and optionally
// MCP_USE_OAUTH_WORKOS_CLIENT_ID / MCP_USE_OAUTH_WORKOS_API_KEY from env.
// Without a CLIENT_ID, Dynamic Client Registration is used — MCP clients
// register themselves automatically against WorkOS. The provider verifies
// JWTs against the WorkOS JWKS and exposes userId = payload.sub on
// ctx.auth.user.userId, which is what we key the SessionStore on.

const inboundOAuthProvider = oauthWorkOSProvider({
  subdomain : process.env.WORKOS_SUBDOMAIN!
});

// --- State ---

const store = new SessionStore();
const registeredTools = new Set<string>();

// --- Server ---

const server = new MCPServer({
  name: "MCPProxy",
  version: "1.0.0",
  host: "0.0.0.0",
  oauth: inboundOAuthProvider,
  // Make the OAuth discovery + protected-resource URLs use the public
  // origin instead of the bind address. Critical behind a proxy/Fly:
  // without this the resource URL becomes http://0.0.0.0:3000.
});

// --- OAuth callback route (upstream IdP → proxy) ---
//
// Runs the full upstream-auth flow in one shot: token exchange,
// MCP-session setup, then a tools/list_changed nudge to the inbound
// session that started the login. No separate _complete_auth tool needed.

server.app.get("/oauth/callback/:serverName", async (c) => {
  const serverName = c.req.param("serverName");
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) {
    return c.text("Missing code or state parameter", 400);
  }

  const pending = store.getPending(state);
  if (!pending) {
    return c.text("Unknown or expired OAuth state", 400);
  }

  if (pending.serverName !== serverName) {
    return c.text("Server name mismatch", 400);
  }

  try {
    const result = await auth(pending.provider, {
      serverUrl: serversConfig[serverName].url,
      authorizationCode: code,
    });

    if (result !== "AUTHORIZED") {
      return c.text("Token exchange failed", 500);
    }

    await createUpstreamSession(
      pending.userId,
      serverName,
      serversConfig[serverName].url,
      pending.provider
    );

    notifyToolsListChanged(pending.inboundSessionId);
    store.deletePending(state);

    return c.html(
      "<html><body><h1>Authentication successful!</h1><p>You can close this window and continue in Claude.</p></body></html>"
    );
  } catch (err: any) {
    return c.text(`OAuth error: ${err.message}`, 500);
  }
});

// --- Register authenticate tool per upstream server ---

for (const [serverName, config] of Object.entries(serversConfig)) {
  const callbackUrl = `${BASE_URL}/oauth/callback/${serverName}`;

  server.tool(
    {
      name: `${serverName}_authenticate`,
      description: `Start OAuth authentication with ${config.clientName ?? serverName}. Returns a URL the user must open in their browser. After completing the browser login the proxy automatically wires up the upstream tools and pushes a tools/list_changed notification.`,
    },
    async (_params: any, ctx: any) => {
      const userId: string = ctx.auth.user.userId;
      const inboundSessionId: string = ctx.session.sessionId;

      if (store.hasSession(userId, serverName)) {
        return {
          content: [{ type: "text" as const, text: `Already authenticated with ${serverName}.` }],
        };
      }

      const provider = new ServerSideOAuthProvider({
        callbackUrl,
        clientName: config.clientName ?? serverName,
      });

      const result = await auth(provider, { serverUrl: config.url });

      if (result === "AUTHORIZED") {
        await createUpstreamSession(userId, serverName, config.url, provider);
        notifyToolsListChanged(inboundSessionId);
        return {
          content: [{ type: "text" as const, text: `Authenticated with ${serverName} (no redirect needed).` }],
        };
      }

      const authUrl = provider.authorizationUrl;
      if (!authUrl) {
        return {
          content: [{ type: "text" as const, text: `Failed to generate authorization URL for ${serverName}.` }],
          isError: true,
        };
      }

      const sdkState = authUrl.searchParams.get("state") ?? randomUUID();
      store.setPending(sdkState, { userId, serverName, provider, inboundSessionId });

      return {
        content: [{
          type: "text" as const,
          text: `Please open this URL to authenticate with ${serverName}:\n\n${authUrl.toString()}`,
        }],
      };
    }
  );
}

// --- Per-caller filter for tools/list ---
//
// Forward tools are registered globally on the server (first user to auth
// triggers the registration). Without a filter every connected user would
// see every upstream's tools regardless of their own auth state. This
// middleware drops forward tools for callers that don't have a session
// for the matching upstream. The {server}_authenticate tools stay visible.

(server as any).use("mcp:*", async (ctx: any, next: any) => {
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
    const owningServer = Object.keys(serversConfig).find((s) =>
      name.startsWith(`${s}_`)
    );
    if (!owningServer) {
      return true;
    }
    return store.hasSession(userId, owningServer);
  });
});

// --- Helper: nudge a single inbound session to refresh its tool list ---

function notifyToolsListChanged(sessionId: string): void {
  const sessions: Map<string, any> | undefined = (server as any).sessions;
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

// --- Helper: create upstream session and register forwarding tools ---

async function createUpstreamSession(
  userId: string,
  serverName: string,
  url: string,
  provider: ServerSideOAuthProvider,
) {
  const client = new MCPClient({
    mcpServers: {
      [serverName]: { url, authProvider: provider },
    },
  });

  const session = await client.createSession(serverName);
  store.setSession(userId, serverName, { client, session });

  const upstreamTools = await session.listTools();

  for (const tool of upstreamTools) {
    const proxyToolName = `${serverName}_${tool.name}`;

    if (registeredTools.has(proxyToolName)) {
      continue;
    }

    registeredTools.add(proxyToolName);

    const toolDef: any = {
      name: proxyToolName,
      description: tool.description ?? `[${serverName}] ${tool.name}`,
    };

    if (tool.inputSchema) {
      toolDef.schema = jsonSchemaToZod(tool.inputSchema);
    }

    server.tool(toolDef, async (params: any, ctx: any) => {
      const callerUserId: string = ctx.auth.user.userId;
      const userSession = store.getSession(callerUserId, serverName);

      if (!userSession) {
        return {
          content: [{
            type: "text" as const,
            text: `Not authenticated with ${serverName}. Please call ${serverName}_authenticate first.`,
          }],
          isError: true,
        };
      }

      try {
        const result = await userSession.session.callTool(tool.name, params);
        return result;
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error calling ${tool.name}: ${err.message}` }],
          isError: true,
        };
      }
    });
  }

  console.log(
    `[${serverName}] Registered ${upstreamTools.length} tools for user ${userId}`
  );
}

// --- Start ---

await server.listen(PROXY_PORT);

const names = Object.keys(serversConfig).join(", ");
console.log(`MCP Proxy running on ${BASE_URL}/mcp`);
console.log(`Inbound OAuth: WorkOS AuthKit (${process.env.MCP_USE_OAUTH_WORKOS_SUBDOMAIN})`);
console.log(`Upstream servers: ${names}`);
console.log(`Each server exposes a {server}_authenticate tool. Forward tools appear after the browser flow finishes.`);
