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

  // My Library (code-free access to purchased quizzes/materials) — shown first
  const libCard = el("div", { class: "quiz-card", attrs: { style: "margin-bottom:1.25rem" } });
  libCard.appendChild(el("h2", { text: "My library" }));
  libCard.appendChild(el("div", { attrs: { id: "library-box" }, class: "state", children: [
    el("div", { class: "spinner", attrs: { "aria-hidden": "true" } }),
    el("p", { class: "mb-0", text: "Loading your purchases…" }),
  ]}));
  wrap.insertBefore(libCard, refCard);

  // Rewards (referral earnings + payout / credit)
  const earn = el("div", { class: "quiz-card", attrs: { style: "margin-bottom:1.25rem" } });
  earn.appendChild(el("h2", { text: "Your rewards" }));
  earn.appendChild(el("div", { attrs: { id: "rewards-box" }, class: "state", children: [
    el("div", { class: "spinner", attrs: { "aria-hidden": "true" } }),
    el("p", { class: "mb-0", text: "Loading…" }),
  ]}));
  wrap.appendChild(earn);
  loadLibrary();
  loadRewards();

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

/* ---- My Library: purchased quizzes (code-free) + materials ---- */
async function loadLibrary() {
  const res = await sPost("getMyLibrary", {});
  const box = document.getElementById("library-box");
  if (!box) return;
  box.className = "";
  if (!res || !res.ok) { box.replaceChildren(el("p", { class: "muted mb-0", text: "Couldn't load your library." })); return; }
  const quizzes = (res.library && res.library.quizzes) || [];
  const materials = (res.library && res.library.materials) || [];
  box.replaceChildren();

  if (!quizzes.length && !materials.length) {
    box.appendChild(el("div", { class: "alert alert--info mb-0", children: [
      document.createTextNode("You haven't purchased anything yet. "),
      el("a", { text: "Browse quizzes →", attrs: { href: "quizzes.html" } }),
    ]}));
    return;
  }

  if (quizzes.length) {
    box.appendChild(el("p", { class: "eyebrow", text: "Quizzes" }));
    const list = el("div", { class: "row-list" });
    quizzes.forEach((qz) => {
      const left = Number(qz.attempts_left);
      const main = el("div", { class: "row-main", children: [
        el("h4", { text: qz.quiz_title }),
        el("div", { class: "row-meta", text: `${qz.subject || ""} · ${left} of 2 attempts left` }),
      ]});
      const actions = el("div", { class: "row-actions" });
      if (left > 0) {
        actions.appendChild(el("a", { class: "btn btn--primary btn--sm", text: "Start quiz",
          attrs: { href: "quiz.html?mine=" + encodeURIComponent(qz.quiz_id) } }));
      } else {
        actions.appendChild(el("span", { class: "badge draft", text: "No attempts left" }));
      }
      list.appendChild(el("div", { class: "row-item", children: [main, actions] }));
    });
    box.appendChild(list);
  }
  if (materials.length) {
    box.appendChild(el("p", { class: "eyebrow", attrs: { style: "margin-top:1rem" }, text: "Materials" }));
    const ml = el("div", { class: "row-list" });
    materials.forEach((mm) => ml.appendChild(el("div", { class: "row-item", children: [
      el("div", { class: "row-main", children: [
        el("h4", { text: mm.title }),
        el("div", { class: "row-meta", text: "Delivered to your email by our team." }),
      ]}),
    ]})));
    box.appendChild(ml);
  }
}

/* ---- Rewards: earnings, progress to payout, request payout / credit note ---- */
function stat(value, label) {
  return el("div", { class: "reward-stat", children: [
    el("div", { class: "reward-num", text: String(value) }),
    el("div", { class: "reward-label", text: label }),
  ]});
}

async function loadRewards() {
  const res = await sPost("getMyReferralInfo", {});
  const box = document.getElementById("rewards-box");
  if (!box) return;
  box.className = "";
  if (!res || !res.ok) { box.replaceChildren(el("p", { class: "muted mb-0", text: "Couldn't load rewards." })); return; }
  const e = res.earnings || {}, c = res.counts || {}, cfg = res.config || {};
  const threshold = Number(cfg.payout_threshold) || 100;
  const isCash = (cfg.reward_type || "cash") === "cash";
  box.replaceChildren();

  box.appendChild(el("div", { class: "reward-stats", children: [
    stat(c.referred || 0, "Friends referred"),
    stat("₱" + (e.available || 0), isCash ? "Available" : "Credit"),
    stat("₱" + (e.paid || 0), isCash ? "Paid out" : "Redeemed"),
  ]}));

  if (isCash) {
    const pct = Math.min(100, Math.round(((e.available || 0) / threshold) * 100));
    box.appendChild(el("p", { class: "muted", attrs: { style: "margin:.75rem 0 .25rem" },
      text: `₱${e.available || 0} of ₱${threshold} needed to cash out` }));
    const bar = el("div", { class: "progress-bar" }); bar.appendChild(el("span", { attrs: { style: "width:" + pct + "%" } }));
    box.appendChild(bar);
    const payBtn = el("button", { class: "btn btn--primary", attrs: { style: "margin-top:1rem" }, text: "Request payout" });
    payBtn.disabled = (e.available || 0) < threshold;
    if (payBtn.disabled) payBtn.title = "Reach ₱" + threshold + " to cash out";
    payBtn.addEventListener("click", async () => {
      const gcEl = document.getElementById("p-gc");
      const gc = gcEl ? gcEl.value.trim() : "";
      if (!gc) return toast("Add your GCash number in Profile below and Save first.", "err");
      payBtn.disabled = true; payBtn.textContent = "Requesting…";
      const r = await sPost("requestPayout", { gcash_number: gc });
      if (r && r.ok) { toast("Payout requested! We'll send ₱" + r.requested + " to your GCash and mark it here."); loadRewards(); }
      else { payBtn.disabled = false; payBtn.textContent = "Request payout"; toast((r && r.error === "below_threshold") ? "You're below the payout threshold." : "Couldn't request payout.", "err"); }
    });
    box.appendChild(payBtn);
  } else {
    box.appendChild(el("p", { class: "muted mb-0", attrs: { style: "margin-top:.75rem" },
      text: "Your credit is applied to your next order by our team. Keep sharing to earn more!" }));
  }
}
