"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession, signOut, authClient } from "@/lib/auth-client";

interface SyncStatusInfo {
  status: "idle" | "syncing" | "failed";
  startedAt: string | null;
  completedAt: string | null;
  lastResult: { added: number; updated: number; deleted: number } | null;
  error: string | null;
}

interface UserStatus {
  googleConnected: boolean;
  needsReconnect: boolean;
  documentCount: number;
  chunkCount: number;
  syncStatus: SyncStatusInfo | null;
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


export default function Dashboard() {
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const [status, setStatus] = useState<UserStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [newKeyName, setNewKeyName] = useState("");
  const [creatingKey, setCreatingKey] = useState(false);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  // URL copy state
  const [urlCopied, setUrlCopied] = useState(false);

  useEffect(() => {
    if (!isPending && !session) {
      router.push("/login");
    }
  }, [session, isPending, router]);

  useEffect(() => {
    if (session) {
      fetchStatus();
      fetchApiKeys();
    }
  }, [session]);

  // Check if sync is already in progress on page load
  useEffect(() => {
    if (status?.syncStatus?.status === "syncing" && !syncing) {
      setSyncing(true);
      pollSyncStatus();
    }
  }, [status?.syncStatus?.status]);

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

  const handleSignOut = async () => {
    await signOut();
    router.push("/");
  };

  const handleConnectGoogle = async () => {
    await authClient.signIn.social({
      provider: "google",
      callbackURL: "/dashboard",
    });
  };

  const handleDisconnect = async () => {
    if (!confirm("Disconnect your Google Drive? Your indexed documents will be preserved and you can reconnect anytime.")) {
      return;
    }

    setDisconnecting(true);
    try {
      const res = await fetch("/api/oauth/google", { method: "DELETE" });
      if (res.ok) {
        // Documents are preserved, just update connection status
        setStatus(prev => prev ? { ...prev, googleConnected: false, needsReconnect: prev.documentCount > 0, syncStatus: null } : null);
        setSyncResult(null);
      } else {
        const data = await res.json();
        alert(`Failed to disconnect: ${data.error}`);
      }
    } catch (error: any) {
      alert(`Failed to disconnect: ${error.message}`);
    } finally {
      setDisconnecting(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/me/sync", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        // Sync started in background - poll for completion
        setSyncResult("Syncing...");
        pollSyncStatus();
      } else if (res.status === 409) {
        // Sync already in progress - start polling
        setSyncResult("Sync already in progress...");
        pollSyncStatus();
      } else {
        setSyncResult(`Sync failed: ${data.error}`);
        setSyncing(false);
      }
    } catch (error: any) {
      setSyncResult(`Sync failed: ${error.message}`);
      setSyncing(false);
    }
  };

  const pollSyncStatus = async () => {
    const poll = async () => {
      try {
        const res = await fetch("/api/me/status");
        if (res.ok) {
          const data = await res.json();
          setStatus(data);

          if (data.syncStatus?.status === "syncing") {
            // Still syncing, poll again
            setTimeout(poll, 2000);
          } else {
            // Sync finished
            setSyncing(false);
            if (data.syncStatus?.status === "failed") {
              setSyncResult(`Sync failed: ${data.syncStatus.error}`);
            } else if (data.syncStatus?.lastResult) {
              const r = data.syncStatus.lastResult;
              setSyncResult(`Sync complete: +${r.added} added, ~${r.updated} updated, -${r.deleted} deleted`);
            }
          }
        }
      } catch (error) {
        console.error("Failed to poll status:", error);
        setSyncing(false);
      }
    };
    poll();
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
      }
    } catch (error) {
      console.error("Search error:", error);
    } finally {
      setSearching(false);
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

  const getMcpServerUrl = (apiKey?: string) => {
    const baseUrl = typeof window !== "undefined"
      ? `${window.location.origin}/mcp`
      : "https://brkt-gdrive-mcp.vercel.app/mcp";
    return apiKey ? `${baseUrl}?key=${apiKey}` : baseUrl;
  };

  const handleCopyMcpUrl = async () => {
    if (newlyCreatedKey) {
      await navigator.clipboard.writeText(getMcpServerUrl(newlyCreatedKey));
      setUrlCopied(true);
      setTimeout(() => setUrlCopied(false), 2000);
    }
  };

  if (isPending) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  if (!session) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="flex justify-between items-center px-8 py-4 bg-white border-b border-gray-200">
        <h1 className="text-xl font-bold text-gray-900">Google Drive Search</h1>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-600">{session.user?.email}</span>
          <button
            onClick={handleSignOut}
            className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50"
          >
            Sign Out
          </button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-8 space-y-6">
        {/* Google Drive Connection */}
        <section className="bg-white p-6 rounded-xl shadow-sm">
          <h2 className="text-xl font-semibold mb-2">Google Drive Connection</h2>
          {status?.googleConnected ? (
            <>
              <p className="text-gray-600 text-sm mb-4">
                Your Google account is connected. You can sync your documents below.
              </p>
              <div className="flex items-center gap-3">
                <div className="inline-block px-4 py-2 bg-green-100 text-green-700 rounded-lg text-sm font-medium">
                  Connected
                </div>
                <button
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                  className="px-4 py-2 text-red-600 border border-red-300 rounded-lg text-sm hover:bg-red-50 disabled:opacity-50"
                >
                  {disconnecting ? "Disconnecting..." : "Disconnect"}
                </button>
              </div>
            </>
          ) : status?.needsReconnect ? (
            <>
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg mb-4">
                <p className="text-amber-800 text-sm">
                  Your Google authorization has expired. Reconnect to continue syncing your {status.documentCount} indexed documents.
                </p>
              </div>
              <button
                onClick={handleConnectGoogle}
                className="px-5 py-2.5 bg-amber-500 text-white rounded-lg font-medium hover:bg-amber-600"
              >
                Reconnect Google Drive
              </button>
            </>
          ) : (
            <>
              <p className="text-gray-600 text-sm mb-4">
                Connect your Google account to enable searching across your Google Docs.
              </p>
              <button
                onClick={handleConnectGoogle}
                className="px-5 py-2.5 bg-blue-500 text-white rounded-lg font-medium hover:bg-blue-600"
              >
                Connect Google Drive
              </button>
            </>
          )}
        </section>

        {/* Sync Documents */}
        {status?.googleConnected && (
          <section className="bg-white p-6 rounded-xl shadow-sm">
            <h2 className="text-xl font-semibold mb-2">Sync Documents</h2>
            <p className="text-gray-600 text-sm mb-4">
              Sync your Google Docs to make them searchable.
            </p>
            <div className="flex gap-4 mb-4">
              <div className="flex flex-col items-center px-6 py-4 bg-gray-50 rounded-lg">
                <span className="text-2xl font-bold">{status.documentCount}</span>
                <span className="text-xs text-gray-500">Documents</span>
              </div>
              <div className="flex flex-col items-center px-6 py-4 bg-gray-50 rounded-lg">
                <span className="text-2xl font-bold">{status.chunkCount}</span>
                <span className="text-xs text-gray-500">Chunks</span>
              </div>
            </div>

            {/* Sync Status Info */}
            {status.syncStatus && (
              <div className="mb-4 p-3 bg-gray-50 rounded-lg text-sm">
                {status.syncStatus.status === "syncing" && (
                  <div className="flex items-center gap-2 text-blue-600">
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    <span>Sync in progress...</span>
                  </div>
                )}
                {status.syncStatus.status === "failed" && status.syncStatus.error && (
                  <div className="text-red-600">
                    <span className="font-medium">Last sync failed:</span> {status.syncStatus.error}
                  </div>
                )}
                {status.syncStatus.completedAt && status.syncStatus.status !== "syncing" && (
                  <div className="text-gray-600">
                    <span className="font-medium">Last synced:</span>{" "}
                    {new Date(status.syncStatus.completedAt).toLocaleString()}
                    {status.syncStatus.lastResult && status.syncStatus.status === "idle" && (
                      <span className="ml-2 text-gray-500">
                        (+{status.syncStatus.lastResult.added} ~{status.syncStatus.lastResult.updated} -{status.syncStatus.lastResult.deleted})
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}

            <button
              onClick={handleSync}
              disabled={syncing || status.syncStatus?.status === "syncing"}
              className="px-5 py-2.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {syncing || status.syncStatus?.status === "syncing" ? "Syncing..." : "Sync Now"}
            </button>
            {syncResult && (
              <p className={`mt-3 text-sm ${syncResult.includes("failed") ? "text-red-600" : "text-green-600"}`}>
                {syncResult}
              </p>
            )}
          </section>
        )}

        {/* Search Documents */}
        {(status?.googleConnected || status?.needsReconnect) && status.documentCount > 0 && (
          <section className="bg-white p-6 rounded-xl shadow-sm">
            <h2 className="text-xl font-semibold mb-2">Search Documents</h2>
            <p className="text-gray-600 text-sm mb-4">
              Test semantic search across your indexed Google Docs.
            </p>
            <form onSubmit={handleSearch} className="flex gap-2 mb-4">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search your documents..."
                className="flex-1 px-4 py-2.5 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                type="submit"
                disabled={searching}
                className="px-6 py-2.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {searching ? "..." : "Search"}
              </button>
            </form>
            {searchResults && (
              <div className="space-y-3">
                {searchResults.length === 0 ? (
                  <p className="text-gray-500 text-center py-6">No results found</p>
                ) : (
                  searchResults.map((result, idx) => (
                    <div key={idx} className="p-4 bg-gray-50 rounded-lg border border-gray-200">
                      <div className="flex justify-between items-center mb-2">
                        <span className="font-medium text-sm">{result.document_title}</span>
                        <span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded">
                          {Math.round(result.similarity * 100)}% match
                        </span>
                      </div>
                      <p className="text-sm text-gray-600 whitespace-pre-wrap">{result.chunk_text}</p>
                    </div>
                  ))
                )}
              </div>
            )}
          </section>
        )}

        {/* MCP Connection */}
        <section className="bg-white p-6 rounded-xl shadow-sm">
          <h2 className="text-xl font-semibold mb-2">Connect to Claude</h2>
          <p className="text-gray-600 text-sm mb-4">
            Generate an API key to connect your Google Drive search to Claude Desktop, Claude Mobile, Cursor, or other AI tools.
          </p>

          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="Key name (e.g., Claude Desktop)"
              className="flex-1 px-4 py-2.5 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={handleCreateApiKey}
              disabled={creatingKey || !newKeyName.trim()}
              className="px-5 py-2.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {creatingKey ? "Creating..." : "Generate"}
            </button>
          </div>

          {newlyCreatedKey && (
            <div className="bg-amber-50 border border-amber-400 rounded-lg p-4 mb-4">
              <p className="text-amber-700 font-semibold text-sm mb-3">
                Save these now - they won&apos;t be shown again!
              </p>

              <div className="space-y-4">
                {/* MCP URL for Claude Mobile/Web */}
                <div>
                  <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                    MCP Server URL (for Claude Mobile &amp; Web)
                  </label>
                  <p className="text-xs text-gray-500 mb-2">
                    Add this URL as a custom MCP connector in Claude settings
                  </p>
                  <div className="flex gap-2">
                    <code className="flex-1 p-3 bg-white border border-gray-200 rounded text-xs font-mono break-all">
                      {getMcpServerUrl(newlyCreatedKey)}
                    </code>
                    <button
                      onClick={handleCopyMcpUrl}
                      className="px-4 py-2 bg-green-600 text-white rounded font-medium hover:bg-green-700 whitespace-nowrap"
                    >
                      {urlCopied ? "Copied!" : "Copy URL"}
                    </button>
                  </div>
                </div>

                {/* Raw API Key for Desktop Apps */}
                <div>
                  <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                    API Key (for Claude Desktop &amp; other apps)
                  </label>
                  <p className="text-xs text-gray-500 mb-2">
                    Use with <code className="bg-gray-100 px-1 rounded">GDRIVE_API_KEY</code> environment variable
                  </p>
                  <div className="flex gap-2">
                    <code className="flex-1 p-3 bg-white border border-gray-200 rounded text-xs font-mono break-all">
                      {newlyCreatedKey}
                    </code>
                    <button
                      onClick={handleCopyKey}
                      className="px-4 py-2 bg-gray-600 text-white rounded font-medium hover:bg-gray-700 whitespace-nowrap"
                    >
                      {keyCopied ? "Copied!" : "Copy Key"}
                    </button>
                  </div>
                </div>
              </div>

              <button
                onClick={() => {
                  setNewlyCreatedKey(null);
                  setKeyCopied(false);
                  setUrlCopied(false);
                }}
                className="mt-4 px-4 py-2 text-gray-600 border border-gray-300 rounded hover:bg-gray-50"
              >
                I&apos;ve saved my credentials
              </button>
            </div>
          )}

          {apiKeys.length > 0 && (
            <div className="space-y-2">
              <h3 className="font-medium text-sm mb-2">Your API Keys</h3>
              {apiKeys.map((key) => (
                <div key={key.id} className="flex justify-between items-center p-3 bg-gray-50 rounded-lg">
                  <div>
                    <p className="font-medium text-sm">{key.name}</p>
                    <code className="text-xs text-gray-500 bg-gray-200 px-2 py-0.5 rounded">
                      {key.prefix}...
                    </code>
                    <p className="text-xs text-gray-400 mt-1">
                      Created {new Date(key.createdAt).toLocaleDateString()}
                      {key.lastUsedAt && ` · Last used ${new Date(key.lastUsedAt).toLocaleDateString()}`}
                    </p>
                  </div>
                  <button
                    onClick={() => handleDeleteApiKey(key.id)}
                    className="px-3 py-1.5 text-red-600 border border-red-600 rounded text-sm hover:bg-red-50"
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Setup instructions */}
          <div className="mt-6 p-4 bg-gray-50 rounded-lg">
            <h3 className="font-medium text-sm mb-2">Setup Instructions</h3>
            <div className="text-xs text-gray-600 space-y-2">
              <p><strong>Claude Mobile &amp; Web:</strong> Go to Settings → Integrations → Add custom MCP connector. Paste the MCP Server URL.</p>
              <p><strong>Claude Desktop:</strong> Add the API key to your environment as <code className="bg-gray-200 px-1 rounded">GDRIVE_API_KEY</code>.</p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
