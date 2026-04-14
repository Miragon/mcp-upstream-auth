import type { MCPClient } from "mcp-use/client";
import type { ServerSideOAuthProvider } from "./oauth-provider.js";

export interface PendingAuth {
  userId: string;
  serverName: string;
  provider: ServerSideOAuthProvider;
  /**
   * Inbound MCP transport session that initiated the auth flow. Used by the
   * OAuth callback to push a tools/list_changed notification back to the
   * client that started the login.
   */
  inboundSessionId: string;
}

export interface UserUpstreamSession {
  client: MCPClient;
  session: any; // MCPSession
}

/**
 * Manages per-user upstream MCP sessions and pending OAuth flows.
 *
 * Keys are (userId, serverName) pairs. userId is the verified identity
 * from the inbound OAuth token (ctx.auth.user.userId), so sessions
 * survive transport reconnects of the same user.
 */
export class SessionStore {
  private sessions = new Map<string, Map<string, UserUpstreamSession>>();
  private pending = new Map<string, PendingAuth>();

  // --- Pending auth ---

  setPending(oauthState: string, auth: PendingAuth): void {
    this.pending.set(oauthState, auth);
  }

  getPending(oauthState: string): PendingAuth | undefined {
    return this.pending.get(oauthState);
  }

  deletePending(oauthState: string): void {
    this.pending.delete(oauthState);
  }

  // --- Upstream sessions ---

  getSession(userId: string, serverName: string): UserUpstreamSession | undefined {
    return this.sessions.get(userId)?.get(serverName);
  }

  setSession(userId: string, serverName: string, session: UserUpstreamSession): void {
    if (!this.sessions.has(userId)) {
      this.sessions.set(userId, new Map());
    }
    this.sessions.get(userId)!.set(serverName, session);
  }

  hasSession(userId: string, serverName: string): boolean {
    return this.sessions.get(userId)?.has(serverName) ?? false;
  }
}
