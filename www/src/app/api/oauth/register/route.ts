import { NextRequest, NextResponse } from "next/server";
import { registerClient } from "@/lib/oauth-dynamic";

/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591)
 * Used by MCP clients to register as public OAuth clients
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method } = body;

    // Validate client_name
    if (!client_name || typeof client_name !== "string") {
      return NextResponse.json(
        { error: "invalid_client_metadata", error_description: "client_name is required" },
        { status: 400 }
      );
    }

    // Validate redirect_uris
    if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      return NextResponse.json(
        { error: "invalid_client_metadata", error_description: "redirect_uris must be a non-empty array" },
        { status: 400 }
      );
    }

    for (const uri of redirect_uris) {
      try {
        new URL(uri);
      } catch {
        return NextResponse.json(
          { error: "invalid_client_metadata", error_description: `Invalid redirect_uri: ${uri}` },
          { status: 400 }
        );
      }
    }

    const client = await registerClient({
      clientName: client_name,
      redirectUris: redirect_uris,
      grantTypes: grant_types,
      responseTypes: response_types,
      tokenEndpointAuthMethod: token_endpoint_auth_method,
    });

    return NextResponse.json(
      {
        client_id: client.clientId,
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        grant_types: client.grantTypes,
        response_types: client.responseTypes,
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Client registration error:", error);
    return NextResponse.json(
      { error: "server_error", error_description: "Internal server error" },
      { status: 500 }
    );
  }
}
