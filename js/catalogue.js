/* ============================================================================
 * catalogue.js — renders Materials and Quizzes catalogues from the API.
 * Data is untrusted Sheet content: always rendered via textContent (el()).
 * ==========================================================================*/

import {
  el, peso, apiGet, isConfigured,
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
  return el("a", {
    class: "btn btn--primary btn--block",
    text: "Buy on GCash / QR Ph",
    attrs: { href: link, target: "_blank", rel: "noopener noreferrer" },
  });
}

function num(v) { const n = Number(v); return isFinite(n) ? n : 9999; }
