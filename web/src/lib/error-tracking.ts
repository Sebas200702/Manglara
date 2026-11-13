/**
 * Error tracking via Rustrak (Sentry-compatible ingest). Off unless
 * `VITE_SENTRY_DSN` is set at build time. Never sends PII.
 */
import * as Sentry from "@sentry/react";

interface ErrorTrackingEnv {
  VITE_SENTRY_DSN?: string;
  VITE_SENTRY_ENVIRONMENT?: string;
  VITE_SENTRY_RELEASE?: string;
}

export interface ErrorTrackingOptions {
  dsn: string;
  environment: string;
  release?: string;
  sendDefaultPii: false;
  tracesSampleRate: 0;
}

export function buildErrorTrackingOptions(env: ErrorTrackingEnv): ErrorTrackingOptions | null {
  const dsn = env.VITE_SENTRY_DSN?.trim();
  if (!dsn) return null;
  return {
    dsn,
    environment: env.VITE_SENTRY_ENVIRONMENT || "production",
    release: env.VITE_SENTRY_RELEASE || undefined,
    sendDefaultPii: false,
    tracesSampleRate: 0,
  };
}

export function initErrorTracking(env: ErrorTrackingEnv = import.meta.env): boolean {
  const options = buildErrorTrackingOptions(env);
  if (!options) return false;
  Sentry.init(options);
  return true;
}

/** React 19 root error hooks; no-ops when tracking is off. */
export const rootErrorHandlers = {
  onUncaughtError: Sentry.reactErrorHandler(),
  onCaughtError: Sentry.reactErrorHandler(),
  onRecoverableError: Sentry.reactErrorHandler(),
};
