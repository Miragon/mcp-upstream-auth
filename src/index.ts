import { oauthWorkOSProvider } from "mcp-use/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { UpstreamAuthProxy } from "./upstream-auth-proxy.js";
import type { ServerEntry } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const servers: Record<string, ServerEntry> = JSON.parse(
  readFileSync(path.resolve(__dirname, "servers.json"), "utf-8")
);

const proxy = new UpstreamAuthProxy({
  baseUrl: process.env.BASE_URL ?? "http://localhost:3000",
  oauth: oauthWorkOSProvider({ subdomain: process.env.WORKOS_SUBDOMAIN! }),
  servers,
});

await proxy.listen(parseInt(process.env.PORT ?? "3000", 10));
