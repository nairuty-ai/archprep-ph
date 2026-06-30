/* ============================================================================
 * hero3d.js — real-time WebGL hero background (an abstract wireframe
 * "architectural skyline" that gently rotates and reacts to the mouse).
 *
 * Progressive enhancement only:
 *   - Three.js is lazy-loaded from a free CDN (no build, no cost).
 *   - Runs ONLY on capable desktops: skipped on reduced-motion, Save-Data,
 *     small screens, or when WebGL/dynamic import is unavailable.
 *   - If anything fails, the static hero image stays — nothing breaks.
 *   - rAF pauses when the tab is hidden or the hero scrolls off-screen.
 * ==========================================================================*/

const THREE_URL = "https://unpkg.com/three@0.160.0/build/three.module.js";

document.addEventListener("DOMContentLoaded", () => {
  const canvas = document.getElementById("hero-canvas");
  if (!canvas) return;
  if (!shouldRun()) return;
  start(canvas).catch(() => { /* keep the static image fallback */ });
});

function shouldRun() {
  const mq = window.matchMedia;
  if (mq && mq("(prefers-reduced-motion: reduce)").matches) return false;
  if (window.innerWidth < 900) return false;             // desktop-only
  const conn = navigator.connection;
  if (conn && (conn.saveData || /2g/.test(conn.effectiveType || ""))) return false;
  try {
    const c = document.createElement("canvas");
    if (!(c.getContext("webgl") || c.getContext("experimental-webgl"))) return false;
  } catch (e) { return false; }
  return true;
}

async function start(canvas) {
  const THREE = await import(/* @vite-ignore */ THREE_URL);

  const wrap = canvas.parentElement; // .hero-media
  const W = () => wrap.clientWidth;
  const H = () => wrap.clientHeight;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(W(), H(), false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, W() / H(), 0.1, 100);
  camera.position.set(0, 5.2, 12);
  camera.lookAt(0, 0.5, 0);

  // Brand palette
  const ACCENT = 0xC2703D, SLATE = 0x2E5266, INK = 0x1B2430;

  // --- Build a wireframe "skyline": a grid of extruded towers ---
  const group = new THREE.Group();
  const GRID = 7, GAP = 1.25;
  const offset = ((GRID - 1) * GAP) / 2;
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const dist = Math.hypot(i - (GRID - 1) / 2, j - (GRID - 1) / 2);
      const h = Math.max(0.6, 4.2 - dist * 0.7 + Math.random() * 1.4);
      const geo = new THREE.BoxGeometry(0.7, h, 0.7);
      const edges = new THREE.EdgesGeometry(geo);
      const color = (i + j) % 3 === 0 ? ACCENT : SLATE;
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 });
      const tower = new THREE.LineSegments(edges, mat);
      tower.position.set(i * GAP - offset, h / 2 - 1.5, j * GAP - offset);
      tower.userData.baseY = tower.position.y;
      tower.userData.phase = Math.random() * Math.PI * 2;
      group.add(tower);
      geo.dispose();
    }
  }
  // A faint ground grid for depth
  const grid = new THREE.GridHelper(GRID * GAP + 2, GRID + 2, INK, INK);
  grid.material.transparent = true; grid.material.opacity = 0.12;
  grid.position.y = -1.5;
  group.add(grid);

  group.rotation.x = 0.0;
  scene.add(group);

  // Mouse parallax
  let targetRX = 0, targetRY = 0;
  wrap.addEventListener("pointermove", (e) => {
    const r = wrap.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    targetRY = px * 0.5;
    targetRX = py * 0.3;
  });
  wrap.addEventListener("pointerleave", () => { targetRX = 0; targetRY = 0; });

  // Resize
  const onResize = () => {
    renderer.setSize(W(), H(), false);
    camera.aspect = W() / H();
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", onResize);

  // Pause when off-screen or tab hidden
  let visible = true, running = true;
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((ents) => { visible = ents[0].isIntersecting; })
      .observe(wrap);
  }
  document.addEventListener("visibilitychange", () => { running = !document.hidden; });

  // Reveal the canvas over the photo
  canvas.classList.add("on");
  wrap.classList.add("has3d");

  const clock = new THREE.Clock();
  let auto = 0;
  let scrollF = 0;
  window.addEventListener("scroll", () => {
    // 0 at top → 1 after one viewport; drives a gentle camera dolly/orbit.
    scrollF = Math.min(1, Math.max(0, window.scrollY / (window.innerHeight || 800)));
  }, { passive: true });

  function loop() {
    requestAnimationFrame(loop);
    if (!running || !visible) return;
    const t = clock.getElapsedTime();
    auto += 0.0016;
    // ease group rotation toward target + slow auto-spin
    group.rotation.y += ((targetRY + auto) - group.rotation.y) * 0.05;
    group.rotation.x += (targetRX + 0.12 - group.rotation.x) * 0.05;
    // scroll-driven cinematic camera: dolly in + rise as you scroll
    const camZ = 12 - scrollF * 3.5;
    const camY = 5.2 + scrollF * 2.4;
    camera.position.z += (camZ - camera.position.z) * 0.06;
    camera.position.y += (camY - camera.position.y) * 0.06;
    camera.lookAt(0, 0.5, 0);
    // gentle float per tower
    group.children.forEach((c) => {
      if (c.userData.baseY != null) c.position.y = c.userData.baseY + Math.sin(t + c.userData.phase) * 0.08;
    });
    renderer.render(scene, camera);
  }
  loop();
}
