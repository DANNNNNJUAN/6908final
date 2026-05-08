import { NextRequest } from "next/server";
import { proxyGet } from "../../_proxy";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ mac: string }> },
) {
  const { mac } = await params;
  // Next.js 13+ already decodes dynamic route params, so encode the MAC again.
  // MAC addresses such as 88:56:A6:7B:C7:0C need encoded colons.
  const encodedMac = encodeURIComponent(mac);
  return proxyGet(`/api/config/${encodedMac}`, req);
}
