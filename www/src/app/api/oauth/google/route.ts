import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db/client";

export async function DELETE(request: NextRequest) {
  // Get the current user from session
  const session = await auth.api.getSession({ headers: request.headers });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;

  try {
    // Only delete the Google account connection - preserve indexed documents
    // Documents will be re-synced when user reconnects
    await db.execute({
      sql: "DELETE FROM accounts WHERE user_id = ? AND provider_id = 'google'",
      args: [userId],
    });

    // Also clear sync status so it doesn't show stale errors
    await db.execute({
      sql: "DELETE FROM sync_status WHERE user_id = ?",
      args: [userId],
    });

    console.log(`Disconnected Google account for user ${userId} (documents preserved)`);

    return NextResponse.json({
      success: true,
      message: "Google Drive disconnected (your indexed documents are preserved)",
    });
  } catch (error: any) {
    console.error("Failed to disconnect Google account:", error);
    return NextResponse.json(
      { error: "Failed to disconnect", message: error.message },
      { status: 500 }
    );
  }
}
