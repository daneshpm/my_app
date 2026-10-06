/**
 * Protocols ffmpeg/ffprobe may use when reading a LOCAL media input.
 *
 * Remote media is always downloaded to a local file before it reaches ffmpeg
 * (see urlDownloader), so network protocols (http, https, tcp, udp, rtmp, ...)
 * are never needed. Restricting them stops a crafted container/playlist (HLS,
 * ffconcat, SDP, ...) from making ffmpeg open `http://169.254.169.254/...` or
 * read arbitrary URLs itself. `crypto` is kept for local AES-encrypted
 * segments, `pipe` for stdin/stdout plumbing, `data` for inline URIs.
 */
export const LOCAL_INPUT_PROTOCOL_WHITELIST = "file,pipe,crypto,data";

/** Input option pair; must precede the `-i` it applies to. */
export const LOCAL_INPUT_PROTOCOL_ARGS: readonly string[] = [
  "-protocol_whitelist",
  LOCAL_INPUT_PROTOCOL_WHITELIST,
];
