import { NextResponse } from "next/server";
import { backendUrl } from "@/lib/backend";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const response = await fetch(backendUrl + "/api/clip/" + encodeURIComponent(id) + "", { method: "GET", cache: "no-store" });
    return NextResponse.json(await response.json(), { status: response.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Local backend is unavailable" }, { status: 502 });
  }
}
