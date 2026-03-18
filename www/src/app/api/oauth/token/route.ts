import { NextRequest, NextResponse } from "next/server";
import {
  validateClientCredentials,
  exchangeAuthorizationCode,
  createTokens,
  refreshTokens,
} from "@/lib/oauth-clients";
import { getRegisteredClient } from "@/lib/oauth-dynamic";

/**
 * OAuth 2.0 Token Endpoint
 * Supports: authorization_code and refresh_token grant types
 * Supports both confidential clients (with secret) and public clients (no secret, PKCE required)
 */
export async function POST(request: NextRequest) {
  try {
    // Parse the request body (could be form-encoded or JSON)
    const contentType = request.headers.get("content-type") || "";
    let params: Record<string, string>;

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await request.formData();
      params = Object.fromEntries(formData.entries()) as Record<string, string>;
    } else {
      params = await request.json();
    }

    const {
      grant_type,
      code,
      redirect_uri,
      client_id,
      client_secret,
      code_verifier,
      refresh_token,
    } = params;

    // Get client credentials from Authorization header if not in body
    let finalClientId = client_id;
    let finalClientSecret = client_secret;

    const authHeader = request.headers.get("Authorization");
    if (authHeader?.startsWith("Basic ")) {
      const base64Credentials = authHeader.slice(6);
      const credentials = Buffer.from(base64Credentials, "base64").toString("utf-8");
      const [headerClientId, headerClientSecret] = credentials.split(":");
      if (!finalClientId) finalClientId = headerClientId;
      if (!finalClientSecret) finalClientSecret = headerClientSecret;
    }

    console.log("Token endpoint: grant_type=", grant_type, "client_id=", finalClientId, "has_secret=", !!finalClientSecret, "has_code=", !!code, "content-type=", contentType);

    if (!finalClientId) {
      console.log("Token endpoint: no client_id found in body or auth header");
      return NextResponse.json(
        { error: "invalid_client", error_description: "client_id is required" },
        { status: 401 }
      );
    }

    // Try public client path: client_id present but no client_secret
    let isPublicClient = false;
    if (!finalClientSecret) {
      const registeredClient = await getRegisteredClient(finalClientId);
      // Treat as public client if registered and has no secret stored
      // (regardless of token_endpoint_auth_method — clients like Claude
      // may register with "client_secret_post" but act as public clients)
      if (registeredClient && !registeredClient.clientSecretHash) {
        isPublicClient = true;
      } else if (registeredClient && registeredClient.clientSecretHash) {
        return NextResponse.json(
          { error: "invalid_client", error_description: "Client secret required" },
          { status: 401 }
        );
      } else {
        return NextResponse.json(
          { error: "invalid_client", error_description: "Unknown client" },
          { status: 401 }
        );
      }
    }

    // For confidential clients, validate credentials
    if (!isPublicClient) {
      const client = await validateClientCredentials(finalClientId, finalClientSecret!);
      if (!client) {
        return NextResponse.json(
          { error: "invalid_client", error_description: "Invalid client credentials" },
          { status: 401 }
        );
      }
    }

    // Handle grant types
    if (grant_type === "authorization_code") {
      if (!code || !redirect_uri) {
        return NextResponse.json(
          { error: "invalid_request", error_description: "code and redirect_uri required" },
          { status: 400 }
        );
      }

      // Exchange authorization code for tokens
      const result = await exchangeAuthorizationCode(
        code,
        finalClientId,
        redirect_uri,
        code_verifier
      );

      if (!result) {
        return NextResponse.json(
          { error: "invalid_grant", error_description: "Invalid or expired authorization code" },
          { status: 400 }
        );
      }

      // Create tokens
      const tokens = await createTokens(finalClientId, result.userId, result.scope);

      return NextResponse.json({
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        scope: result.scope,
      });
    } else if (grant_type === "refresh_token") {
      if (!refresh_token) {
        return NextResponse.json(
          { error: "invalid_request", error_description: "refresh_token required" },
          { status: 400 }
        );
      }

      // Refresh tokens
      const tokens = await refreshTokens(refresh_token, finalClientId);

      if (!tokens) {
        return NextResponse.json(
          { error: "invalid_grant", error_description: "Invalid refresh token" },
          { status: 400 }
        );
      }

      return NextResponse.json({
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
      });
    } else {
      return NextResponse.json(
        { error: "unsupported_grant_type", error_description: "Only authorization_code and refresh_token are supported" },
        { status: 400 }
      );
    }
  } catch (error) {
    console.error("Token endpoint error:", error);
    return NextResponse.json(
      { error: "server_error", error_description: "Internal server error" },
      { status: 500 }
    );
  }
}
