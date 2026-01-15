import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helper";
import { syncUserById } from "@/sync";

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log(`Manual sync triggered for user: ${user.email}`);
    const result = await syncUserById(user.id);

    return NextResponse.json({
      success: true,
      added: result.added,
      updated: result.updated,
      deleted: result.deleted,
    });
  } catch (error: unknown) {
    console.error("Sync error:", error);
    const message = error instanceof Error ? error.message : "Sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
