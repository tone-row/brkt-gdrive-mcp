import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helper";
import { db } from "@/db/client";
import { markSyncFailed } from "@/sync/status";

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log(`Sync cancel requested by user: ${user.email}`);

    // Mark V1 sync as failed
    await markSyncFailed(user.id, "Cancelled by user");

    // Mark V2 sync as failed
    try {
      await db.execute({
        sql: `UPDATE user_sync_state SET
                status = 'failed',
                completed_at = datetime('now'),
                error = 'Cancelled by user'
              WHERE user_id = ?`,
        args: [user.id],
      });
    } catch {
      // V2 table might not exist
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Cancel sync error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
