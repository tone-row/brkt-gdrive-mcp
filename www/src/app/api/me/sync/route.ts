import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helper";

const SYNC_SERVER_URL = process.env.SYNC_SERVER_URL;
const CRON_SECRET = process.env.CRON_SECRET;

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log(`Manual sync triggered for user: ${user.email}`);

    // Call the Fly.io sync server for this specific user
    if (!SYNC_SERVER_URL || !CRON_SECRET) {
      return NextResponse.json(
        { error: "Sync server not configured" },
        { status: 500 }
      );
    }

    const response = await fetch(`${SYNC_SERVER_URL}/sync/${user.id}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${CRON_SECRET}`,
        "Content-Type": "application/json",
      },
    });

    const result = await response.json();

    if (!response.ok) {
      // Handle "already syncing" case
      if (response.status === 409) {
        return NextResponse.json(
          { error: "Sync already in progress", message: result.message },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: result.error || "Sync failed", message: result.message },
        { status: response.status }
      );
    }

    return NextResponse.json({
      success: true,
      added: result.added,
      updated: result.updated,
      deleted: result.deleted,
      duration: result.duration,
    });
  } catch (error: unknown) {
    console.error("Sync error:", error);
    const message = error instanceof Error ? error.message : "Sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
