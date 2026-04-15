export interface ServerEntry {
  url: string;
  clientName?: string;
}

export interface UpstreamAuthProxyOptions {
  name?: string;
  version?: string;
  baseUrl: string;
  oauth: any;
  servers: Record<string, ServerEntry>;
}
