import { randomUUID } from "node:crypto";
import type {
  OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export interface ServerSideOAuthProviderOptions {
  callbackUrl: string;
  clientName?: string;
}

/**
 * Server-side OAuth provider that does NOT open a browser.
 * Instead, it captures the authorization URL so it can be returned
 * to the user via an MCP tool response.
 */
export class ServerSideOAuthProvider implements OAuthClientProvider {
  private _tokens?: OAuthTokens;
  private _clientInformation?: OAuthClientInformationMixed;
  private _codeVerifier?: string;
  private _authorizationUrl?: URL;

  private readonly callbackUrl: string;
  private readonly clientName: string;

  constructor(options: ServerSideOAuthProviderOptions) {
    this.callbackUrl = options.callbackUrl;
    this.clientName = options.clientName ?? "MCP Proxy";
  }

  get redirectUrl(): string {
    return this.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.callbackUrl] as any,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: this.clientName,
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this._clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this._clientInformation = info;
  }

  tokens(): OAuthTokens | undefined {
    return this._tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this._tokens = tokens;
  }

  /** Returns the authorization URL captured during the OAuth flow. */
  get authorizationUrl(): URL | undefined {
    return this._authorizationUrl;
  }

  // The MCP SDK's auth() calls this once when building the authorize URL.
  // Without it, no `state` is appended and upstream servers (e.g. Notion)
  // don't return one in the callback, so we can't look up the pending flow.
  state(): string {
    return randomUUID();
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // Don't open browser — just store the URL for retrieval
    this._authorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this._codeVerifier) {
      throw new Error("No code verifier saved");
    }
    return this._codeVerifier;
  }
}
