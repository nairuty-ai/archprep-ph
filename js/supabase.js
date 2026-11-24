/* js/supabase.js — the one Supabase client for the whole front end.
 *
 * Requirement 28.2: the browser bundle carries only the project URL and the
 * anon key. No secrets here.
 *
 * Usage:
 *   import { supabase } from './supabase.js';
 *   const { data, error } = await supabase.auth.getSession();
 */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

if (!window.APP_CONFIG?.SUPABASE_URL || !window.APP_CONFIG?.SUPABASE_ANON_KEY) {
  console.error('[supabase.js] APP_CONFIG is missing. Make sure config.js is loaded before this module.');
}

// BACKEND_RULES.md §3: never remember the user. The session lives in
// sessionStorage, so it survives moving between pages in one tab and is gone
// when the browser (or tab) closes; every new visit needs a new email code.
export const supabase = createClient(
  window.APP_CONFIG.SUPABASE_URL,
  window.APP_CONFIG.SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession:       true,
      storage:              window.sessionStorage,
      autoRefreshToken:     true,
      // Login links from the email land on login.html with the session in
      // the URL fragment. Implicit flow, because the link usually opens in a
      // new tab, which has its own sessionStorage (PKCE would lose its verifier).
      detectSessionInUrl:   true,
      flowType:             'implicit',
      storageKey:           'arkiprep-session',
    },
  },
);

/** The current session, or null. Does NOT block. */
export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data?.session ?? null;
}

/** The current user, or null. Does NOT block. */
export async function getUser() {
  const session = await getSession();
  return session?.user ?? null;
}

/** The access token for Edge Function calls, or null. */
export async function getAccessToken() {
  const session = await getSession();
  return session?.access_token ?? null;
}
