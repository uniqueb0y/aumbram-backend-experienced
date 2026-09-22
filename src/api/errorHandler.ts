import type { FastifyError, FastifyInstance } from "fastify";
import { pgErrorCode } from "../db/tx.js";
import { ApiError, errorBody } from "../lib/errors.js";

/** Connection-level database failures: the request should be retried later (503), not reported as a bug (500). */
export function isDbUnavailable(err: unknown): boolean {
  const code = pgErrorCode(err);
  if (code !== undefined && (code.startsWith("08") || code === "57P01" || code === "57P03" || code === "53300")) return true;
  const message = err instanceof Error ? err.message : "";
  return /timeout exceeded when trying to connect|Connection terminated|ECONNREFUSED|ECONNRESET/i.test(message);
}

function fastifyCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

export function installErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send(errorBody("NOT_FOUND", `no route for ${request.method} ${request.url.split("?")[0]}`));
  });

  app.setErrorHandler((err: FastifyError | ApiError | Error, request, reply) => {
    if (err instanceof ApiError) {
      if (err.headers) void reply.headers(err.headers);
      if (err.statusCode >= 500) request.log.warn({ code: err.code }, err.message);
      return reply.code(err.statusCode).send(errorBody(err.code, err.message, err.details));
    }
    const code = fastifyCode(err);
    if (code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.code(413).send(errorBody("PAYLOAD_TOO_LARGE", "request body is too large"));
    }
    if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return reply.code(415).send(errorBody("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json"));
    }
    if (code === "Z_DATA_ERROR" || code === "Z_BUF_ERROR") {
      return reply.code(400).send(errorBody("INVALID_GZIP", "body is not valid gzip"));
    }
    if (code === "FST_ERR_CTP_INVALID_JSON_BODY" || code === "FST_ERR_CTP_EMPTY_JSON_BODY" || code === "FST_ERR_CTP_INVALID_CONTENT_LENGTH" || err instanceof SyntaxError) {
      return reply.code(400).send(errorBody("INVALID_JSON", "body is not valid JSON"));
    }
    if ("statusCode" in err && typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send(errorBody("BAD_REQUEST", err.message));
    }
    if (isDbUnavailable(err)) {
      request.log.warn({ err: err.message }, "database unavailable");
      return reply.code(503).header("Retry-After", "2").send(errorBody("SERVICE_UNAVAILABLE", "storage is temporarily unavailable, retry later"));
    }
    request.log.error({ err }, "unhandled error");
    return reply.code(500).send(errorBody("INTERNAL", "internal error"));
  });
}