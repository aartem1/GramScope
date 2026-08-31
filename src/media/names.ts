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
  const extension = MIME_EXTENSIONS[input.mimeType ?? ""] ?? ".bin";
  if (basename && basename !== "." && basename !== "..") {
    const existingExtension = path.posix.extname(basename);
    const stem = existingExtension && existingExtension !== "."
      ? basename.slice(0, -existingExtension.length)
      : basename;
    if (stem && stem !== "." && stem !== "..") {
      return `${stem.slice(-(180 - extension.length))}${extension}`;
    }
  }
  return `${input.kind}-${input.messageId}${extension}`;
}
