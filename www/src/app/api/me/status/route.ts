import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helper";
import { db } from "@/db/client";

export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check if user has Google account connected
    const accountResult = await db.execute({
      sql: `SELECT id, access_token FROM accounts WHERE user_id = ? AND provider_id = 'google'`,
      args: [user.id],
    });
    const hasGoogleConnected = accountResult.rows.length > 0 && accountResult.rows[0]!.access_token;

    // Get document count
    const docResult = await db.execute({
      sql: `SELECT COUNT(*) as count FROM documents WHERE user_id = ?`,
      args: [user.id],
    });
    const documentCount = (docResult.rows[0]?.count as number) || 0;

    // Get chunk count
    const chunkResult = await db.execute({
      sql: `SELECT COUNT(*) as count FROM chunks WHERE user_id = ?`,
      args: [user.id],
    });
    const chunkCount = (chunkResult.rows[0]?.count as number) || 0;

    return NextResponse.json({
      googleConnected: !!hasGoogleConnected,
      documentCount,
      chunkCount,
    });
  } catch (error) {
    console.error("Status error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
