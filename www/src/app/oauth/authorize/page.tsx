"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "@/lib/auth-client";

interface ClientInfo {
  name: string;
  clientIdPrefix: string;
}

function OAuthAuthorizeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, isPending } = useSession();

  const [clientInfo, setClientInfo] = useState<ClientInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authorizing, setAuthorizing] = useState(false);

  // OAuth parameters
  const clientId = searchParams.get("client_id");
  const redirectUri = searchParams.get("redirect_uri");
  const responseType = searchParams.get("response_type");
  const scope = searchParams.get("scope") || "mcp:tools";
  const state = searchParams.get("state");
  const codeChallenge = searchParams.get("code_challenge");
  const codeChallengeMethod = searchParams.get("code_challenge_method");

  useEffect(() => {
    // Validate required parameters
    if (!clientId) {
      setError("Missing client_id parameter");
      return;
    }
    if (!redirectUri) {
      setError("Missing redirect_uri parameter");
      return;
    }
    if (responseType !== "code") {
      setError("Invalid response_type. Only 'code' is supported.");
      return;
    }

    // Fetch client info
    fetchClientInfo();
  }, [clientId, redirectUri, responseType]);

  useEffect(() => {
    // Redirect to login if not authenticated
    if (!isPending && !session) {
      const returnUrl = encodeURIComponent(window.location.href);
      router.push(`/login?returnUrl=${returnUrl}`);
    }
  }, [session, isPending, router]);

  const fetchClientInfo = async () => {
    try {
      const res = await fetch(`/api/oauth/clients/info?client_id=${encodeURIComponent(clientId!)}`);
      if (res.ok) {
        const data = await res.json();
        setClientInfo(data);
      } else {
        setError("Invalid client_id");
      }
    } catch {
      setError("Failed to validate client");
    }
  };

  const handleAuthorize = async () => {
    setAuthorizing(true);
    try {
      const res = await fetch("/api/oauth/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          redirect_uri: redirectUri,
          scope,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: codeChallengeMethod,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        // Redirect back to client with authorization code
        const redirectUrl = new URL(redirectUri!);
        redirectUrl.searchParams.set("code", data.code);
        if (state) {
          redirectUrl.searchParams.set("state", state);
        }
        window.location.href = redirectUrl.toString();
      } else {
        setError(data.error || "Authorization failed");
        setAuthorizing(false);
      }
    } catch {
      setError("Authorization failed");
      setAuthorizing(false);
    }
  };

  const handleDeny = () => {
    // Redirect back to client with error
    const redirectUrl = new URL(redirectUri!);
    redirectUrl.searchParams.set("error", "access_denied");
    redirectUrl.searchParams.set("error_description", "User denied the authorization request");
    if (state) {
      redirectUrl.searchParams.set("state", state);
    }
    window.location.href = redirectUrl.toString();
  };

  if (isPending) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex justify-center items-center min-h-screen bg-gray-100">
        <div className="bg-white p-8 rounded-xl shadow-lg max-w-md w-full">
          <h1 className="text-xl font-bold text-red-600 mb-4">Authorization Error</h1>
          <p className="text-gray-600">{error}</p>
        </div>
      </div>
    );
  }

  if (!session || !clientInfo) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex justify-center items-center min-h-screen bg-gray-100">
      <div className="bg-white p-8 rounded-xl shadow-lg max-w-md w-full">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Authorize Application</h1>
        <p className="text-gray-600 mb-6">
          <strong>{clientInfo.name}</strong> wants to access your Google Drive Search account.
        </p>

        <div className="bg-gray-50 rounded-lg p-4 mb-6">
          <h2 className="font-medium text-sm text-gray-700 mb-2">This will allow the application to:</h2>
          <ul className="text-sm text-gray-600 space-y-1">
            <li className="flex items-center gap-2">
              <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Search your indexed Google Docs
            </li>
            <li className="flex items-center gap-2">
              <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              List your indexed documents
            </li>
            <li className="flex items-center gap-2">
              <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Read full document contents
            </li>
          </ul>
        </div>

        <div className="text-xs text-gray-400 mb-6">
          <p>Signed in as: {session.user?.email}</p>
          <p>Client ID: {clientInfo.clientIdPrefix}...</p>
        </div>

        <div className="flex gap-3">
          <button
            onClick={handleDeny}
            className="flex-1 px-4 py-2.5 text-gray-600 border border-gray-300 rounded-lg font-medium hover:bg-gray-50"
          >
            Deny
          </button>
          <button
            onClick={handleAuthorize}
            disabled={authorizing}
            className="flex-1 px-4 py-2.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {authorizing ? "Authorizing..." : "Authorize"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function OAuthAuthorize() {
  return (
    <Suspense fallback={
      <div className="flex justify-center items-center min-h-screen">
        <p className="text-gray-500">Loading...</p>
      </div>
    }>
      <OAuthAuthorizeContent />
    </Suspense>
  );
}
