/* ============================================================================
 * config.js — SINGLE front-end configuration file for ArchPrep PH
 * ----------------------------------------------------------------------------
 * This is the ONLY file you need to edit after deploying the backend.
 * Everything that must be configured post-deployment lives here.
 *
 * HOW TO USE (see SETUP.md for the full walkthrough):
 *   1. Deploy the Apps Script Web App (apps-script/Code.gs) under the Google
 *      account rehinaneel@gmail.com. It gives you a Web App URL ending in
 *      ".../exec".
 *   2. Paste that URL into APPS_SCRIPT_URL below (keep the quotes).
 *   3. (Optional) Change BRAND_NAME and CONTACT_EMAIL_FALLBACK.
 *   4. Re-deploy the static site (see DEPLOYMENT.md).
 *
 * NOTE: The site also reads live copy (brand name, contact email, banner,
 * hero text) from the Settings tab of the Google Sheet via getSettings.
 * The values here are only FALLBACKS used before/if the API is unreachable.
 * ==========================================================================*/

window.APP_CONFIG = {
  // ---- REQUIRED: paste your deployed Apps Script Web App URL here ----------
  // Example: "https://script.google.com/macros/s/AKfycb.../exec"
  // Leave as "" to run the site in "demo / not yet connected" mode (the
  // catalogue pages will show a friendly "not configured yet" message).
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbyoOUAsQ2kRHhrlnu4Yi9qu-3-3jkR7zFYqS9ujVWUrZj-84szZAsASlKryy8NrPFYevw/exec",

  // ---- Brand + contact fallbacks (Settings tab overrides these) ------------
  BRAND_NAME: "ArchPrep PH",
  CONTACT_EMAIL_FALLBACK: "rehinaneel@gmail.com",

  // ---- Optional default hero copy (Settings tab overrides these) -----------
  HERO_HEADLINE_FALLBACK: "Pass the Architect Licensure Exam with confidence.",
  HERO_SUBHEAD_FALLBACK:
    "Focused review materials and exam-style practice quizzes for Filipino architecture graduates — affordable, mobile-friendly, and built for the PRC ALE.",

  // ---- Mock-test timer (minutes). Used only for quizzes whose id starts with
  // "mock". Set to 0 to disable the timer entirely. ------------------------
  MOCK_TEST_MINUTES: 60,
};
