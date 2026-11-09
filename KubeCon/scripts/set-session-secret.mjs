// Generate SESSION_SECRET (32 random bytes, base64) and pipe it into `wrangler secret put` (R-6.1 step 5).
// With --import, also trigger the first schedule import once via a short-lived (2 min) signed
// cookie built in memory from the same secret (R-7.5 item 4). Nothing secret is printed.
import { randomBytes, createHmac } from "node:crypto";
import { wrangler } from "./wr.mjs";

const APP = process.env.APP_NAME || "kubecon-planner";
const ORIGIN = `https://${APP}.cloud-app-asdf.workers.dev`;
const secret = randomBytes(32).toString("base64");

await wrangler(["secret", "put", "SESSION_SECRET", "--name", APP], { stdin: secret, quiet: true });
console.log("Stored SESSION_SECRET as a Worker secret");

if (process.argv.includes("--import")) {
  const b64u = (b) => Buffer.from(b).toString("base64url");
  const payload = b64u(JSON.stringify({ uid: "setup-import", email: "", exp: Math.floor(Date.now() / 1000) + 120 }));
  const cookie = `kp_session=${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${ORIGIN}/api/import`, { method: "POST", headers: { cookie, origin: ORIGIN } });
    const body = await res.text();
    if (res.status !== 401) {
      console.log(`Initial import: HTTP ${res.status} ${body}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 5000)); // wait for the new secret to propagate
  }
}
