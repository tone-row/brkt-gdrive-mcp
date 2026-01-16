import { google } from "googleapis";

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt?: Date | null;
}

export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  wasRefreshed: boolean;
}

export interface DriveDocument {
  id: string;
  name: string;
  modifiedTime: string;
  mimeType: string;
}

/**
 * Create an OAuth2 client with user's tokens
 */
function getOAuthClient(tokens: GoogleTokens) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expiry_date: tokens.expiresAt?.getTime(),
  });

  return oauth2Client;
}

/**
 * Refresh tokens if needed and return updated credentials
 * Returns null if refresh failed (token revoked/expired)
 */
export async function refreshTokensIfNeeded(tokens: GoogleTokens): Promise<RefreshedTokens | null> {
  const oauth2Client = getOAuthClient(tokens);

  // Check if token is expired or will expire in the next 5 minutes
  const now = Date.now();
  const expiresAt = tokens.expiresAt?.getTime() ?? 0;
  const isExpired = expiresAt < now + 5 * 60 * 1000;

  if (!isExpired) {
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt ?? null,
      wasRefreshed: false,
    };
  }

  // Token is expired, try to refresh
  if (!tokens.refreshToken) {
    console.error("  Token expired and no refresh token available");
    return null;
  }

  try {
    console.log("  Access token expired, refreshing...");
    const { credentials } = await oauth2Client.refreshAccessToken();

    if (!credentials.access_token) {
      console.error("  Failed to get new access token from refresh");
      return null;
    }

    console.log("  Token refreshed successfully");
    return {
      accessToken: credentials.access_token,
      refreshToken: credentials.refresh_token ?? tokens.refreshToken,
      expiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
      wasRefreshed: true,
    };
  } catch (error: any) {
    // Check for specific error types
    if (error.message?.includes("invalid_grant") ||
        error.message?.includes("Token has been expired or revoked")) {
      console.error("  Refresh token is invalid or revoked - user needs to re-authenticate");
    } else {
      console.error(`  Failed to refresh token: ${error.message}`);
    }
    return null;
  }
}

/**
 * List all Google Docs the user has access to
 */
export async function listGoogleDocs(tokens: GoogleTokens): Promise<DriveDocument[]> {
  const auth = getOAuthClient(tokens);
  const drive = google.drive({ version: "v3", auth });

  const documents: DriveDocument[] = [];
  let pageToken: string | undefined;

  do {
    const response = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.document' and trashed=false",
      fields: "nextPageToken, files(id, name, modifiedTime, mimeType)",
      pageSize: 100,
      pageToken,
    });

    if (response.data.files) {
      for (const file of response.data.files) {
        if (file.id && file.name && file.modifiedTime && file.mimeType) {
          documents.push({
            id: file.id,
            name: file.name,
            modifiedTime: file.modifiedTime,
            mimeType: file.mimeType,
          });
        }
      }
    }

    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return documents;
}

/**
 * Export a Google Doc as plain text
 */
export async function exportDocAsText(tokens: GoogleTokens, docId: string): Promise<string> {
  const auth = getOAuthClient(tokens);
  const drive = google.drive({ version: "v3", auth });

  const response = await drive.files.export({
    fileId: docId,
    mimeType: "text/plain",
  });

  return response.data as string;
}
