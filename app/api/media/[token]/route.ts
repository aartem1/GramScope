import { handleOriginalRequest } from "@/media/original-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  return handleOriginalRequest(request, (await context.params).token);
}
