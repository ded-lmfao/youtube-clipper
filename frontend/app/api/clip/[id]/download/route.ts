import { NextResponse } from "next/server";
import { backendUrl } from "@/lib/backend";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const response = await fetch(backendUrl + "/api/clip/" + encodeURIComponent(id) + "/file", { cache: "no-store" });
    if (!response.ok) return NextResponse.json(await response.json(), { status: response.status });
    return new NextResponse(response.body, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": 'attachment; filename="clip.mp4"',
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Local download failed" }, { status: 502 });
  }
}
