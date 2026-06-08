"use server";

import { redirect } from "next/navigation";
import { getSessionClient } from "@/lib/supabase/auth-server";

/**
 * Sign the current user out (clears the session cookies) and return to the
 * login screen. Server action — invoked from a `<form action={logout}>` so it
 * works without client JS.
 */
export async function logout() {
  const supabase = await getSessionClient();
  await supabase?.auth.signOut();
  redirect("/");
}
