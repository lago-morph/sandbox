// Run `npx wrangler ...args` with NODE_USE_ENV_PROXY=1 and redact the account ID and token
// from everything wrangler prints (E-3, D-5). Optional stdin is piped through unchanged.
import { spawn } from "node:child_process";

const SECRETS = [process.env.CLOUDFLARE_ACCOUNT_ID, process.env.CLOUDFLARE_API_TOKEN].filter((s) => s && s.length > 4);

export function redact(text) {
  let out = text;
  for (const s of SECRETS) out = out.split(s).join("***");
  return out;
}

export function wrangler(args, { stdin, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["wrangler", ...args], {
      env: {
        ...process.env,
        NODE_USE_ENV_PROXY: "1",
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --disable-warning=UNDICI-EHPA`.trim(),
        WRANGLER_SEND_METRICS: "false",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    // Redact whole lines only, so a secret split across two output chunks is still caught.
    const onData = (stream, keep) => {
      let pending = "";
      const emit = (text) => {
        const t = redact(text);
        if (keep) out += t; // resolve with stdout only
        if (!quiet) stream.write(t);
      };
      return {
        data: (buf) => {
          pending += buf.toString();
          const cut = pending.lastIndexOf("\n");
          if (cut >= 0) {
            emit(pending.slice(0, cut + 1));
            pending = pending.slice(cut + 1);
          }
        },
        end: () => {
          if (pending) emit(pending);
          pending = "";
        },
      };
    };
    const so = onData(process.stdout, true);
    const se = onData(process.stderr, false);
    child.stdout.on("data", so.data);
    child.stderr.on("data", se.data);
    child.stdout.on("end", so.end);
    child.stderr.on("end", se.end);
    if (stdin != null) child.stdin.end(stdin);
    else child.stdin.end();
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`wrangler ${args[0]} exited with ${code}`))));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  wrangler(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
