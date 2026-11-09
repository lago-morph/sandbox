import { describe, expect, it } from "vitest";
import { handleApi } from "../src/index";
import { signToken } from "../src/auth";
import type { Env } from "../src/types";
import { FakeD1 } from "./fakeD1";

const ORIGIN = "https://kubecon-planner.cloud-app-asdf.workers.dev";

async function setup() {
  const db = new FakeD1();
  db.sessions.set("s1", { id: "s1" });
  db.sessions.set("s2", { id: "s2" });
  const env = { SESSION_SECRET: "test-secret-0123456789abcdef0123", DB: db as unknown as D1Database } as Env;
  const cookie = `kp_session=${await signToken({ uid: "u1", email: "", exp: Math.floor(Date.now() / 1000) + 60 }, env.SESSION_SECRET)}`;
  const call = (method: string, path: string, body?: unknown) => {
    const url = new URL(`${ORIGIN}${path}`);
    return handleApi(
      new Request(url, { method, headers: { cookie, origin: ORIGIN }, body: body === undefined ? undefined : JSON.stringify(body) }),
      env,
      url,
    );
  };
  return { db, call };
}

describe("selections", () => {
  it("stores favorite by default and interested on request, one state per session", async () => {
    const { call } = await setup();
    expect((await call("PUT", "/api/selections/s1")).status).toBe(204);
    expect((await call("PUT", "/api/selections/s2", { status: "interested" })).status).toBe(204);
    expect(await (await call("GET", "/api/selections")).json()).toEqual([
      { id: "s1", status: "favorite" },
      { id: "s2", status: "interested" },
    ]);
    // Switching state replaces it; it never holds two states.
    expect((await call("PUT", "/api/selections/s1", { status: "interested" })).status).toBe(204);
    expect((await call("PUT", "/api/selections/s2", { status: "favorite" })).status).toBe(204);
    expect(await (await call("GET", "/api/selections")).json()).toEqual([
      { id: "s1", status: "interested" },
      { id: "s2", status: "favorite" },
    ]);
  });

  it("clears with DELETE, rejects bad status and unknown sessions", async () => {
    const { call } = await setup();
    await call("PUT", "/api/selections/s1", { status: "interested" });
    expect((await call("DELETE", "/api/selections/s1")).status).toBe(204);
    expect(await (await call("GET", "/api/selections")).json()).toEqual([]);
    expect((await call("PUT", "/api/selections/s1", { status: "maybe" })).status).toBe(400);
    expect((await call("PUT", "/api/selections/nope", { status: "favorite" })).status).toBe(404);
  });
});
