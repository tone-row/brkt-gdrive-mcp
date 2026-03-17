import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728)
 * Tells MCP clients which authorization server to use
 *
 * Served at /.well-known/oauth-protected-resource/{path} via next.config.ts rewrite
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  const h = await headers();
  const host = h.get("host") || "localhost";
  const proto = h.get("x-forwarded-proto") || "https";
  const origin = `${proto}://${host}`;

  const resourcePath = "/" + path.join("/");

  return NextResponse.json(
    {
      resource: `${origin}${resourcePath}`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
    },
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
      },
    }
  );
}
