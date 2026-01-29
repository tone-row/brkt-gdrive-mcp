import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helper";
import { db } from "@/db/client";

interface FileJob {
  id: string;
  fileName: string;
  status: "pending" | "processing" | "completed" | "failed" | "skipped";
  error: string | null;
  completedAt: string | null;
}

interface FileSummary {
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  skipped: number;
}

export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Fetch file jobs for this user, ordered by status priority
    const result = await db.execute({
      sql: `
        SELECT
          id,
          file_name,
          status,
          error,
          completed_at
        FROM file_jobs
        WHERE user_id = ?
        ORDER BY
          CASE status
            WHEN 'processing' THEN 1
            WHEN 'pending' THEN 2
            WHEN 'failed' THEN 3
            WHEN 'completed' THEN 4
            WHEN 'skipped' THEN 5
          END,
          created_at DESC
      `,
      args: [user.id],
    });

    const files: FileJob[] = result.rows.map((row) => ({
      id: String(row.id),
      fileName: (row.file_name as string) || "Unknown file",
      status: row.status as FileJob["status"],
      error: (row.error as string) || null,
      completedAt: (row.completed_at as string) || null,
    }));

    // Calculate summary
    const summary: FileSummary = {
      total: files.length,
      pending: files.filter((f) => f.status === "pending").length,
      processing: files.filter((f) => f.status === "processing").length,
      completed: files.filter((f) => f.status === "completed").length,
      failed: files.filter((f) => f.status === "failed").length,
      skipped: files.filter((f) => f.status === "skipped").length,
    };

    return NextResponse.json({ files, summary });
  } catch (error) {
    console.error("Error fetching file jobs:", error);
    return NextResponse.json(
      { error: "Failed to fetch file jobs" },
      { status: 500 }
    );
  }
}
