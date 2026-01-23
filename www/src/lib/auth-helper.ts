import { auth } from "@/auth";
import { validateApiKey } from "./api-keys";
import { validateAccessToken } from "./oauth-clients";

/**
 * Helper to get the current user from session (for web app)
 */
export async function getCurrentUser(request: Request): Promise<{ id: string; email: string } | null> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return null;
  return { id: session.user.id, email: session.user.email };
}

/**
 * Helper to get user from API key in Authorization header
 * Checks Authorization header for "Bearer <api-key>"
 */
export async function getUserFromAuthHeader(request: Request): Promise<string | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);

  return validateToken(token);
}

/**
 * Helper to get user from API key in URL query parameter
 * Checks for ?key=<api-key> in the URL
 */
export async function getUserFromQueryParam(request: Request): Promise<string | null> {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!key) return null;

  return validateToken(key);
}

/**
 * Validate a token (API key or OAuth access token)
 */
async function validateToken(token: string): Promise<string | null> {
  // Try API key first (starts with "gd_")
  if (token.startsWith("gd_")) {
    return validateApiKey(token);
  }

  // Try OAuth access token (starts with "at_")
  if (token.startsWith("at_")) {
    return validateAccessToken(token);
  }

  // Legacy: try as API key anyway
  return validateApiKey(token);
}

/**
 * Helper to get user from either session, query param, or Authorization header
 * Returns user ID or null
 *
 * Priority:
 * 1. Session auth (browser)
 * 2. URL query param (?key=gd_xxx) - simplest for MCP clients
 * 3. Authorization header (Bearer token) - backwards compatible
 */
export async function getAuthenticatedUserId(request: Request): Promise<string | null> {
  // Try session auth first (for web app)
  const user = await getCurrentUser(request);
  if (user) return user.id;

  // Try URL query param auth (simplest for MCP)
  const queryUser = await getUserFromQueryParam(request);
  if (queryUser) return queryUser;

  // Fall back to Authorization header auth (backwards compatible)
  return getUserFromAuthHeader(request);
}
