import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helper";
import { getOAuthClientByClientId, createAuthorizationCode } from "@/lib/oauth-clients";

/**
 * Create an authorization code
 * Called after user consents on the authorize page
 */
export async function POST(request: NextRequest) {
  try {
    // Require user to be logged in
    const user = await getCurrentUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const {
      client_id,
      redirect_uri,
      scope,
      code_challenge,
      code_challenge_method,
    } = body as {
      client_id: string;
      redirect_uri: string;
      scope?: string;
      code_challenge?: string;
      code_challenge_method?: string;
    };

    // Validate client_id
    const client = await getOAuthClientByClientId(client_id);
    if (!client) {
      return NextResponse.json({ error: "invalid_client" }, { status: 400 });
    }

    // Validate that the user owns this client
    if (client.userId !== user.id) {
      // For MCP OAuth, the user authorizing should be the owner of the client credentials
      // This is because the client credentials are tied to the user's account
      return NextResponse.json(
        { error: "Client does not belong to the authenticated user" },
        { status: 403 }
      );
    }

    // Create authorization code
    const code = await createAuthorizationCode(
      client_id,
      user.id,
      redirect_uri,
      scope || "mcp:tools",
      code_challenge,
      code_challenge_method
    );

    return NextResponse.json({ code });
  } catch (error) {
    console.error("Authorization error:", error);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
