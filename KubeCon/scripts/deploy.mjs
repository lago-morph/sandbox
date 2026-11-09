// npm run deploy (R-6.2): back up selections to R2 first (deploy is refused if that fails),
// then wrangler deploy with ACCOUNT_ID passed via --var, never echoed.
import { backup } from "./backup.mjs";
import { wrangler } from "./wr.mjs";

const id = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!id) {
  console.error("CLOUDFLARE_ACCOUNT_ID is not set");
  process.exit(1);
}
try {
  await backup("pre-deploy");
} catch (e) {
  console.error(`Backup failed, not deploying: ${e.message}`);
  process.exit(1);
}
await wrangler(["deploy", "--var", `ACCOUNT_ID:${id}`]).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
