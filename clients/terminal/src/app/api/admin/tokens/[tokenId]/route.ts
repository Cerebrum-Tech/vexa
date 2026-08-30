/** Revoke one API token. With no password in this deployment the bearer token IS the credential,
 *  so revoke-and-re-mint is the operator's "reset their access" action. */
import { NextRequest } from "next/server";
import { adminProxy } from "../../users/proxy";

export const dynamic = "force-dynamic";

export async function DELETE(_request: NextRequest, ctx: { params: Promise<{ tokenId: string }> }) {
  const { tokenId } = await ctx.params;
  return adminProxy(`/admin/tokens/${encodeURIComponent(tokenId)}`, { method: "DELETE" });
}
