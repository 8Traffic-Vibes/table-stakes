import { subscribe } from "@/server/rooms";
import type { TableVM } from "@/lib/view-model";

export const dynamic = "force-dynamic";

/** SSE stream of personalized TableVM snapshots. EventSource-friendly. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const token = new URL(req.url).searchParams.get("token");

  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (vm: TableVM): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(vm)}\n\n`));
      };
      const close = (): void => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      cleanup = subscribe(id, token, send, close);
      if (!cleanup) {
        controller.enqueue(
          encoder.encode(`event: room_error\ndata: {"error":"room not found"}\n\n`),
        );
        controller.close();
        return;
      }
      keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        } catch {
          if (keepalive) clearInterval(keepalive);
        }
      }, 20_000);
    },
    cancel() {
      cleanup?.();
      if (keepalive) clearInterval(keepalive);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
