import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helper";
import { createOAuthClient, listOAuthClients } from "@/lib/oauth-clients";

/**
 * List all OAuth clients for the current user
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clients = await listOAuthClients(user.id);

  return NextResponse.json({ clients });
}

/**
 * Create a new OAuth client
 */
export async function POST(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { name } = body as { name: string };

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const { client, clientSecret } = await createOAuthClient(user.id, name.trim());

  // Return the full credentials (only shown once!)
  return NextResponse.json({
    id: client.id,
    name: client.name,
    clientId: client.clientId,
    clientSecret,
    clientIdPrefix: client.clientIdPrefix,
    createdAt: client.createdAt,
  });
}
