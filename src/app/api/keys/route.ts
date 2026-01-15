import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helper";
import { generateApiKey, listApiKeys } from "@/lib/api-keys";

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { name } = body as { name?: string };

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const result = await generateApiKey(user.id, name.trim());

    return NextResponse.json({
      id: result.id,
      key: result.key, // Only returned once!
      prefix: result.prefix,
      name: name.trim(),
      createdAt: result.createdAt,
    });
  } catch (error) {
    console.error("Create API key error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const keys = await listApiKeys(user.id);

    return NextResponse.json({ keys });
  } catch (error) {
    console.error("List API keys error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
