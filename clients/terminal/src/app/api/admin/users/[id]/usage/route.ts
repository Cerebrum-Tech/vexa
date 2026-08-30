/** Per-user service usage over a window — meetings, minutes, transcription volume, recorded
 *  reports and quota. Every field is measured by admin-api from the durable tables. */
import { NextRequest } from "next/server";
import { adminProxy } from "../../proxy";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const days = request.nextUrl.searchParams.get("window_days") || "30";
  return adminProxy(`/admin/users/${encodeURIComponent(id)}/usage?window_days=${encodeURIComponent(days)}`);
}
