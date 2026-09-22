import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

// Edge-safe by design: does not import lib/auth.ts (DrizzleAdapter + db),
// which is Node-runtime code — see docs/CODE_REFERENCE_FOR_CLAUDE.md. Just
// forwards the pathname so the root layout (Node runtime) can run the real
// auth + self-onboarding check.
//
// The /admin and /owner role gate below uses next-auth/jwt's getToken
// instead of auth() from lib/auth.ts for the same reason: getToken only
// verifies the JWT session cookie (no adapter, no DB), so it stays
// Edge-safe. Role changes only take effect on the affected user's next
// sign-in (role lives in the JWT) — app/admin/layout.tsx re-checks the role
// against the DB via a full auth() call as defense-in-depth.
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith("/owner") || pathname.startsWith("/admin")) {
    const token = await getToken({ req, secret: process.env.AUTH_SECRET });
    const role = token?.role;

    if (pathname.startsWith("/owner") && role !== "owner") {
      return NextResponse.redirect(new URL("/", req.url));
    }
    if (pathname.startsWith("/admin") && role !== "admin" && role !== "owner") {
      return NextResponse.redirect(new URL("/", req.url));
    }
  }

  const headers = new Headers(req.headers);
  headers.set("x-pathname", pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
