import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../lib/errors.js";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time comparison (hashing first makes both sides the same length). */
export function secretMatches(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  return timingSafeEqual(digest(provided), digest(expected));
}

type Hook = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface AuthHooks {
  /** Mobile clients: X-App-Key only. */
  app: Hook;
  /** Internal services: X-Internal-Token only. The app key never opens these. */
  internal: Hook;
  /** Read endpoints: either credential (DECISIONS D-031). */
  any: Hook;
}

export function authHooks(appKey: string, internalToken: string): AuthHooks {
  const hasApp = (r: FastifyRequest) => secretMatches(r.headers["x-app-key"], appKey);
  const hasInternal = (r: FastifyRequest) => secretMatches(r.headers["x-internal-token"], internalToken);
  const unauthorized = (msg: string) => new ApiError(401, "UNAUTHORIZED", msg);
  return {
    app: async (r) => {
      if (!hasApp(r)) throw unauthorized("a valid X-App-Key header is required");
    },
    internal: async (r) => {
      if (!hasInternal(r)) throw unauthorized("a valid X-Internal-Token header is required");
    },
    any: async (r) => {
      if (!hasApp(r) && !hasInternal(r)) throw unauthorized("a valid X-App-Key or X-Internal-Token header is required");
    },
  };
}