import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth-helper";
import { db } from "@/db/client";

export async function GET(request: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await db.execute({
      sql: `
        SELECT d.id, d.google_doc_id, d.title, d.google_modified_time, d.created_at, d.updated_at
        FROM documents_v2 d
        JOIN user_document_access uda ON uda.document_id = d.id
        WHERE uda.user_id = ?
        ORDER BY d.updated_at DESC
      `,
      args: [userId],
    });

    const documents = result.rows.map((row) => ({
      id: row.id as string,
      google_doc_id: row.google_doc_id as string,
      title: row.title as string,
      google_modified_time: row.google_modified_time as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    }));

    return NextResponse.json({ documents });
  } catch (error) {
    console.error("List documents error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
