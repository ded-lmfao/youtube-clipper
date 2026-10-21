import { backendUrl } from "@/lib/backend";
import { NextResponse } from "next/server";

export async function GET() {
  const backendApi = backendUrl;
  try {
    const res = await fetch(`${backendApi}/api/ping`, { cache: "no-store" });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error("[ping] backend request failed", err);
    return NextResponse.json({ success: false }, { status: 502 });
  }
} 