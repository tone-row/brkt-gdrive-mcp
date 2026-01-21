import { NextRequest, NextResponse } from "next/server";
import { getOAuthClientByClientId } from "@/lib/oauth-clients";

/**
 * Get OAuth client info by client_id
 * Used by the authorization consent screen
 */
export async function GET(request: NextRequest) {
  const clientId = request.nextUrl.searchParams.get("client_id");

  if (!clientId) {
    return NextResponse.json({ error: "client_id is required" }, { status: 400 });
  }

  const client = await getOAuthClientByClientId(clientId);

  if (!client) {
    return NextResponse.json({ error: "Invalid client_id" }, { status: 404 });
  }

  // Only return public info
  return NextResponse.json({
    name: client.name,
    clientIdPrefix: client.clientIdPrefix,
  });
}
