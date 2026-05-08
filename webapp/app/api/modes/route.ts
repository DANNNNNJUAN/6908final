import { NextRequest } from "next/server";
import { proxyGet, proxyPost } from "../_proxy";

export async function GET(req: NextRequest) {
  // Preserve frontend query params such as ?mac=... and forward them upstream.
  const search = req.nextUrl.search || "";
  return proxyGet(`/api/modes${search}`, req);
}

export async function POST(req: NextRequest) {
  return proxyPost("/api/modes/custom", req);
}
