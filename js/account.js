/* ============================================================================
 * account.js — passwordless student account (email OTP) + referral dashboard.
 * Talks ONLY to student endpoints (no admin token). Student token lives in
 * localStorage (30-day sessions). All dynamic content via textContent (el()).
 * ==========================================================================*/

import { el, $, CONFIG, isConfigured, apiPost, getStoredRef, renderNotConfigured } from "./ui.js";

const TOKEN_KEY = "archprep_student_token";
const EXP_KEY = "archprep_student_expires";
const root = () => $("#account-root");

function getToken() { return localStorage.getItem(TOKEN_KEY) || ""; }
function setSession(token, expires) { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(EXP_KEY, String(expires)); }
function clearSession() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(EXP_KEY); }
function tokenValid() { return getToken() && Number(localStorage.getItem(EXP_KEY) || 0) > Date.now(); }

/* ---- transport (student token in body; never a query string) ---- */
async function sPost(action, payload = {}) {
  const res = await apiPost(action, { token: getToken(), ...payload }).catch(() => ({ ok: false, error: "network" }));
  if (res && res.error === "session_expired") { clearSession(); renderLogin("Your session ended. Please sign in again."); }
  return res;
}

/* ---- toasts (reuse the shared toast markup) ---- */
function toast(msg, kind = "ok") {
  const wrap = $("#toasts");
  if (!wrap) return;
  const t = el("div", { class: "toast " + (kind === "err" ? "err" : "ok"), text: msg });
  wrap.appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, 3000);
}

/* ---- boot ---- */
document.addEventListener("DOMContentLoaded", () => {
  if (!isConfigured()) { renderNotConfigured(root()); return; }
  if (tokenValid()) loadDashboard();
  else renderLogin();
});

/* ============================================================================
 * Login / signup (one flow)
 * ==========================================================================*/
function renderLogin(notice) {
  const wrap = el("div");
  const card = el("div", { class: "quiz-card" });
  card.appendChild(el("h1", { text: "Your account" }));
  card.appendChild(el("p", { class: "lead", text: "Sign in or create your account — no password needed. We'll email you a one-time code." }));
  if (notice) card.appendChild(el("div", { class: "alert alert--info", text: notice, attrs: { role: "status" } }));

  const alert = el("div");
  card.appendChild(alert);
  const showErr = (m) => alert.replaceChildren(el("div", { class: "alert alert--error", text: m, attrs: { role: "alert" } }));

  // Step 1 — email
  const emailForm = el("form", { attrs: { novalidate: "true" } });
  const emailField = el("div", { class: "field" });
  emailField.appendChild(el("label", { text: "Email", attrs: { for: "acc-email" } }));
  const emailInput = el("input", { attrs: { type: "email", id: "acc-email", placeholder: "you@example.com", autocomplete: "email", inputmode: "email" } });
  emailField.appendChild(emailInput);
  emailForm.appendChild(emailField);
  const ref = getStoredRef();
  if (ref) emailForm.appendChild(el("p", { class: "hint", text: "You were referred by a friend (code " + ref + ") — sign up to credit them." }));
  const sendBtn = el("button", { class: "btn btn--primary btn--lg btn--block", text: "Send me a code", attrs: { type: "submit" } });
  emailForm.appendChild(sendBtn);

  emailForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = emailInput.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return showErr("Please enter a valid email address.");
    sendBtn.disabled = true; sendBtn.textContent = "Sending…";
    const res = await apiPost("studentRequestCode", { email }).catch(() => ({ ok: false }));
    sendBtn.disabled = false; sendBtn.textContent = "Send me a code";
    if (res && res.ok) renderCodeStep(email);
    else showErr((res && res.error) || "Couldn't send a code. Please try again.");
  });

  card.appendChild(emailForm);
  wrap.appendChild(card);
  root().replaceChildren(wrap);
  emailInput.focus();
}

function renderCodeStep(email) {
  const wrap = el("div");
  const card = el("div", { class: "quiz-card" });
  card.appendChild(el("h1", { text: "Enter your code" }));
  card.appendChild(el("p", { class: "lead", children: [document.createTextNode("We emailed a 6-digit code to "), el("strong", { text: email }), document.createTextNode(". It expires in 10 minutes.")] }));
  const alert = el("div");
  card.appendChild(alert);
  const showErr = (m) => alert.replaceChildren(el("div", { class: "alert alert--error", text: m, attrs: { role: "alert" } }));

  const form = el("form", { attrs: { novalidate: "true" } });
  const field = el("div", { class: "field" });
  field.appendChild(el("label", { text: "6-digit code", attrs: { for: "acc-code" } }));
  const codeInput = el("input", { attrs: { type: "text", id: "acc-code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", placeholder: "123456" } });
  field.appendChild(codeInput);
  form.appendChild(field);
  const verifyBtn = el("button", { class: "btn btn--primary btn--lg btn--block", text: "Verify & sign in", attrs: { type: "submit" } });
  form.appendChild(verifyBtn);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = codeInput.value.trim();
    if (!/^\d{6}$/.test(code)) return showErr("Enter the 6-digit code from your email.");
    verifyBtn.disabled = true; verifyBtn.textContent = "Verifying…";
    const res = await apiPost("studentVerifyCode", { email, code, ref: getStoredRef() }).catch(() => ({ ok: false }));
    verifyBtn.disabled = false; verifyBtn.textContent = "Verify & sign in";
    if (res && res.ok) { setSession(res.token, res.expires); localStorage.removeItem("archprep_ref"); loadDashboard(res.profile); }
    else showErr((res && res.error) || "That code didn't work. Please try again.");
  });

  const resend = el("button", { class: "btn btn--ghost btn--block", text: "← Use a different email", attrs: { type: "button" } });
  resend.addEventListener("click", () => renderLogin());

  card.appendChild(form);
  card.appendChild(resend);
  wrap.appendChild(card);
  root().replaceChildren(wrap);
  codeInput.focus();
}

/* ============================================================================
 * Dashboard
 * ==========================================================================*/
async function loadDashboard(profile) {
  if (!profile) {
    const res = await sPost("getStudentProfile", {});
    if (!res || !res.ok) return; // sPost handles session_expired
    profile = res.profile;
  }
  renderDashboard(profile);
}

function renderDashboard(p) {
  const wrap = el("div");

  // Top bar
  const top = el("div", { class: "quiz-progress", attrs: { style: "margin-bottom:1rem" } });
  top.appendChild(el("h1", { class: "mb-0", text: p.display_name ? `Hi, ${p.display_name}` : "Your account" }));
  const logout = el("button", { class: "btn btn--outline btn--sm", text: "Log out" });
  logout.addEventListener("click", async () => { await apiPost("studentLogout", { token: getToken() }).catch(() => {}); clearSession(); renderLogin("You've been logged out."); });
  top.appendChild(logout);
  wrap.appendChild(top);

  // Referral card
  const refCard = el("div", { class: "quiz-card", attrs: { style: "margin-bottom:1.25rem" } });
  refCard.appendChild(el("p", { class: "eyebrow", text: "Refer a friend, earn ₱" + (CONFIG.REFERRAL_AMOUNT || 9) }));
  refCard.appendChild(el("h2", { text: "Your referral link" }));
  refCard.appendChild(el("p", { class: "desc", text: "Share this link. When a friend buys and we confirm the payment, you earn a reward." }));

  const linkRow = el("div", { class: "field" });
  const linkInput = el("input", { attrs: { type: "text", readonly: "true", value: p.referral_link || (location.origin + "/?ref=" + p.ref_code) } });
  linkRow.appendChild(linkInput);
  refCard.appendChild(linkRow);

  const btns = el("div", { class: "hero-cta", attrs: { style: "margin-top:0" } });
  const copyBtn = el("button", { class: "btn btn--primary", text: "Copy link" });
  copyBtn.addEventListener("click", () => { linkInput.select(); if (navigator.clipboard) navigator.clipboard.writeText(linkInput.value); toast("Link copied!"); });
  const shareBtn = el("a", { class: "btn btn--outline", text: "Share by email",
    attrs: { href: "mailto:?subject=" + encodeURIComponent("Study for the ALE with ArchPrep PH") +
      "&body=" + encodeURIComponent("I'm using ArchPrep PH for ALE review. Sign up with my link: " + (p.referral_link || (location.origin + "/?ref=" + p.ref_code))) } });
  btns.appendChild(copyBtn); btns.appendChild(shareBtn);
  refCard.appendChild(btns);
  refCard.appendChild(el("p", { class: "muted", attrs: { style: "margin-top:1rem;margin-bottom:0" }, text: "Your code: " + p.ref_code }));
  wrap.appendChild(refCard);

  // Earnings (full data arrives in a later stage; show a friendly placeholder)
  const earn = el("div", { class: "quiz-card", attrs: { style: "margin-bottom:1.25rem" } });
  earn.appendChild(el("h2", { text: "Your rewards" }));
  earn.appendChild(el("div", { class: "alert alert--info mb-0", attrs: { id: "earn-box" },
    text: "Your referrals and earnings will appear here." }));
  wrap.appendChild(earn);
  loadEarnings();

  // Profile
  const prof = el("div", { class: "quiz-card" });
  prof.appendChild(el("h2", { text: "Profile" }));
  const form = el("form");
  const nameField = el("div", { class: "field" });
  nameField.appendChild(el("label", { text: "Display name (optional)", attrs: { for: "p-name" } }));
  const nameInput = el("input", { attrs: { type: "text", id: "p-name", value: p.display_name || "", placeholder: "Your name" } });
  nameField.appendChild(nameInput);
  form.appendChild(nameField);
  const gcField = el("div", { class: "field" });
  gcField.appendChild(el("label", { text: "GCash number (for cash payouts)", attrs: { for: "p-gc" } }));
  const gcInput = el("input", { attrs: { type: "text", id: "p-gc", value: p.gcash_number || "", placeholder: "09xx xxx xxxx", inputmode: "tel" } });
  gcField.appendChild(gcInput);
  form.appendChild(gcField);
  const saveBtn = el("button", { class: "btn btn--secondary", text: "Save profile", attrs: { type: "submit" } });
  form.appendChild(saveBtn);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    saveBtn.disabled = true; saveBtn.textContent = "Saving…";
    const res = await sPost("updateStudentProfile", { display_name: nameInput.value.trim(), gcash_number: gcInput.value.trim() });
    saveBtn.disabled = false; saveBtn.textContent = "Save profile";
    if (res && res.ok) toast("Profile saved.");
    else toast((res && res.error) || "Couldn't save.", "err");
  });
  prof.appendChild(form);
  wrap.appendChild(prof);

  root().replaceChildren(wrap);
}

/* Earnings summary — gracefully handles the not-yet-implemented stage. */
async function loadEarnings() {
  const res = await sPost("getMyReferralInfo", {});
  const box = document.getElementById("earn-box");
  if (!box) return;
  if (res && res.ok) {
    const e = res.earnings || {};
    box.classList.remove("alert--info");
    box.replaceChildren(
      el("div", { children: [
        el("strong", { text: `Referred: ${res.counts ? res.counts.referred : 0}` }),
        document.createTextNode("  ·  "),
        el("span", { text: `Available: ₱${e.available || 0}` }),
        document.createTextNode("  ·  "),
        el("span", { text: `Pending: ₱${e.pending || 0}` }),
        document.createTextNode("  ·  "),
        el("span", { text: `Paid: ₱${e.paid || 0}` }),
      ]})
    );
  } else if (res && res.error === "not_implemented_yet") {
    box.textContent = "Your referrals and earnings will appear here once the rewards dashboard is switched on.";
  }
}
