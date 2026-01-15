import { auth } from "@/auth";
import { validateApiKey } from "./api-keys";

/**
 * Helper to get the current user from session (for web app)
 */
export async function getCurrentUser(request: Request): Promise<{ id: string; email: string } | null> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return null;
  return { id: session.user.id, email: session.user.email };
}

/**
 * Helper to get user from API key (for MCP server)
 * Checks Authorization header for "Bearer <api-key>"
 */
export async function getUserFromApiKey(request: Request): Promise<string | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const apiKey = authHeader.slice(7);
  return validateApiKey(apiKey);
}

/**
 * Helper to get user from either session or API key
 * Returns user ID or null
 */
export async function getAuthenticatedUserId(request: Request): Promise<string | null> {
  // Try session auth first
  const user = await getCurrentUser(request);
  if (user) return user.id;

  // Fall back to API key auth
  return getUserFromApiKey(request);
}
