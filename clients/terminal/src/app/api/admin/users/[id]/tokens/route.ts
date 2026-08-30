/** A user's API tokens — list and mint. The bearer token IS the credential in this deployment
 *  (there is no password), so revoking and re-minting here is the "change their credential"
 *  operation an operator has. Revocation is DELETE /api/admin/tokens/<tokenId>. */
import { NextRequest } from "next/server";
import { adminProxy } from "../../proxy";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return adminProxy(`/admin/users/${encodeURIComponent(id)}/tokens`);
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await request.text();
  return adminProxy(`/admin/users/${encodeURIComponent(id)}/tokens`, { method: "POST", body });
}
