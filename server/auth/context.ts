import { auth } from "@clerk/nextjs/server";

/**
 * The ONLY file that knows about Clerk. Every route reads identity through this seam, so
 * swapping the auth provider touches one file — and tests mock this single module.
 *
 * @returns the authenticated owner id, or null if unauthenticated.
 */
export async function getOwnerContext(): Promise<string | null> {
  const { userId } = await auth();
  return userId ?? null;
}
