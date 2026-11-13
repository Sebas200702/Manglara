import { describe, expect, test } from "bun:test";
import { createOnlineStatusSource } from "./online-status";

/** Minimal EventTarget-backed stand-in for `window` + `navigator`. */
function fakeEnv(initialOnline: boolean) {
  const target = new EventTarget();
  const nav = { onLine: initialOnline };
  return {
    target,
    nav,
    go(online: boolean) {
      nav.onLine = online;
      target.dispatchEvent(new Event(online ? "online" : "offline"));
    },
  };
}

describe("createOnlineStatusSource", () => {
  test("snapshot reflects navigator.onLine", () => {
    const env = fakeEnv(false);
    const source = createOnlineStatusSource(env.target, env.nav);
    expect(source.getSnapshot()).toBe(false);
    env.nav.onLine = true;
    expect(source.getSnapshot()).toBe(true);
  });

  test("notifies subscribers on online/offline events", () => {
    const env = fakeEnv(true);
    const source = createOnlineStatusSource(env.target, env.nav);
    const seen: boolean[] = [];
    source.subscribe(() => seen.push(source.getSnapshot()));
    env.go(false);
    env.go(true);
    expect(seen).toEqual([false, true]);
  });

  test("unsubscribe stops notifications", () => {
    const env = fakeEnv(true);
    const source = createOnlineStatusSource(env.target, env.nav);
    let calls = 0;
    const unsubscribe = source.subscribe(() => calls++);
    unsubscribe();
    env.go(false);
    expect(calls).toBe(0);
  });

  test("server snapshot assumes online", () => {
    const env = fakeEnv(false);
    const source = createOnlineStatusSource(env.target, env.nav);
    expect(source.getServerSnapshot()).toBe(true);
  });

  test("missing navigator defaults to online", () => {
    const source = createOnlineStatusSource(new EventTarget(), undefined);
    expect(source.getSnapshot()).toBe(true);
  });
});
