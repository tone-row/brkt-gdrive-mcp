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
    // Delete user's documents and chunks (chunks cascade delete)
    await db.execute({
      sql: "DELETE FROM documents WHERE user_id = ?",
      args: [userId],
    });

    // Delete the Google account connection from Better Auth
    await db.execute({
      sql: "DELETE FROM accounts WHERE user_id = ? AND provider_id = 'google'",
      args: [userId],
    });

    console.log(`Disconnected Google account for user ${userId}`);

    return NextResponse.json({
      success: true,
      message: "Google Drive disconnected successfully",
    });
  } catch (error: any) {
    console.error("Failed to disconnect Google account:", error);
    return NextResponse.json(
      { error: "Failed to disconnect", message: error.message },
      { status: 500 }
    );
  }
}
