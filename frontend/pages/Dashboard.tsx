import React, { useEffect, useState } from "react";
import { useSession, signOut, authClient } from "../lib/auth-client";

interface Props {
  navigate: (to: string) => void;
}

interface UserStatus {
  googleConnected: boolean;
  documentCount: number;
  chunkCount: number;
}

interface SearchResult {
  document_id: string;
  document_title: string;
  chunk_index: number;
  chunk_text: string;
  similarity: number;
}

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export default function Dashboard({ navigate }: Props) {
  const { data: session } = useSession();
  const [status, setStatus] = useState<UserStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);

  // API Keys state
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [newKeyName, setNewKeyName] = useState("");
  const [creatingKey, setCreatingKey] = useState(false);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);

  useEffect(() => {
    fetchStatus();
    fetchApiKeys();
  }, []);

  const fetchStatus = async () => {
    try {
      const res = await fetch("/api/me/status");
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      }
    } catch (error) {
      console.error("Failed to fetch status:", error);
    }
  };

  const fetchApiKeys = async () => {
    try {
      const res = await fetch("/api/keys");
      if (res.ok) {
        const data = await res.json();
        setApiKeys(data.keys);
      }
    } catch (error) {
      console.error("Failed to fetch API keys:", error);
    }
  };

  const handleCreateApiKey = async () => {
    if (!newKeyName.trim()) return;

    setCreatingKey(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newKeyName.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setNewlyCreatedKey(data.key);
        setNewKeyName("");
        fetchApiKeys();
      } else {
        console.error("Failed to create API key:", data.error);
      }
    } catch (error) {
      console.error("Create API key error:", error);
    } finally {
      setCreatingKey(false);
    }
  };

  const handleDeleteApiKey = async (keyId: string) => {
    try {
      const res = await fetch(`/api/keys/${keyId}`, { method: "DELETE" });
      if (res.ok) {
        fetchApiKeys();
      }
    } catch (error) {
      console.error("Delete API key error:", error);
    }
  };

  const handleCopyKey = async () => {
    if (newlyCreatedKey) {
      await navigator.clipboard.writeText(newlyCreatedKey);
      setKeyCopied(true);
      setTimeout(() => setKeyCopied(false), 2000);
    }
  };

  const handleDismissNewKey = () => {
    setNewlyCreatedKey(null);
    setKeyCopied(false);
  };

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  const handleConnectGoogle = async () => {
    await authClient.signIn.social({
      provider: "google",
      callbackURL: "/dashboard",
    });
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/me/sync", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setSyncResult(`Sync complete: +${data.added} added, ~${data.updated} updated, -${data.deleted} deleted`);
        fetchStatus(); // Refresh status
      } else {
        setSyncResult(`Sync failed: ${data.error}`);
      }
    } catch (error: any) {
      setSyncResult(`Sync failed: ${error.message}`);
    } finally {
      setSyncing(false);
    }
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    setSearching(true);
    setSearchResults(null);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: searchQuery, limit: 5 }),
      });
      const data = await res.json();
      if (res.ok) {
        setSearchResults(data.results);
      } else {
        console.error("Search failed:", data.error);
      }
    } catch (error) {
      console.error("Search error:", error);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.logo}>Google Drive Search</h1>
        <div style={styles.headerRight}>
          <span style={styles.email}>{session?.user?.email}</span>
          <button onClick={handleSignOut} style={styles.signOutButton}>
            Sign Out
          </button>
        </div>
      </header>

      <main style={styles.main}>
        <div style={styles.section}>
          <h2 style={styles.sectionTitle}>Google Drive Connection</h2>
          {status?.googleConnected ? (
            <>
              <p style={styles.sectionDescription}>
                Your Google account is connected. You can sync your documents below.
              </p>
              <div style={{ ...styles.statusBox, backgroundColor: "#d1fae5", marginBottom: "16px" }}>
                <span style={{ ...styles.statusValue, color: "#059669" }}>Connected</span>
              </div>
            </>
          ) : (
            <>
              <p style={styles.sectionDescription}>
                Connect your Google account to enable searching across your Google Docs.
              </p>
              <button onClick={handleConnectGoogle} style={styles.connectButton}>
                Connect Google Drive
              </button>
            </>
          )}
        </div>

        {status?.googleConnected && (
          <div style={styles.section}>
            <h2 style={styles.sectionTitle}>Sync Documents</h2>
            <p style={styles.sectionDescription}>
              Sync your Google Docs to make them searchable. Documents are also synced automatically twice daily.
            </p>
            <div style={styles.statsRow}>
              <div style={styles.statBox}>
                <span style={styles.statValue}>{status.documentCount}</span>
                <span style={styles.statLabel}>Documents</span>
              </div>
              <div style={styles.statBox}>
                <span style={styles.statValue}>{status.chunkCount}</span>
                <span style={styles.statLabel}>Chunks</span>
              </div>
            </div>
            <button
              onClick={handleSync}
              style={styles.primaryButton}
              disabled={syncing}
            >
              {syncing ? "Syncing..." : "Sync Now"}
            </button>
            {syncResult && (
              <p style={{
                marginTop: "12px",
                fontSize: "14px",
                color: syncResult.includes("failed") ? "#dc2626" : "#059669"
              }}>
                {syncResult}
              </p>
            )}
          </div>
        )}

        {status?.googleConnected && status.documentCount > 0 && (
          <div style={styles.section}>
            <h2 style={styles.sectionTitle}>Search Documents</h2>
            <p style={styles.sectionDescription}>
              Test semantic search across your indexed Google Docs.
            </p>
            <form onSubmit={handleSearch} style={styles.searchForm}>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search your documents..."
                style={styles.searchInput}
              />
              <button type="submit" style={styles.searchButton} disabled={searching}>
                {searching ? "..." : "Search"}
              </button>
            </form>
            {searchResults && (
              <div style={styles.searchResults}>
                {searchResults.length === 0 ? (
                  <p style={styles.noResults}>No results found</p>
                ) : (
                  searchResults.map((result, idx) => (
                    <div key={idx} style={styles.resultItem}>
                      <div style={styles.resultHeader}>
                        <span style={styles.resultTitle}>{result.document_title}</span>
                        <span style={styles.resultScore}>
                          {Math.round(result.similarity * 100)}% match
                        </span>
                      </div>
                      <p style={styles.resultText}>{result.chunk_text}</p>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}

        <div style={styles.section}>
          <h2 style={styles.sectionTitle}>API Keys</h2>
          <p style={styles.sectionDescription}>
            Generate an API key to use with the MCP server in Claude Desktop, Cursor, or other AI tools.
          </p>

          {/* New key creation form */}
          <div style={styles.createKeyForm}>
            <input
              type="text"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="Key name (e.g., Claude Desktop)"
              style={styles.keyNameInput}
            />
            <button
              onClick={handleCreateApiKey}
              style={styles.primaryButton}
              disabled={creatingKey || !newKeyName.trim()}
            >
              {creatingKey ? "Creating..." : "Generate API Key"}
            </button>
          </div>

          {/* Newly created key display (only shown once) */}
          {newlyCreatedKey && (
            <div style={styles.newKeyBox}>
              <p style={styles.newKeyWarning}>
                Copy this key now - it won't be shown again!
              </p>
              <div style={styles.newKeyDisplay}>
                <code style={styles.keyCode}>{newlyCreatedKey}</code>
                <button onClick={handleCopyKey} style={styles.copyButton}>
                  {keyCopied ? "Copied!" : "Copy"}
                </button>
              </div>
              <button onClick={handleDismissNewKey} style={styles.dismissButton}>
                I've saved my key
              </button>
            </div>
          )}

          {/* Existing keys list */}
          {apiKeys.length > 0 && (
            <div style={styles.keysList}>
              <h3 style={styles.keysListTitle}>Your API Keys</h3>
              {apiKeys.map((key) => (
                <div key={key.id} style={styles.keyItem}>
                  <div style={styles.keyInfo}>
                    <span style={styles.keyName}>{key.name}</span>
                    <code style={styles.keyPrefix}>{key.prefix}...</code>
                    <span style={styles.keyMeta}>
                      Created {new Date(key.createdAt).toLocaleDateString()}
                      {key.lastUsedAt && ` · Last used ${new Date(key.lastUsedAt).toLocaleDateString()}`}
                    </span>
                  </div>
                  <button
                    onClick={() => handleDeleteApiKey(key.id)}
                    style={styles.deleteButton}
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* MCP Configuration Example */}
          {apiKeys.length > 0 && (
            <div style={styles.configExample}>
              <h3 style={styles.keysListTitle}>Claude Desktop Configuration</h3>
              <p style={styles.configDescription}>
                Add this to your Claude Desktop config file:
              </p>
              <pre style={styles.configCode}>{`{
  "mcpServers": {
    "gdrive-search": {
      "command": "npx",
      "args": ["brkt-gdrive-mcp"],
      "env": {
        "GDRIVE_API_KEY": "your-api-key-here"
      }
    }
  }
}`}</pre>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: "100vh",
    backgroundColor: "#f5f5f5",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "16px 32px",
    backgroundColor: "#fff",
    borderBottom: "1px solid #eee",
  },
  logo: {
    fontSize: "20px",
    fontWeight: "bold",
    color: "#1a1a1a",
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: "16px",
  },
  email: {
    fontSize: "14px",
    color: "#666",
  },
  signOutButton: {
    padding: "8px 16px",
    fontSize: "14px",
    color: "#666",
    backgroundColor: "transparent",
    border: "1px solid #ddd",
    borderRadius: "6px",
    cursor: "pointer",
  },
  main: {
    maxWidth: "800px",
    margin: "0 auto",
    padding: "32px",
  },
  section: {
    backgroundColor: "#fff",
    padding: "24px",
    borderRadius: "12px",
    marginBottom: "24px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.05)",
  },
  sectionTitle: {
    fontSize: "20px",
    fontWeight: "600",
    marginBottom: "8px",
    color: "#1a1a1a",
  },
  sectionDescription: {
    fontSize: "14px",
    color: "#666",
    marginBottom: "16px",
    lineHeight: "1.5",
  },
  connectButton: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "12px 20px",
    fontSize: "14px",
    fontWeight: "500",
    color: "#fff",
    backgroundColor: "#4285f4",
    border: "none",
    borderRadius: "8px",
    cursor: "pointer",
  },
  primaryButton: {
    padding: "12px 20px",
    fontSize: "14px",
    fontWeight: "500",
    color: "#fff",
    backgroundColor: "#2563eb",
    border: "none",
    borderRadius: "8px",
    cursor: "pointer",
  },
  statusBox: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "12px 16px",
    backgroundColor: "#f8f9fa",
    borderRadius: "8px",
  },
  statusLabel: {
    fontSize: "14px",
    fontWeight: "500",
    color: "#333",
  },
  statusValue: {
    fontSize: "14px",
    color: "#666",
  },
  statsRow: {
    display: "flex",
    gap: "16px",
    marginBottom: "16px",
  },
  statBox: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: "16px 24px",
    backgroundColor: "#f8f9fa",
    borderRadius: "8px",
    minWidth: "100px",
  },
  statValue: {
    fontSize: "24px",
    fontWeight: "600",
    color: "#1a1a1a",
  },
  statLabel: {
    fontSize: "12px",
    color: "#666",
    marginTop: "4px",
  },
  searchForm: {
    display: "flex",
    gap: "8px",
    marginBottom: "16px",
  },
  searchInput: {
    flex: 1,
    padding: "12px 16px",
    fontSize: "14px",
    border: "1px solid #ddd",
    borderRadius: "8px",
    outline: "none",
  },
  searchButton: {
    padding: "12px 24px",
    fontSize: "14px",
    fontWeight: "500",
    color: "#fff",
    backgroundColor: "#2563eb",
    border: "none",
    borderRadius: "8px",
    cursor: "pointer",
  },
  searchResults: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  noResults: {
    color: "#666",
    fontSize: "14px",
    textAlign: "center",
    padding: "24px",
  },
  resultItem: {
    padding: "16px",
    backgroundColor: "#f8f9fa",
    borderRadius: "8px",
    border: "1px solid #eee",
  },
  resultHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "8px",
  },
  resultTitle: {
    fontSize: "14px",
    fontWeight: "600",
    color: "#1a1a1a",
  },
  resultScore: {
    fontSize: "12px",
    color: "#059669",
    backgroundColor: "#d1fae5",
    padding: "4px 8px",
    borderRadius: "4px",
  },
  resultText: {
    fontSize: "13px",
    color: "#444",
    lineHeight: "1.5",
    margin: 0,
    whiteSpace: "pre-wrap",
  },
  // API Keys styles
  createKeyForm: {
    display: "flex",
    gap: "8px",
    marginBottom: "16px",
  },
  keyNameInput: {
    flex: 1,
    padding: "12px 16px",
    fontSize: "14px",
    border: "1px solid #ddd",
    borderRadius: "8px",
    outline: "none",
  },
  newKeyBox: {
    backgroundColor: "#fef3c7",
    border: "1px solid #f59e0b",
    borderRadius: "8px",
    padding: "16px",
    marginBottom: "16px",
  },
  newKeyWarning: {
    color: "#b45309",
    fontWeight: "600",
    fontSize: "14px",
    marginBottom: "12px",
  },
  newKeyDisplay: {
    display: "flex",
    gap: "8px",
    marginBottom: "12px",
  },
  keyCode: {
    flex: 1,
    padding: "12px",
    backgroundColor: "#fff",
    border: "1px solid #ddd",
    borderRadius: "6px",
    fontSize: "13px",
    fontFamily: "monospace",
    wordBreak: "break-all",
  },
  copyButton: {
    padding: "12px 16px",
    fontSize: "14px",
    fontWeight: "500",
    color: "#fff",
    backgroundColor: "#059669",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  dismissButton: {
    padding: "8px 16px",
    fontSize: "14px",
    color: "#666",
    backgroundColor: "transparent",
    border: "1px solid #ddd",
    borderRadius: "6px",
    cursor: "pointer",
  },
  keysList: {
    marginTop: "24px",
  },
  keysListTitle: {
    fontSize: "16px",
    fontWeight: "600",
    color: "#1a1a1a",
    marginBottom: "12px",
  },
  keyItem: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 16px",
    backgroundColor: "#f8f9fa",
    borderRadius: "8px",
    marginBottom: "8px",
  },
  keyInfo: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  keyName: {
    fontSize: "14px",
    fontWeight: "500",
    color: "#1a1a1a",
  },
  keyPrefix: {
    fontSize: "12px",
    fontFamily: "monospace",
    color: "#666",
    backgroundColor: "#e5e7eb",
    padding: "2px 6px",
    borderRadius: "4px",
    width: "fit-content",
  },
  keyMeta: {
    fontSize: "12px",
    color: "#888",
  },
  deleteButton: {
    padding: "6px 12px",
    fontSize: "13px",
    color: "#dc2626",
    backgroundColor: "transparent",
    border: "1px solid #dc2626",
    borderRadius: "6px",
    cursor: "pointer",
  },
  configExample: {
    marginTop: "24px",
    padding: "16px",
    backgroundColor: "#f8f9fa",
    borderRadius: "8px",
  },
  configDescription: {
    fontSize: "14px",
    color: "#666",
    marginBottom: "12px",
  },
  configCode: {
    padding: "12px",
    backgroundColor: "#1a1a1a",
    color: "#f0f0f0",
    borderRadius: "6px",
    fontSize: "12px",
    fontFamily: "monospace",
    overflow: "auto",
    whiteSpace: "pre",
  },
};
