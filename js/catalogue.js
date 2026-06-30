/* ============================================================================
 * catalogue.js — renders Materials and Quizzes catalogues from the API.
 * Data is untrusted Sheet content: always rendered via textContent (el()).
 * ==========================================================================*/

import {
  el, peso, apiGet, apiPost, isConfigured,
  renderLoading, renderError, renderEmpty, renderNotConfigured,
} from "./ui.js";

/* ---------------- Materials ---------------- */

export async function initMaterials(container) {
  if (!isConfigured()) return renderNotConfigured(container);

  const load = async () => {
    renderLoading(container, "Loading study materials…");
    try {
      const products = await apiGet("getProducts");
      const materials = (Array.isArray(products) ? products : []).filter((p) => p.type === "material");
      if (materials.length === 0) {
        return renderEmpty(container, "Materials coming soon",
          "No materials are listed yet. Please check back shortly.");
      }
      renderMaterialGroups(container, materials);
    } catch (err) {
      renderError(container, err.message || "Could not load materials.", load);
    }
  };
  load();
}

function renderMaterialGroups(container, materials) {
  materials.sort((a, b) => num(a.sort_order) - num(b.sort_order));

  // Group by subject; put "All Subjects" bundle(s) last.
  const groups = new Map();
  for (const p of materials) {
    const key = p.subject || "Other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const orderedKeys = [...groups.keys()].sort((a, b) => {
    const aBundle = /all subjects/i.test(a) ? 1 : 0;
    const bBundle = /all subjects/i.test(b) ? 1 : 0;
    if (aBundle !== bBundle) return aBundle - bBundle;
    return a.localeCompare(b);
  });

  const frag = document.createDocumentFragment();
  for (const key of orderedKeys) {
    const section = el("section", { class: "subject-group" });
    section.appendChild(el("h2", { text: key }));
    const grid = el("div", { class: "grid grid--3" });
    for (const p of groups.get(key)) grid.appendChild(materialCard(p));
    section.appendChild(grid);
    frag.appendChild(section);
  }
  container.replaceChildren(frag);
}

function materialCard(p) {
  const foot = el("div", { class: "card-foot" });
  foot.appendChild(buyButton(p));

  return el("article", { class: "card", children: [
    el("span", { class: "subject-tag", text: p.subject || "Material" }),
    el("h3", { text: p.title || "Untitled material" }),
    el("p", { class: "desc", text: p.description || "" }),
    el("div", { class: "price", children: [
      document.createTextNode(peso(p.price_php)),
      el("small", { text: " PHP" }),
    ]}),
    foot,
  ]});
}

/* ---------------- Quizzes ---------------- */

export async function initQuizzes(container) {
  if (!isConfigured()) return renderNotConfigured(container);

  const load = async () => {
    renderLoading(container, "Loading quiz packs…");
    try {
      const [products, quizList] = await Promise.all([
        apiGet("getProducts"),
        apiGet("getQuizList").catch(() => []),
      ]);
      const quizProducts = (Array.isArray(products) ? products : []).filter((p) => p.type === "quiz");

      if (quizProducts.length === 0) {
        return renderEmpty(container, "Quizzes coming soon",
          "No quiz packs are listed yet. Please check back shortly.");
      }
      renderQuizProducts(container, quizProducts, Array.isArray(quizList) ? quizList : []);
    } catch (err) {
      renderError(container, err.message || "Could not load quizzes.", load);
    }
  };
  load();
}

function renderQuizProducts(container, quizProducts, quizList) {
  quizProducts.sort((a, b) => num(a.sort_order) - num(b.sort_order));

  const grid = el("div", { class: "grid grid--3" });
  for (const p of quizProducts) grid.appendChild(quizCard(p, quizList));

  container.replaceChildren(grid);
}

function quizCard(p, quizList) {
  // Best-effort "what's included": count quizzes whose subject matches, else generic.
  let included = "";
  const matches = quizList.filter((q) => q.subject && p.subject && q.subject === p.subject);
  if (/all subjects/i.test(p.subject || "")) {
    included = quizList.length ? `${quizList.length} quizzes included` : "All quiz packs";
  } else if (matches.length) {
    included = `${matches.length} quiz${matches.length === 1 ? "" : "zes"} included`;
  }

  const children = [
    el("span", { class: "subject-tag", text: p.subject || "Quiz" }),
    el("h3", { text: p.title || "Untitled quiz pack" }),
    el("p", { class: "desc", text: p.description || "" }),
  ];
  if (included) children.push(el("p", { class: "included", text: included }));
  children.push(
    el("div", { class: "price", children: [
      document.createTextNode(peso(p.price_php)),
      el("small", { text: " PHP" }),
    ]})
  );

  const foot = el("div", { class: "card-foot" });
  foot.appendChild(buyButton(p));
  children.push(foot);

  return el("article", { class: "card", children });
}

/* ---------------- Shared ---------------- */

function buyButton(p) {
  const link = (p.hitpay_link || "").trim();
  const valid = /^https?:\/\//i.test(link) && !/REPLACE_ME/i.test(link);
  if (!valid) {
    return el("button", {
      class: "btn btn--outline btn--block",
      text: "Coming soon",
      attrs: { disabled: "true", "aria-disabled": "true",
        title: "Payment link not set yet" },
    });
  }
  const btn = el("button", {
    class: "btn btn--primary btn--block",
    text: "Buy on GCash / QR Ph",
    attrs: { type: "button" },
  });
  btn.addEventListener("click", () => openCheckout(p, link));
  return btn;
}

/* ---------------- Checkout: capture email, then open HitPay ---------------- */

function openCheckout(p, link) {
  const isQuiz = p.type === "quiz";
  const backdrop = el("div", { class: "modal-backdrop" });
  const modal = el("div", { class: "modal" });

  modal.appendChild(el("h3", { text: p.title || "Complete your purchase" }));
  modal.appendChild(el("p", { class: "muted", text:
    isQuiz
      ? "Enter your email to continue. After you pay, we'll email your quiz access code (good for 2 attempts)."
      : "Enter your email to continue. After you pay, we'll email your material to this address." }));

  const alert = el("div");
  modal.appendChild(alert);

  const field = el("div", { class: "field" });
  field.appendChild(el("label", { text: "Your email", attrs: { for: "co-email" } }));
  const input = el("input", { attrs: { type: "email", id: "co-email", placeholder: "you@example.com", autocomplete: "email", inputmode: "email" } });
  field.appendChild(input);
  modal.appendChild(field);

  const actions = el("div", { class: "modal-actions" });
  const cancel = el("button", { class: "btn btn--outline", text: "Cancel", attrs: { type: "button" } });
  const go = el("button", { class: "btn btn--primary", text: "Continue to payment", attrs: { type: "button" } });
  cancel.addEventListener("click", () => backdrop.remove());
  actions.appendChild(cancel);
  actions.appendChild(go);
  modal.appendChild(actions);

  const showErr = (msg) => { alert.replaceChildren(el("div", { class: "alert alert--error", text: msg, attrs: { role: "alert" } })); };

  go.addEventListener("click", async () => {
    const email = input.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return showErr("Please enter a valid email address.");
    go.disabled = true; go.textContent = "Processing…";
    let res;
    try { res = await apiPost("requestAccess", { email, product_id: p.product_id }); }
    catch (e) { res = { ok: false }; }
    if (res && res.ok) {
      // Open HitPay payment page, then show a clear confirmation.
      window.open(link, "_blank", "noopener");
      modal.replaceChildren(
        el("h3", { text: "Almost there!" }),
        el("p", { text: "We've opened the secure GCash / QR Ph payment page in a new tab. Complete your payment there." }),
        el("div", { class: "alert alert--info", attrs: { role: "status" }, text:
          isQuiz
            ? "Once we confirm your payment, we'll email your access code to " + email + ". It works for 2 attempts."
            : "Once we confirm your payment, we'll email your material to " + email + "." }),
        el("div", { class: "modal-actions", children: [
          el("a", { class: "btn btn--outline", text: "View details", attrs: { href: "thank-you.html" } }),
          (function () { const b = el("button", { class: "btn btn--primary", text: "Done", attrs: { type: "button" } }); b.addEventListener("click", () => backdrop.remove()); return b; })(),
        ]})
      );
    } else {
      go.disabled = false; go.textContent = "Continue to payment";
      showErr((res && res.error) || "We couldn't start your checkout. Please try again, or contact us.");
    }
  });

  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  input.focus();
}

function num(v) { const n = Number(v); return isFinite(n) ? n : 9999; }
