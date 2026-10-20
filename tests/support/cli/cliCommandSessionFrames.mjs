/** Largest accepted session message, including the encoded command result. */
export const MAX_CLI_SESSION_FRAME_BYTES = 64 * 1024 * 1024;

/** Length-prefixed JSON frame shared by the session parent and worker. */
export const encodeCliSessionFrame = (value) => {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_CLI_SESSION_FRAME_BYTES) {
    throw new Error(
      `CLI session frame is ${body.length} bytes; the limit is ${MAX_CLI_SESSION_FRAME_BYTES}`,
    );
  }
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
};

/**
 * Parse complete frames from a byte stream. An oversized or malformed frame
 * fails the reader instead of resynchronizing on a later length.
 */
export const createCliSessionFrameReader = (onFrame) => {
  /** @type {Buffer[]} */
  const chunks = [];
  let buffered = 0;
  return (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(bytes);
    buffered += bytes.length;
    while (buffered >= 4) {
      const pending = Buffer.concat(chunks);
      const length = pending.readUInt32BE(0);
      if (length > MAX_CLI_SESSION_FRAME_BYTES) {
        throw new Error(
          `CLI session frame is ${length} bytes; the limit is ${MAX_CLI_SESSION_FRAME_BYTES}`,
        );
      }
      if (pending.length < 4 + length) {
        chunks.length = 0;
        chunks.push(pending);
        buffered = pending.length;
        return;
      }
      const body = pending.subarray(4, 4 + length);
      const rest = pending.subarray(4 + length);
      chunks.length = 0;
      buffered = rest.length;
      if (rest.length > 0) chunks.push(rest);
      onFrame(JSON.parse(body.toString("utf8")));
    }
  };
};
