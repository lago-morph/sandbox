// One-off (R-5.4): create the "kubecon-planner" OAuth client, pipe its secret into
// `wrangler secret put OAUTH_CLIENT_SECRET`, and write client_id into wrangler.jsonc.
// Never prints the secret, the token or the account ID. Run with NODE_USE_ENV_PROXY=1.
import { readFileSync, writeFileSync } from "node:fs";
import { wrangler, redact } from "./wr.mjs";

const APP = process.env.APP_NAME || "kubecon-planner";
const ORIGIN = `https://${APP}.cloud-app-asdf.workers.dev`;
const BASE = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/oauth_clients`;
const headers = { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" };

async function call(method, url, body) {
  const res = await fetch(url, { method, headers, body: body && JSON.stringify(body), redirect: "manual" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    throw new Error(`${method} oauth_clients failed: HTTP ${res.status} ${redact(JSON.stringify(json.errors ?? json))}`);
  }
  return json;
}

const list = await call("GET", BASE);
for (const c of list.result ?? []) {
  if (c.client_name === APP) {
    console.log(`Deleting existing client ${c.client_id} (its secret is not recoverable)`);
    await call("DELETE", `${BASE}/${c.client_id}`);
  }
}

const created = await call("POST", BASE, {
  client_name: APP,
  redirect_uris: [`${ORIGIN}/auth/callback`],
  response_types: ["code"],
  grant_types: ["authorization_code"],
  token_endpoint_auth_method: "client_secret_post",
  scopes: ["user-details.read", "memberships.read"],
});
const { client_id, client_secret } = created.result ?? {};
if (!client_id || !client_secret) throw new Error("Response did not include client_id and client_secret");
console.log(`Created OAuth client ${client_id}`);

await wrangler(["secret", "put", "OAUTH_CLIENT_SECRET", "--name", APP], { stdin: client_secret, quiet: true });
console.log("Stored OAUTH_CLIENT_SECRET as a Worker secret");

const cfg = readFileSync("wrangler.jsonc", "utf8");
const next = cfg.replace(/"OAUTH_CLIENT_ID":\s*"[^"]*"/, `"OAUTH_CLIENT_ID": "${client_id}"`);
if (next === cfg && !cfg.includes(client_id)) throw new Error("Could not update OAUTH_CLIENT_ID in wrangler.jsonc");
writeFileSync("wrangler.jsonc", next);
console.log("Wrote OAUTH_CLIENT_ID to wrangler.jsonc");
