import path from "node:path";

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "application/pdf": ".pdf",
};

export function safeMediaFilename(input: {
  supplied?: string;
  kind: string;
  messageId: number;
  mimeType?: string;
}): string {
  const basename = input.supplied
    ? path.posix.basename(
      input.supplied.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\\/g, "/"),
    )
    : "";
  if (basename && basename !== "." && basename !== "..") return basename.slice(-180);
  const extension = MIME_EXTENSIONS[input.mimeType ?? ""] ?? ".bin";
  return `${input.kind}-${input.messageId}${extension}`;
}
