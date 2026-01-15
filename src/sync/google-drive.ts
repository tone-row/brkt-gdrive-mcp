import { google } from "googleapis";

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt?: Date | null;
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
