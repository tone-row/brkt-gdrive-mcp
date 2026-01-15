import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth-helper";
import { db } from "@/db/client";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getAuthenticatedUserId(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    const result = await db.execute({
      sql: `
        SELECT id, google_doc_id, title, full_text, google_modified_time, created_at, updated_at
        FROM documents
        WHERE id = ? AND user_id = ?
      `,
      args: [id, userId],
    });

    if (result.rows.length === 0) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    const row = result.rows[0]!;
    const document = {
      id: row.id as string,
      google_doc_id: row.google_doc_id as string,
      title: row.title as string,
      full_text: row.full_text as string,
      google_modified_time: row.google_modified_time as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };

    return NextResponse.json({ document });
  } catch (error) {
    console.error("Get document error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
