/** Thrown when a request body exceeds the configured byte limit. */
export class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

export async function readNodeRequestBody(
  req: AsyncIterable<string | Uint8Array>,
  maxBytes: number = Number.POSITIVE_INFINITY,
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) {
      // Stop buffering: destroy the source so the client stops sending.
      if ("destroy" in req && typeof req.destroy === "function") req.destroy();
      throw new RequestBodyTooLargeError(maxBytes);
    }
    chunks.push(buf);
  }

  return Buffer.concat(chunks);
}
