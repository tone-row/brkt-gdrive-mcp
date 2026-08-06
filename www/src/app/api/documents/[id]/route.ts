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
        SELECT d.id, d.google_doc_id, d.title, d.full_text, d.google_modified_time, d.created_at, d.updated_at
        FROM documents_v2 d
        JOIN user_document_access uda ON uda.document_id = d.id
        WHERE d.id = ? AND uda.user_id = ?
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
