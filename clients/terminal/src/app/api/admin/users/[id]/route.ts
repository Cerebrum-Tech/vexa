/** One user — quota / profile edit. PATCH only; deletion is deliberately not exposed, because a
 *  user row owns meetings and tokens by foreign key and removing it is not a UI-safe operation. */
import { NextRequest } from "next/server";
import { adminProxy } from "../proxy";

export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await request.text();
  return adminProxy(`/admin/users/${encodeURIComponent(id)}`, { method: "PATCH", body });
}
