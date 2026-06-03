import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Next 16 renamed the `middleware` file convention to `proxy`. Clerk supports this location
// on Next 16+. The proxy only attaches Clerk's context; auth is ENFORCED inside withRoute,
// so enforcement lives in one place and is unit-testable.
const isPublic = createRouteMatcher(["/api/health(.*)"]);

export default clerkMiddleware(async (_auth, req) => {
  if (!isPublic(req)) {
    // Routes still re-check via getOwnerContext; this matcher is just defense in depth.
  }
});

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};
