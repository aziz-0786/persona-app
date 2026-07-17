import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Edge-safe by design: does not import lib/auth.ts (DrizzleAdapter + db),
// which is Node-runtime code. Just forwards the pathname so the root layout
// (Node runtime) can run the real auth + self-onboarding check.
export function middleware(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set("x-pathname", req.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
