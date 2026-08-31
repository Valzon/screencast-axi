import { describe, expect, it } from "vitest";
import { normaliseAuth, resolveConfig, selectStrategy } from "../src/config.js";
import { basicAuth, noAuth, profileAuth, storageStateAuth } from "../src/auth/strategies.js";
import { ScreencastError } from "../src/errors.js";

const config = (auth?: Parameters<typeof resolveConfig>[0]["auth"]) =>
  resolveConfig({ ...(auth ? { auth } : {}) }, null, "/tmp");

describe("normalising the config's auth", () => {
  it("wraps a single strategy under `default`", () => {
    expect(Object.keys(normaliseAuth(basicAuth({ username: "u", password: "p" })))).toEqual([
      "default",
    ]);
  });

  it("keeps a named map as it is", () => {
    const map = { demo: profileAuth(), admin: profileAuth() };
    expect(Object.keys(normaliseAuth(map))).toEqual(["demo", "admin"]);
  });

  it("defaults to signed out", () => {
    expect(Object.keys(normaliseAuth(undefined))).toEqual(["none"]);
  });
});

describe("choosing a strategy for a take", () => {
  it("uses the only configured strategy without being asked", () => {
    expect(selectStrategy(config(profileAuth()), undefined)?.name).toBe("profile");
  });

  it("returns nothing when the config has no auth", () => {
    expect(selectStrategy(config(), undefined)).toBeNull();
  });

  it("honours a scenario opting out", () => {
    // A landing page and a dashboard often live in one config, so this has to
    // be decidable per scenario.
    expect(selectStrategy(config(profileAuth()), false)).toBeNull();
  });

  it("lets --no-auth override a scenario that wanted auth", () => {
    expect(selectStrategy(config(profileAuth()), "default", false)).toBeNull();
  });

  it("picks a named strategy", () => {
    const named = { demo: profileAuth(), staging: basicAuth({ username: "u", password: "p" }) };
    expect(selectStrategy(config(named), undefined, "staging")?.name).toBe("basicAuth");
  });

  it("lists what exists when asked for a strategy that does not", () => {
    try {
      selectStrategy(config({ demo: profileAuth() }), undefined, "nope");
      throw new Error("expected a throw");
    } catch (error) {
      const e = error as ScreencastError;
      expect(e.code).toBe("UNKNOWN_AUTH");
      expect(e.suggestions.join(" ")).toContain("demo");
    }
  });
});

describe("built-in strategies", () => {
  it("basic auth patches the context and never prints the password", () => {
    const strategy = basicAuth({ username: "user", password: "hunter2" });
    const ctx = { baseUrl: "https://x.test", rootDir: "/tmp", log: () => {} };
    expect(strategy.prepareContext?.(ctx)).toEqual({
      httpCredentials: { username: "user", password: "hunter2" },
    });
    expect(JSON.stringify(strategy.describe?.())).not.toContain("hunter2");
  });

  it("a storage state that is not there fails before the browser opens", async () => {
    const strategy = storageStateAuth({ path: "does-not-exist.json" });
    await expect(
      strategy.preflight?.({ baseUrl: "https://x.test", rootDir: "/tmp", log: () => {} }),
    ).rejects.toThrowError(/No saved session/);
  });

  it("only the profile strategy offers an interactive sign-in", () => {
    // `auth login` reports NOT_SUPPORTED for the others rather than pretending.
    expect(profileAuth().interactiveLogin).toBeTypeOf("function");
    expect(basicAuth({ username: "u", password: "p" }).interactiveLogin).toBeUndefined();
    expect(storageStateAuth({ path: "x.json" }).interactiveLogin).toBeUndefined();
  });

  it("treats an explicit `none` as signed out", () => {
    expect(selectStrategy(config(noAuth()), undefined)).toBeNull();
  });
});
