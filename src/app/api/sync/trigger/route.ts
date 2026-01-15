import { NextRequest, NextResponse } from "next/server";
import { sync } from "@/sync";

export async function POST(request: NextRequest) {
  // Authenticate with CRON_SECRET
  const authHeader = request.headers.get("Authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    console.error("CRON_SECRET not configured");
    return NextResponse.json(
      { error: "Server misconfiguration" },
      { status: 500 }
    );
  }

  if (!authHeader || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    console.log("Cron sync triggered at:", new Date().toISOString());

    // Run the sync for all users
    await sync();

    return NextResponse.json({
      success: true,
      message: "Sync completed successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Sync failed:", error);
    return NextResponse.json(
      {
        error: "Sync failed",
        message: error.message,
      },
      { status: 500 }
    );
  }
}

// Also support GET for Vercel Cron (which uses GET requests)
export async function GET(request: NextRequest) {
  // Vercel Cron uses a different auth mechanism
  const authHeader = request.headers.get("Authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    console.error("CRON_SECRET not configured");
    return NextResponse.json(
      { error: "Server misconfiguration" },
      { status: 500 }
    );
  }

  if (!authHeader || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    console.log("Cron sync triggered (GET) at:", new Date().toISOString());

    await sync();

    return NextResponse.json({
      success: true,
      message: "Sync completed successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Sync failed:", error);
    return NextResponse.json(
      {
        error: "Sync failed",
        message: error.message,
      },
      { status: 500 }
    );
  }
}
