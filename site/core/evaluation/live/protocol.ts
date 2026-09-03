import { timingSafeEqual } from "node:crypto";

export const LIVE_EVALUATION_RUNNER_FLAG = "HARNESS_EVAL_LIVE";
export const LIVE_EVALUATION_SERVER_FLAG = "HARNESS_EVAL_SERVER";
export const LIVE_EVALUATION_NONCE_ENV = "HARNESS_EVAL_SESSION_NONCE";
export const LIVE_EVALUATION_SESSION_HEADER = "x-harness-eval-session";
export const LIVE_EVALUATION_NONCE_HEADER = "x-harness-eval-nonce";
export const LIVE_EVALUATION_CASE_HEADER = "x-harness-eval-case";
export const LIVE_EVALUATION_RUN_HEADER = "x-harness-eval-run";
export const LIVE_EVALUATION_SESSION_VALUE = "harness-live-smoke-v1";

export function isLoopbackHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    return url.protocol === "http:"
      && url.username === ""
      && url.password === ""
      && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(host);
  } catch {
    return false;
  }
}

export function safeNonceMatches(expected: string | undefined, actual: string | null): boolean {
  if (
    !expected
    || !actual
    || !/^[a-f0-9]{64}$/.test(expected)
    || !/^[a-f0-9]{64}$/.test(actual)
    || actual.length !== expected.length
  ) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}
