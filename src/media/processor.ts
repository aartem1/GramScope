import type { ProcessedImage } from "./image";

export type ContactSheetRequest = {
  timestampsSeconds: number[];
  maxBytes: number;
  maxLongEdge: number;
  deadline: AbortSignal;
};

export type ContactSheetResult = ProcessedImage & {
  mimeType: "image/jpeg";
  frameCount: number;
  timestampsSeconds: number[];
};

export interface MediaProcessor {
  probeDuration(inputPath: string, deadline: AbortSignal): Promise<number>;
  contactSheet(inputPath: string, request: ContactSheetRequest): Promise<ContactSheetResult>;
}
