import { describe, expect, test } from "bun:test";
import { buildErrorTrackingOptions } from "./error-tracking";

describe("buildErrorTrackingOptions", () => {
  test("returns null without a DSN so tracking stays off", () => {
    expect(buildErrorTrackingOptions({})).toBeNull();
    expect(buildErrorTrackingOptions({ VITE_SENTRY_DSN: "  " })).toBeNull();
  });

  test("builds private options from the env", () => {
    const opts = buildErrorTrackingOptions({
      VITE_SENTRY_DSN: "https://abc@errors.example.invalid/4",
      VITE_SENTRY_ENVIRONMENT: "preview",
      VITE_SENTRY_RELEASE: "manglara-web@test",
    });
    expect(opts).toEqual({
      dsn: "https://abc@errors.example.invalid/4",
      environment: "preview",
      release: "manglara-web@test",
      sendDefaultPii: false,
      tracesSampleRate: 0,
    });
  });

  test("defaults environment to production and leaves release unset", () => {
    const opts = buildErrorTrackingOptions({ VITE_SENTRY_DSN: "https://abc@x.invalid/4" });
    expect(opts?.environment).toBe("production");
    expect(opts?.release).toBeUndefined();
  });
});
