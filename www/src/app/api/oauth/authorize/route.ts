import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helper";
import { getOAuthClientByClientId, createAuthorizationCode } from "@/lib/oauth-clients";
import { getRegisteredClient } from "@/lib/oauth-dynamic";

/**
 * Build an error redirect URL for OAuth errors that should go back to the client
 */
function errorRedirect(redirectUri: string, error: string, description: string, state?: string) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return NextResponse.redirect(url.toString());
}

/**
 * Return an HTML error page for errors that must NOT redirect (invalid client_id, invalid redirect_uri)
 */
function errorPage(title: string, message: string) {
  return new NextResponse(
    `<!DOCTYPE html><html><head><title>${title}</title></head><body style="font-family:system-ui;max-width:500px;margin:80px auto;text-align:center"><h1>${title}</h1><p>${message}</p></body></html>`,
    { status: 400, headers: { "Content-Type": "text/html" } }
  );
}

/**
 * OAuth 2.0 Authorize — GET handler (MCP spec browser redirect flow)
 *
 * Flow:
 * 1. Validate client_id + redirect_uri (errors shown as page, never redirected)
 * 2. Validate remaining params (errors redirected to redirect_uri)
 * 3. Check session — no session → redirect to /login?returnUrl=<this URL>
 * 4. Has session → auto-approve, create auth code, redirect to redirect_uri
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const responseType = url.searchParams.get("response_type");
  const state = url.searchParams.get("state") || undefined;
  const codeChallenge = url.searchParams.get("code_challenge") || undefined;
  const codeChallengeMethod = url.searchParams.get("code_challenge_method") || undefined;
  const scope = url.searchParams.get("scope") || "mcp:tools";

  // --- Step 1: Validate client_id (render error page, never redirect) ---
  if (!clientId) {
    return errorPage("Invalid Request", "Missing client_id parameter.");
  }

  try {
    // Look up in dynamic registered clients first, then legacy oauth_clients
    const registeredClient = await getRegisteredClient(clientId);
    const legacyClient = registeredClient ? null : await getOAuthClientByClientId(clientId);

    if (!registeredClient && !legacyClient) {
      return errorPage("Unknown Client", "The client_id is not recognized.");
    }

    // --- Step 2: Validate redirect_uri (render error page, never redirect) ---
    if (!redirectUri) {
      return errorPage("Invalid Request", "Missing redirect_uri parameter.");
    }

    if (registeredClient) {
      if (!registeredClient.redirectUris.includes(redirectUri)) {
        return errorPage("Invalid Redirect", "The redirect_uri does not match the registered client.");
      }
    }
    // Legacy clients don't have registered redirect URIs — allow any

    // --- Step 3: Validate remaining params (redirect errors to redirect_uri) ---
    if (responseType !== "code") {
      return errorRedirect(redirectUri, "unsupported_response_type", "Only response_type=code is supported.", state);
    }

    if (!state) {
      return errorRedirect(redirectUri, "invalid_request", "state parameter is required.", state);
    }

    if (codeChallengeMethod && codeChallengeMethod !== "S256") {
      return errorRedirect(redirectUri, "invalid_request", "Only S256 code_challenge_method is supported.", state);
    }

    // --- Step 4: Check session ---
    let user: { id: string; email: string } | null;
    try {
      user = await getCurrentUser(request);
    } catch (sessionError) {
      console.error("Authorize GET: getCurrentUser failed:", sessionError);
      throw sessionError;
    }

    if (!user) {
      // No session — redirect to login with returnUrl pointing back here
      const authorizeUrl = url.toString();
      const loginUrl = new URL("/login", url.origin);
      loginUrl.searchParams.set("returnUrl", authorizeUrl);
      return NextResponse.redirect(loginUrl.toString());
    }

    // --- Step 5: Auto-approve — create auth code and redirect ---
    console.log("Authorize GET: creating code for user", user.id, "client", clientId);
    try {
      const code = await createAuthorizationCode(
        clientId,
        user.id,
        redirectUri,
        scope,
        codeChallenge,
        codeChallengeMethod
      );

      const callbackUrl = new URL(redirectUri);
      callbackUrl.searchParams.set("code", code);
      callbackUrl.searchParams.set("state", state);
      return NextResponse.redirect(callbackUrl.toString());
    } catch (codeError) {
      console.error("Authorize GET: createAuthorizationCode failed for user", user.id, "client", clientId, "error:", codeError);
      throw codeError;
    }
  } catch (error) {
    console.error("Authorize GET error:", error);
    return errorPage("Server Error", "An unexpected error occurred. Please try again.");
  }
}

/**
 * Create an authorization code (legacy POST handler)
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
