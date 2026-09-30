/* ============================================================================
 * config.js — PUBLIC front-end configuration for ArchPrep PH (Platform v2)
 * ----------------------------------------------------------------------------
 * This file is served to every visitor. It holds the Supabase project URL and
 * the Supabase anon key and nothing else (Requirement 28.2).
 *
 * The anon key is a public identifier, not a secret: it carries no privilege
 * of its own. Every read it permits is bounded by Row-Level Security, and
 * every privileged action goes through an Edge Function. The service-role key,
 * the HitPay API key, the webhook salt, and the SMTP credentials live only in
 * Edge Function environment variables (see .env.example).
 *
 * DO NOT add any other key here. Brand name, contact email, banner, hero copy,
 * and the referral amount, reward type, payout threshold, and reward scope are
 * all read at runtime from the `settings` table (display-safe keys only), so
 * they are edited in the admin portal rather than in this file.
 *
 * HOW TO FILL IN (see SETUP.md):
 *   Supabase Dashboard → Project Settings → API
 *     Project URL  → SUPABASE_URL
 *     anon public  → SUPABASE_ANON_KEY
 * ==========================================================================*/

window.APP_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-SUPABASE-ANON-KEY",
};

/* ----------------------------------------------------------------------------
 * v1 rollback reference (Requirement 35.9)
 * ----------------------------------------------------------------------------
 * The retired Apps Script backend in apps-script/ is kept unmodified. If a
 * rollback to v1 is ever needed, restore the v1 config keys and point
 * APPS_SCRIPT_URL back at the deployed Web App:
 *
 *   https://script.google.com/macros/s/AKfycbxOVju3J8GwKSRStJ4H9HdbYprPZMNNLEQ02LTxs6PV-875s4UOA3Rcu2N6D2pcicpl/exec
 *
 * This is a deployment URL, not a credential; the Web App enforces its own
 * admin token check. It is recorded here only so the rollback path survives.
 * ------------------------------------------------------------------------- */
