/** Kullanıcılar panel — list + create. Proxied to admin-api's admin tier; non-admins get 404. */
import { NextRequest } from "next/server";
import { adminProxy } from "./proxy";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const p = request.nextUrl.searchParams;
  const qs = new URLSearchParams();
  qs.set("limit", p.get("limit") || "50");
  qs.set("offset", p.get("offset") || "0");
  const q = p.get("q");
  if (q) qs.set("q", q);
  return adminProxy(`/admin/users?${qs.toString()}`);
}

export async function POST(request: NextRequest) {
  const body = await request.text();
  return adminProxy("/admin/users", { method: "POST", body });
}
