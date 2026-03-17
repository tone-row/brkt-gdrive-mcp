import { db } from "../db/client";

/**
 * Dynamically registered OAuth client (MCP spec - public clients)
 */
export interface RegisteredClient {
  clientId: string;
  clientSecretHash: string | null;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
  createdAt: string;
}

/**
 * Register a new dynamic OAuth client (MCP spec)
 */
export async function registerClient(params: {
  clientName: string;
  redirectUris: string[];
  grantTypes?: string[];
  responseTypes?: string[];
  tokenEndpointAuthMethod?: string;
}): Promise<RegisteredClient> {
  const clientId = crypto.randomUUID();
  const grantTypes = params.grantTypes || ["authorization_code"];
  const responseTypes = params.responseTypes || ["code"];
  const tokenEndpointAuthMethod = params.tokenEndpointAuthMethod || "none";

  await db.execute({
    sql: `INSERT INTO oauth_registered_clients
          (client_id, client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      clientId,
      params.clientName,
      JSON.stringify(params.redirectUris),
      JSON.stringify(grantTypes),
      JSON.stringify(responseTypes),
      tokenEndpointAuthMethod,
    ],
  });

  return {
    clientId,
    clientSecretHash: null,
    clientName: params.clientName,
    redirectUris: params.redirectUris,
    grantTypes,
    responseTypes,
    tokenEndpointAuthMethod,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Look up a dynamically registered client by client_id
 */
export async function getRegisteredClient(clientId: string): Promise<RegisteredClient | null> {
  const result = await db.execute({
    sql: `SELECT client_id, client_secret_hash, client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method, created_at
          FROM oauth_registered_clients
          WHERE client_id = ?`,
    args: [clientId],
  });

  if (result.rows.length === 0) return null;

  const row = result.rows[0]!;
  return {
    clientId: row.client_id as string,
    clientSecretHash: row.client_secret_hash as string | null,
    clientName: row.client_name as string,
    redirectUris: JSON.parse(row.redirect_uris as string),
    grantTypes: JSON.parse(row.grant_types as string),
    responseTypes: JSON.parse(row.response_types as string),
    tokenEndpointAuthMethod: row.token_endpoint_auth_method as string,
    createdAt: row.created_at as string,
  };
}
