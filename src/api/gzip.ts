import { pipeline, Transform, type Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { ApiError } from "../lib/errors.js";

/**
 * Decompresses a gzip request body while enforcing a limit on the DECOMPRESSED
 * size, so a small "zip bomb" cannot expand into gigabytes of memory.
 *
 * Fastify compares `receivedEncodedLength` with Content-Length, so we count the
 * compressed bytes as they arrive.
 */
export function gunzipWithLimit(source: Readable, maxBytes: number): Readable {
  let decoded = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      decoded += chunk.length;
      if (decoded > maxBytes) {
        callback(new ApiError(413, "PAYLOAD_TOO_LARGE", `decompressed body exceeds ${maxBytes} bytes`));
      } else {
        callback(null, chunk);
      }
    },
  });
  const out = Object.assign(limiter, { receivedEncodedLength: 0 });
  source.on("data", (chunk: Buffer) => {
    out.receivedEncodedLength += chunk.length;
  });
  pipeline(source, createGunzip(), limiter, (err) => {
    if (err && !limiter.destroyed) limiter.destroy(err);
  });
  return out;
}

/** Throws 415 for encodings other than gzip/identity. Returns true if the body is gzip. */
export function isGzip(contentEncoding: string | undefined): boolean {
  const enc = (contentEncoding ?? "identity").trim().toLowerCase();
  if (enc === "" || enc === "identity") return false;
  if (enc === "gzip") return true;
  throw new ApiError(415, "UNSUPPORTED_CONTENT_ENCODING", "Content-Encoding must be gzip or identity");
}