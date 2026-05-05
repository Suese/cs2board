/* ----------------------------------------------------------------------------
 * CS2 Board — strategy whiteboard with WebRTC screen-share overlay.
 *
 * Coordinates: pins and stroke points are stored as 0..1 fractions of the
 * square map area, so they survive window resize and stream to peers without
 * any pixel-math mismatch.
 * -------------------------------------------------------------------------- */

const SVG_NS = "http://www.w3.org/2000/svg";

const els = {
  stage:      document.getElementById("stage"),
  board:      document.getElementById("board"),
  mapImg:     document.getElementById("mapImg"),
  video:      document.getElementById("overlayVideo"),
  surface:    document.getElementById("surface"),
  pins:       document.getElementById("pins"),
  strokes:    document.getElementById("strokes"),
  toolbar:    document.getElementById("topbar"),
  mapSel:     document.getElementById("mapSel"),
  colorSel:   document.getElementById("colorSel"),
  hostBtn:    document.getElementById("hostBtn"),
  shareRow:   document.getElementById("shareRow"),
  shareLink:  document.getElementById("shareLink"),
  copyLinkBtn: document.getElementById("copyLinkBtn"),
  connStatus: document.getElementById("connStatus"),
  hostDialog: document.getElementById("hostDialog"),
  srcVideo:   document.getElementById("srcVideo"),
  cropCanvas: document.getElementById("cropCanvas"),
  cx:         document.getElementById("cx"),
  cy:         document.getElementById("cy"),
  cw:         document.getElementById("cw"),
  ch:         document.getElementById("ch"),
  confirmBroadcast: document.getElementById("confirmBroadcast"),
  cancelBroadcast:  document.getElementById("cancelBroadcast"),
  hostHint:   document.getElementById("hostHint"),
  labels:        document.getElementById("labels"),
  glossary:      document.getElementById("glossary"),
  glossaryList:  document.querySelector("#glossary ul"),
  tooltip:       document.getElementById("labelTooltip"),
  connectorLines: document.getElementById("connectorLines"),
  devBtn:        document.getElementById("devBtn"),
  copyLabelsBtn: document.getElementById("copyLabelsBtn"),
  notice:        document.getElementById("notice"),
  noticeText:    document.getElementById("noticeText"),
  noticeClose:   document.getElementById("noticeClose"),
  noticeBox:     document.getElementById("noticeBox"),
  noticeInput:   document.getElementById("noticeInput"),
  noticeOptions: document.getElementById("noticeOptions"),
  netWindow:     document.getElementById("netWindow"),
};

const state = {
  tool: null,                         // "pin" | "draw" | null
  color: PLAYER_COLORS[0].hex,
  mapKey: Object.keys(MAPS)[0],
  // Unified store for every placeable thing: pins, bomb pin, X-marks,
  // letter tags (R/S/U/P), and footsteps. Each value: {id,type,x,y,t0?,sub?,node,refs?}.
  markers: new Map(),
  strokes: new Map(),                 // id → {id, color, points, node}
  drawing: null,                      // {id, points, node} during a stroke
  cursor: { x: 0, y: 0, frac: { x: 0.5, y: 0.5 }, overSurface: false },
  // Per-map label boxes — initialised from labels.js, mutable in dev mode,
  // dumped back to source via the Copy JSON button.
  labels: JSON.parse(JSON.stringify(typeof LABELS !== "undefined" ? LABELS : {})),
  dev: false,
  glossary: { open: false, holding: false },
  hoverLabel: null,                 // index into state.labels[mapKey]
  boxDrag: null,                    // { x0, y0, preview } during dev-mode box creation
  notice: null,                     // { text, bg, fg, outline } when banner is shown
  net:    { open: true },           // network panel visibility
};

/* --------------------------------------------------------------------------
 * Layout: keep the board a perfect square (radar PNGs are 1:1) centred in
 * the available space, with the toolbar (left) and bottom bar reserved.
 * -------------------------------------------------------------------------- */
function layoutBoard() {
  const w = els.board.clientWidth;
  const h = els.board.clientHeight;
  const size = Math.max(64, Math.min(w, h));
  for (const el of [els.mapImg, els.video, els.surface]) {
    el.style.width  = size + "px";
    el.style.height = size + "px";
    el.style.left   = "0px";
    el.style.top    = "0px";
  }
  els.surface.setAttribute("viewBox", "0 0 1 1");
}
// Watch the board element directly so we re-layout for window resize *and*
// for in-page reflows like the notice accordion pushing the stage down.
new ResizeObserver(() => {
  layoutBoard();
  if (state.glossary.open) renderAllConnectors();
}).observe(els.board);

/* --------------------------------------------------------------------------
 * Dropdown population
 * -------------------------------------------------------------------------- */
for (const [key, m] of Object.entries(MAPS)) {
  const opt = document.createElement("option");
  opt.value = key;
  opt.textContent = m.name;
  els.mapSel.appendChild(opt);
}
for (const c of PLAYER_COLORS) {
  const opt = document.createElement("option");
  opt.value = c.hex;
  opt.textContent = c.name;
  opt.style.color = c.hex;
  els.colorSel.appendChild(opt);
}
els.mapSel.value   = state.mapKey;
els.colorSel.value = state.color;
els.colorSel.hidden = true;   // shown only while DRAW is active

function setMap(key) {
  state.mapKey = key;
  els.mapSel.value = key;
  els.mapImg.src = `radar/${key}.png`;
  els.mapImg.onerror = () => {
    // Friendly placeholder if radar PNG missing.
    els.mapImg.removeAttribute("src");
    els.mapImg.style.background = "#222";
    els.mapImg.alt = `Missing radar/${key}.png — run import_maps.py`;
  };
  els.mapImg.style.background = "";
  els.mapImg.alt = MAPS[key].name;
  document.dispatchEvent(new CustomEvent("mapchange", { detail: key }));
}
setMap(state.mapKey);
els.mapSel.addEventListener("change", e => {
  setMap(e.target.value);
  broadcast({ type: "map-change", mapKey: e.target.value });
});
els.colorSel.addEventListener("change", e => { state.color = e.target.value; });

/* --------------------------------------------------------------------------
 * Tool selection
 * -------------------------------------------------------------------------- */
// PIN / DRAW / GLS / DEV are mutually exclusive modes — only one is the
// "selected tool" at a time, all share the same highlighting paradigm.
// CLR is a one-shot action; NET is an independent panel toggle.
function setTool(tool) {
  if (tool === "clear") { clearAll(true); return; }
  if (tool === "net")   { setNetWindowOpen(!state.net.open); return; }

  const prev = state.tool;
  const next = (prev === tool) ? null : tool;

  // Tear down the previous mode's side-effects, if it had any.
  if (prev === "gls" && next !== "gls") setGlossaryOpen(false);
  if (prev === "dev" && next !== "dev") setDevMode(false);

  state.tool = next;

  // Bring up the new mode's side-effects.
  if (next === "gls" && prev !== "gls") setGlossaryOpen(true);
  if (next === "dev" && prev !== "dev") setDevMode(true);

  // Toolbar: every exclusive tool button reflects state.tool.
  for (const b of els.toolbar.querySelectorAll(".tool")) {
    const t = b.dataset.tool;
    if (t === "clear" || t === "net") continue;
    b.classList.toggle("active", t === next);
  }

  // Cursor + drawing-only colour picker.
  els.surface.classList.remove("tool-pin", "tool-draw", "tool-none");
  els.surface.classList.add(next ? `tool-${next}` : "tool-none");
  els.colorSel.hidden = (next !== "draw");
}
els.toolbar.addEventListener("click", e => {
  const btn = e.target.closest(".tool");
  if (btn) setTool(btn.dataset.tool);
});

/* --------------------------------------------------------------------------
 * Coordinate helpers
 * -------------------------------------------------------------------------- */
function evtToFrac(e) {
  const r = els.surface.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top)  / r.height;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}
function uid() { return Math.random().toString(36).slice(2, 10); }

/* --------------------------------------------------------------------------
 * Markers — unified system covering pins, bomb pin, X-marks, R/S/U/P tags,
 * and footsteps. Synced over the data channel as marker-add/remove/move.
 *
 *   pin      double-click (pin tool); 10s shrinking ring + growing/fading
 *            red haze of max-running radius; turns into "?" at expiry
 *   bomb     'b' key; same animation as pin, only one allowed at a time
 *   x        'x' key while hovering a pin/bomb; replaces it instantly
 *   tag      'r','s','u','p' keys; static letter, draggable
 *   footstep 'f' key; auto-fades over 5 seconds
 *
 *   'd' or right-click while hovering a marker  →  delete it everywhere
 * -------------------------------------------------------------------------- */

function maxRadiusFraction() {
  // Distance the fastest-moving player can cover in 10 seconds, expressed
  // as a fraction of the radar's native 1024px width.
  const scale = MAPS[state.mapKey].scale;
  return (MAX_PLAYER_SPEED * PIN_TIMER_SECONDS) / scale / NATIVE_MAP_PX;
}

function svgEl(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function serializeMarker(m) {
  const out = { id: m.id, type: m.type, x: m.x, y: m.y };
  if (m.sub != null) out.sub = m.sub;
  if (m.t0 != null) out.t0 = m.t0;
  return out;
}

function placeMarker(m, fromRemote = false) {
  // Replace any marker with the same id (used by 'x' conversion).
  const existing = state.markers.get(m.id);
  if (existing) { existing.node.remove(); state.markers.delete(m.id); }

  // The bomb pin (B) and the planted tag (P) share a single slot — placing
  // either one removes any existing instance of either kind.
  const isBombOrP = (mm) => mm.type === "bomb" || (mm.type === "tag" && mm.sub === "P");
  if (isBombOrP(m)) {
    for (const [id, ex] of [...state.markers]) {
      if (isBombOrP(ex)) { ex.node.remove(); state.markers.delete(id); }
    }
  }

  // Reset t0 to local clock so animations run on a clock that's actually
  // ours rather than whichever peer originated the marker.
  const local = { ...m };
  if (local.t0 != null) local.t0 = performance.now();

  const g = svgEl("g", {
    "class": `marker marker-${local.type}`,
    "transform": `translate(${local.x} ${local.y})`,
  });
  g.dataset.id = local.id;

  // Universal: right-click to delete, broadcast to peers.
  g.addEventListener("contextmenu", e => {
    e.preventDefault();
    e.stopPropagation();
    removeMarker(local.id);
  });

  switch (local.type) {
    case "pin":      renderPinAt(g, local); break;
    case "bomb":     renderBombAt(g, local); break;
    case "tag":      renderTagAt(g, local); attachDrag(g); break;
    case "footstep": renderFootstepAt(g, local); break;
    case "x":        renderXAt(g, local); break;
  }

  els.pins.appendChild(g);
  state.markers.set(local.id, { ...local, node: g });
  ensureAnimating();
  if (!fromRemote) broadcast({ type: "marker-add", marker: serializeMarker(local) });
}

function removeMarker(id, fromRemote = false) {
  const m = state.markers.get(id);
  if (!m) return;
  m.node.remove();
  state.markers.delete(id);
  if (!fromRemote) broadcast({ type: "marker-remove", id });
}

function moveMarker(id, x, y, fromRemote = false) {
  const m = state.markers.get(id);
  if (!m) return;
  m.x = x; m.y = y;
  m.node.setAttribute("transform", `translate(${x} ${y})`);
  if (!fromRemote) broadcast({ type: "marker-move", id, x, y });
}

/* ---- Per-type renderers. All sub-elements draw at (0,0) and get
 * positioned via the parent <g>'s transform. ------------------------------ */

function renderPinAt(g, m) {
  const radius = svgEl("circle", { "class": "pin-radius", cx: 0, cy: 0, r: 0 });
  const ringBg = svgEl("circle", { "class": "pin-ring-bg", cx: 0, cy: 0, r: 0.022 });
  const ringFg = svgEl("circle", {
    "class": "pin-ring-fg", cx: 0, cy: 0, r: 0.022,
    pathLength: 1, "stroke-dasharray": 1, "stroke-dashoffset": 0,
  });
  const dot = svgEl("circle", { "class": "pin-dot", cx: 0, cy: 0, r: 0.012 });
  const q = svgEl("text", {
    "class": "pin-q", x: 0, y: 0, "font-size": 0.05,
  });
  q.textContent = "?";
  q.style.display = "none";
  g.append(radius, ringBg, ringFg, dot, q);
  m.refs = { radius, ringBg, ringFg, dot, q };
}

function renderBombAt(g, m) {
  const radius = svgEl("circle", { "class": "bomb-radius", cx: 0, cy: 0, r: 0 });
  const ringBg = svgEl("circle", { "class": "pin-ring-bg", cx: 0, cy: 0, r: 0.026 });
  const ringFg = svgEl("circle", {
    "class": "pin-ring-fg", cx: 0, cy: 0, r: 0.026,
    pathLength: 1, "stroke-dasharray": 1, "stroke-dashoffset": 0,
  });
  const dot = svgEl("circle", { "class": "bomb-dot", cx: 0, cy: 0, r: 0.018 });
  const label = svgEl("text", {
    "class": "bomb-label", x: 0, y: 0, "font-size": 0.026,
    "text-anchor": "middle", "dominant-baseline": "central",
  });
  label.textContent = "B";
  const q = svgEl("text", { "class": "pin-q", x: 0, y: 0, "font-size": 0.05 });
  q.textContent = "?";
  q.style.display = "none";
  g.append(radius, ringBg, ringFg, dot, label, q);
  m.refs = { radius, ringBg, ringFg, dot, q, label };
}

function renderTagAt(g, m) {
  // P uses default size + red background (handled in CSS).
  // R/S/U are 25% smaller so they don't crowd the radar with full-sized text.
  g.classList.add(`tag-${m.sub}`);
  const small = (m.sub === "R" || m.sub === "S" || m.sub === "U");
  const r  = small ? 0.0165 : 0.022;
  const fs = small ? 0.0255 : 0.034;
  const bg = svgEl("circle", { "class": "tag-bg", cx: 0, cy: 0, r });
  const text = svgEl("text", {
    "class": "tag-text", x: 0, y: 0, "font-size": fs,
    "text-anchor": "middle", "dominant-baseline": "central",
  });
  text.textContent = m.sub;
  g.append(bg, text);
}

function renderFootstepAt(g, m) {
  const e1 = svgEl("ellipse", { "class": "footstep-step", cx: -0.006, cy: -0.004, rx: 0.005, ry: 0.008 });
  const e2 = svgEl("ellipse", { "class": "footstep-step", cx:  0.006, cy:  0.005, rx: 0.005, ry: 0.008 });
  g.append(e1, e2);
}

function renderXAt(g, m) {
  const a = svgEl("line", { "class": "x-line", x1: -0.018, y1: -0.018, x2: 0.018, y2:  0.018 });
  const b = svgEl("line", { "class": "x-line", x1: -0.018, y1:  0.018, x2: 0.018, y2: -0.018 });
  g.append(a, b);
}

function attachDrag(g) {
  let dragging = false;
  let pid = null;
  let offX = 0, offY = 0;
  g.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const m = state.markers.get(g.dataset.id);
    if (!m) return;
    const f = evtToFrac(e);
    offX = f.x - m.x;
    offY = f.y - m.y;
    g.setPointerCapture(e.pointerId);
    pid = e.pointerId;
    dragging = true;
  });
  g.addEventListener("pointermove", e => {
    if (!dragging) return;
    const f = evtToFrac(e);
    moveMarker(g.dataset.id, f.x - offX, f.y - offY);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (pid != null) { try { g.releasePointerCapture(pid); } catch {} }
    pid = null;
  };
  g.addEventListener("pointerup", end);
  g.addEventListener("pointercancel", end);
}

function tickMarkers(now) {
  const rMax = maxRadiusFraction();
  for (const m of state.markers.values()) {
    if (m.type === "pin" || m.type === "bomb") {
      const dt = (now - m.t0) / 1000;
      if (dt < PIN_TIMER_SECONDS) {
        const frac = dt / PIN_TIMER_SECONDS;
        m.refs.ringFg.setAttribute("stroke-dashoffset", frac);
        m.refs.radius.setAttribute("r", rMax * frac);
        m.refs.radius.style.opacity = String(0.75 * (1 - frac));
      } else if (!m.expired) {
        m.expired = true;
        m.refs.ringFg.style.display = "none";
        m.refs.ringBg.style.display = "none";
        m.refs.dot.style.display = "none";
        if (m.refs.label) m.refs.label.style.display = "none";
        m.refs.radius.style.opacity = "0";
        m.refs.q.style.display = "";
      }
    } else if (m.type === "footstep") {
      const dt = (now - m.t0) / 1000;
      if (dt < 5) {
        m.node.style.opacity = String(1 - dt / 5);
      } else if (!m.expired) {
        m.expired = true;
        // Each peer fades on its own clock — local-only cleanup, no sync.
        removeMarker(m.id, true);
      }
    }
  }
}

function hasActiveAnimation() {
  for (const m of state.markers.values()) {
    if ((m.type === "pin" || m.type === "bomb" || m.type === "footstep") && !m.expired) return true;
  }
  return false;
}

let rafHandle = null;
function ensureAnimating() {
  if (rafHandle != null) return;
  const loop = (now) => {
    tickMarkers(now);
    if (!hasActiveAnimation()) { rafHandle = null; return; }
    rafHandle = requestAnimationFrame(loop);
  };
  rafHandle = requestAnimationFrame(loop);
}

/* --------------------------------------------------------------------------
 * Free-hand drawing
 * -------------------------------------------------------------------------- */
function strokeToPath(points) {
  if (points.length === 0) return "";
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length; i++) d += ` L ${points[i][0]} ${points[i][1]}`;
  return d;
}

function addStroke(stroke, fromRemote = false) {
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("class", "stroke");
  path.setAttribute("stroke", stroke.color);
  path.setAttribute("stroke-width", "0.005");
  path.setAttribute("vector-effect", "non-scaling-stroke");
  path.setAttribute("d", strokeToPath(stroke.points));
  els.strokes.appendChild(path);
  state.strokes.set(stroke.id, { ...stroke, node: path });
  if (!fromRemote) broadcast({ type: "stroke-add", stroke });
}

function clearAll(broadcastEvent) {
  for (const m of state.markers.values()) m.node.remove();
  state.markers.clear();
  els.strokes.innerHTML = "";
  state.strokes.clear();
  if (broadcastEvent) broadcast({ type: "clear" });
}

/* --------------------------------------------------------------------------
 * Pointer routing on the surface
 * -------------------------------------------------------------------------- */
els.surface.addEventListener("dblclick", e => {
  if (state.tool !== "pin") return;
  if (e.target.closest(".marker")) return;  // never place on top of one
  const { x, y } = evtToFrac(e);
  placeMarker({ id: uid(), type: "pin", x, y, t0: performance.now() });
});

els.surface.addEventListener("contextmenu", e => {
  // Allow right-click delete to bubble from pins; if click landed on empty
  // surface, just suppress the menu.
  e.preventDefault();
});

els.surface.addEventListener("pointerdown", e => {
  if (state.tool !== "draw" || e.button !== 0) return;
  const { x, y } = evtToFrac(e);
  const id = uid();
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("class", "stroke");
  path.setAttribute("stroke", state.color);
  path.setAttribute("stroke-width", "0.005");
  path.setAttribute("vector-effect", "non-scaling-stroke");
  els.strokes.appendChild(path);
  state.drawing = { id, color: state.color, points: [[x, y]], node: path };
  path.setAttribute("d", strokeToPath(state.drawing.points));
  els.surface.setPointerCapture(e.pointerId);
});

els.surface.addEventListener("pointermove", e => {
  if (!state.drawing) return;
  const { x, y } = evtToFrac(e);
  const last = state.drawing.points[state.drawing.points.length - 1];
  // Drop near-duplicate points to keep the path light.
  if (Math.hypot(x - last[0], y - last[1]) < 0.002) return;
  state.drawing.points.push([x, y]);
  state.drawing.node.setAttribute("d", strokeToPath(state.drawing.points));
});

els.surface.addEventListener("pointerup", () => {
  if (!state.drawing) return;
  const s = { id: state.drawing.id, color: state.drawing.color, points: state.drawing.points };
  state.strokes.set(s.id, { ...s, node: state.drawing.node });
  broadcast({ type: "stroke-add", stroke: s });
  state.drawing = null;
});

/* --------------------------------------------------------------------------
 * Cursor tracking & keyboard shortcuts
 *
 * Hover-aware:
 *   d  delete the marker under the cursor
 *   x  convert hovered pin/bomb into an X (kill confirmed; radius gone)
 *
 * Cursor-place:
 *   r  rifle tag       s  sniper tag      u  utility tag
 *   p  planted tag     b  bomb-spotted pin (singleton, animated)
 *   f  footstep        (auto-fades over 5 seconds)
 * -------------------------------------------------------------------------- */
els.surface.addEventListener("pointerenter", e => {
  state.cursor.overSurface = true;
  state.cursor.x = e.clientX;
  state.cursor.y = e.clientY;
  state.cursor.frac = evtToFrac(e);
});
els.surface.addEventListener("pointerleave", () => {
  state.cursor.overSurface = false;
});
els.surface.addEventListener("pointermove", e => {
  state.cursor.overSurface = true;
  state.cursor.x = e.clientX;
  state.cursor.y = e.clientY;
  state.cursor.frac = evtToFrac(e);
}, { passive: true });

document.addEventListener("keydown", e => {
  if (e.target?.matches?.("input, textarea, select, [contenteditable]")) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!state.cursor.overSurface) return;

  const k = e.key.toLowerCase();

  // Find the marker under the cursor (if any) for hover-aware actions.
  const elUnder = document.elementFromPoint(state.cursor.x, state.cursor.y);
  const markerEl = elUnder ? elUnder.closest(".marker") : null;
  const hovered  = markerEl ? state.markers.get(markerEl.dataset.id) : null;

  if ((k === "d" || e.key === "Delete") && hovered) {
    removeMarker(hovered.id);
    e.preventDefault();
    return;
  }
  if (k === "x" && hovered && (hovered.type === "pin" || hovered.type === "bomb")) {
    // Same id → placeMarker treats it as a replacement.
    placeMarker({ id: hovered.id, type: "x", x: hovered.x, y: hovered.y });
    e.preventDefault();
    return;
  }

  const f = state.cursor.frac;
  let nm = null;
  switch (k) {
    case "r": nm = { id: uid(), type: "tag", sub: "R", x: f.x, y: f.y }; break;
    case "s": nm = { id: uid(), type: "tag", sub: "S", x: f.x, y: f.y }; break;
    case "u": nm = { id: uid(), type: "tag", sub: "U", x: f.x, y: f.y }; break;
    case "p": nm = { id: uid(), type: "tag", sub: "P", x: f.x, y: f.y }; break;
    case "f": nm = { id: uid(), type: "footstep", x: f.x, y: f.y, t0: performance.now() }; break;
    case "b": nm = { id: uid(), type: "bomb",     x: f.x, y: f.y, t0: performance.now() }; break;
  }
  if (nm) {
    placeMarker(nm);
    e.preventDefault();
  }
});

/* --------------------------------------------------------------------------
 * Networking — PeerJS public broker handles signalling, so the static page
 * needs no backend of its own.
 * -------------------------------------------------------------------------- */
const net = {
  peer: null,
  isHost: false,
  hostConn: null,                     // viewer → host data channel
  viewers: new Map(),                 // host: peerId → {conn, call}
  outgoingStream: null,
};

function setStatus(text, cls) {
  els.connStatus.className = "status " + (cls || "");
  els.connStatus.textContent = text;
}

function broadcast(msg) {
  // Host: relay to every viewer. Viewer: send to host (which echoes out).
  const data = JSON.stringify(msg);
  if (net.isHost) {
    for (const v of net.viewers.values()) {
      if (v.conn && v.conn.open) v.conn.send(data);
    }
  } else if (net.hostConn && net.hostConn.open) {
    net.hostConn.send(data);
  }
}

function applyMessage(msg, fromConn) {
  switch (msg.type) {
    case "marker-add":    placeMarker(msg.marker, true); break;
    case "marker-remove": removeMarker(msg.id, true); break;
    case "marker-move":   moveMarker(msg.id, msg.x, msg.y, true); break;
    case "stroke-add":    addStroke(msg.stroke, true); break;
    case "clear":         clearAll(false); break;
    case "notice":        applyNotice(msg.notice); break;
    case "map-change":    setMap(msg.mapKey); break;
    case "state-sync":
      if (msg.mapKey) setMap(msg.mapKey);
      clearAll(false);
      for (const s of msg.strokes) addStroke(s, true);
      for (const m of msg.markers) placeMarker(m, true);
      applyNotice(msg.notice || null);
      break;
  }
  // Host relays viewer-originated changes to the rest of the room.
  if (net.isHost && fromConn && msg.type !== "state-sync") {
    const data = JSON.stringify(msg);
    for (const v of net.viewers.values()) {
      if (v.conn !== fromConn && v.conn.open) v.conn.send(data);
    }
  }
}

function snapshotState() {
  return {
    type: "state-sync",
    mapKey:  state.mapKey,
    markers: [...state.markers.values()].map(serializeMarker),
    strokes: [...state.strokes.values()].map(s => ({ id: s.id, color: s.color, points: s.points })),
    notice:  state.notice,
  };
}

function host() {
  if (net.peer) return;
  net.peer = new Peer();
  net.peer.on("open", id => {
    net.isHost = true;
    setStatus(`hosting · ${id}`, "hosting");
    els.hostBtn.textContent = "Share";
    showShareLink(id);
    // Once we have an id, prompt for screen sharing immediately.
    openBroadcastDialog();
  });
  net.peer.on("connection", conn => {
    conn.on("open", () => {
      net.viewers.set(conn.peer, { conn });
      conn.send(JSON.stringify(snapshotState()));
      // If we already have an outgoing stream, call the new viewer with it.
      if (net.outgoingStream) {
        const call = net.peer.call(conn.peer, net.outgoingStream);
        net.viewers.get(conn.peer).call = call;
      }
    });
    conn.on("data", raw => {
      try { applyMessage(JSON.parse(raw), conn); } catch {}
    });
    conn.on("close", () => net.viewers.delete(conn.peer));
  });
  net.peer.on("error", e => setStatus(`error: ${e.type}`));
}

function join(roomId) {
  if (!roomId) return;
  if (net.peer) net.peer.destroy();
  net.peer = new Peer();
  net.peer.on("open", () => {
    setStatus(`connecting…`);
    net.hostConn = net.peer.connect(roomId, { reliable: true });
    net.hostConn.on("open", () => setStatus(`joined · ${roomId}`, "connected"));
    net.hostConn.on("data", raw => {
      try { applyMessage(JSON.parse(raw)); } catch {}
    });
    net.hostConn.on("close", () => setStatus("disconnected"));
  });
  net.peer.on("call", call => {
    call.answer();
    call.on("stream", remote => { els.video.srcObject = remote; });
  });
  net.peer.on("error", e => setStatus(`error: ${e.type}`));
}

els.hostBtn.addEventListener("click", () => {
  if (!net.peer) host();
  else openBroadcastDialog();
});

// Build a URL that points at this page with a room hash baked in, so anyone
// who clicks it auto-joins the host on load.
function showShareLink(id) {
  const u = new URL(window.location.href);
  u.hash = `room=${id}`;
  els.shareLink.value = u.toString();
  els.shareRow.hidden = false;
}

els.copyLinkBtn.addEventListener("click", async () => {
  const text = els.shareLink.value;
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {}
  if (!ok) {
    els.shareLink.select();
    try { document.execCommand("copy"); ok = true; } catch {}
  }
  els.copyLinkBtn.textContent = ok ? "Copied!" : "Press ⌘/Ctrl-C";
  setTimeout(() => { els.copyLinkBtn.textContent = "Copy"; }, 1500);
});

// Auto-join when the page is opened via a host's share link (#room=<id>).
(function autoJoinFromHash() {
  const m = window.location.hash.match(/^#room=(.+)$/);
  if (!m) return;
  const roomId = decodeURIComponent(m[1]);
  // We're a viewer: hide the host UI to avoid double roles on this tab.
  els.hostBtn.hidden = true;
  join(roomId);
})();

/* --------------------------------------------------------------------------
 * Broadcast region picker — we capture the user-selected display, render
 * a preview, and let them drag a rectangle to choose what gets streamed.
 * The cropped region is rendered into a hidden canvas every frame and that
 * canvas's captureStream() is what we send to viewers.
 * -------------------------------------------------------------------------- */
const broadcaster = {
  sourceStream: null,
  rect: { x: 0, y: 0, w: 512, h: 512 },
  intrinsic: { w: 0, h: 0 },          // native resolution of source video
  outCanvas: null,
  outCtx: null,
  rafId: null,
};

function drawCropOverlay() {
  const cv = els.cropCanvas;
  const ctx = cv.getContext("2d");
  const v = els.srcVideo;
  if (!v.videoWidth) return;
  // Match canvas to displayed video size.
  cv.width  = cv.clientWidth;
  cv.height = cv.clientHeight;
  // Compute "letterbox" of contained video.
  const vr = v.videoWidth / v.videoHeight;
  const cr = cv.width / cv.height;
  let dx, dy, dw, dh;
  if (vr > cr) { dw = cv.width;  dh = cv.width / vr;  dx = 0; dy = (cv.height - dh) / 2; }
  else         { dh = cv.height; dw = cv.height * vr; dy = 0; dx = (cv.width  - dw) / 2; }
  ctx.clearRect(0, 0, cv.width, cv.height);
  // Map intrinsic-pixel rect → canvas pixels.
  const sx = dw / v.videoWidth;
  const sy = dh / v.videoHeight;
  const rx = dx + broadcaster.rect.x * sx;
  const ry = dy + broadcaster.rect.y * sy;
  const rw = broadcaster.rect.w * sx;
  const rh = broadcaster.rect.h * sy;
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.clearRect(rx, ry, rw, rh);
  ctx.strokeStyle = "#ff5050";
  ctx.lineWidth = 2;
  ctx.strokeRect(rx, ry, rw, rh);
}

function setRect(r) {
  const iw = broadcaster.intrinsic.w || 1;
  const ih = broadcaster.intrinsic.h || 1;
  broadcaster.rect = {
    x: Math.max(0, Math.min(iw - 1, Math.round(r.x))),
    y: Math.max(0, Math.min(ih - 1, Math.round(r.y))),
    w: Math.max(8, Math.min(iw, Math.round(r.w))),
    h: Math.max(8, Math.min(ih, Math.round(r.h))),
  };
  els.cx.value = broadcaster.rect.x;
  els.cy.value = broadcaster.rect.y;
  els.cw.value = broadcaster.rect.w;
  els.ch.value = broadcaster.rect.h;
  drawCropOverlay();
}

// Drag a fresh rectangle on the preview canvas.
let dragStart = null;
els.cropCanvas.addEventListener("pointerdown", e => {
  const cv = els.cropCanvas;
  const v = els.srcVideo;
  if (!v.videoWidth) return;
  const r = cv.getBoundingClientRect();
  const cx = e.clientX - r.left;
  const cy = e.clientY - r.top;
  // Inverse of drawCropOverlay's letterbox math → intrinsic pixel coords.
  const vr = v.videoWidth / v.videoHeight;
  const cr = cv.clientWidth / cv.clientHeight;
  let dx, dy, dw, dh;
  if (vr > cr) { dw = cv.clientWidth;  dh = cv.clientWidth / vr;  dx = 0; dy = (cv.clientHeight - dh) / 2; }
  else         { dh = cv.clientHeight; dw = cv.clientHeight * vr; dy = 0; dx = (cv.clientWidth  - dw) / 2; }
  const ix = (cx - dx) / dw * v.videoWidth;
  const iy = (cy - dy) / dh * v.videoHeight;
  dragStart = { ix, iy, ev: e };
  els.cropCanvas.setPointerCapture(e.pointerId);
});
els.cropCanvas.addEventListener("pointermove", e => {
  if (!dragStart) return;
  const cv = els.cropCanvas;
  const v = els.srcVideo;
  const r = cv.getBoundingClientRect();
  const cx = e.clientX - r.left;
  const cy = e.clientY - r.top;
  const vr = v.videoWidth / v.videoHeight;
  const cr = cv.clientWidth / cv.clientHeight;
  let dx, dy, dw, dh;
  if (vr > cr) { dw = cv.clientWidth;  dh = cv.clientWidth / vr;  dx = 0; dy = (cv.clientHeight - dh) / 2; }
  else         { dh = cv.clientHeight; dw = cv.clientHeight * vr; dy = 0; dx = (cv.clientWidth  - dw) / 2; }
  const ix = (cx - dx) / dw * v.videoWidth;
  const iy = (cy - dy) / dh * v.videoHeight;
  setRect({
    x: Math.min(dragStart.ix, ix),
    y: Math.min(dragStart.iy, iy),
    w: Math.abs(ix - dragStart.ix),
    h: Math.abs(iy - dragStart.iy),
  });
});
els.cropCanvas.addEventListener("pointerup", () => { dragStart = null; });

for (const [el, key] of [[els.cx, "x"], [els.cy, "y"], [els.cw, "w"], [els.ch, "h"]]) {
  el.addEventListener("input", () => {
    setRect({ ...broadcaster.rect, [key]: parseInt(el.value, 10) || 0 });
  });
}

async function openBroadcastDialog() {
  // If a prior broadcast moved srcVideo out of the dialog (so it kept
  // decoding while the dialog was display:none'd), put it back so the user
  // can see the preview again.
  const cropPreview = document.getElementById("cropPreview");
  if (els.srcVideo.parentElement !== cropPreview) {
    els.srcVideo.removeAttribute("style");
    cropPreview.insertBefore(els.srcVideo, cropPreview.firstChild);
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false,
    });
  } catch (err) {
    setStatus("screen share denied");
    return;
  }
  broadcaster.sourceStream = stream;
  els.srcVideo.srcObject = stream;
  await new Promise(r => els.srcVideo.addEventListener("loadedmetadata", r, { once: true }));
  broadcaster.intrinsic = { w: els.srcVideo.videoWidth, h: els.srcVideo.videoHeight };
  // Default: full screen.
  setRect({ x: 0, y: 0, w: broadcaster.intrinsic.w, h: broadcaster.intrinsic.h });
  els.hostHint.textContent =
    `Source: ${broadcaster.intrinsic.w}×${broadcaster.intrinsic.h}` +
    (net.peer && net.peer.id ? ` · room id: ${net.peer.id}` : "");
  els.hostDialog.showModal();
  requestAnimationFrame(function loop(){ if (els.hostDialog.open) { drawCropOverlay(); requestAnimationFrame(loop); } });
}

els.cancelBroadcast.addEventListener("click", () => {
  if (broadcaster.sourceStream) {
    for (const t of broadcaster.sourceStream.getTracks()) t.stop();
    broadcaster.sourceStream = null;
  }
  els.hostDialog.close();
});

els.confirmBroadcast.addEventListener("click", () => {
  if (!broadcaster.sourceStream) return;
  // Build a render canvas sized to the cropped region, redraw each frame.
  const cv = document.createElement("canvas");
  cv.width  = broadcaster.rect.w;
  cv.height = broadcaster.rect.h;
  const ctx = cv.getContext("2d");
  broadcaster.outCanvas = cv;
  broadcaster.outCtx = ctx;

  // The dialog is about to close (display:none), which would freeze the
  // <video> inside it on its last decoded frame. Relocate srcVideo to the
  // body offscreen so frames keep flowing into the canvas tick below.
  els.srcVideo.style.cssText = "position:fixed; left:-9999px; top:0; width:1px; height:1px;";
  document.body.appendChild(els.srcVideo);

  const tick = () => {
    if (!broadcaster.outCanvas) return;
    const r = broadcaster.rect;
    if (cv.width !== r.w || cv.height !== r.h) { cv.width = r.w; cv.height = r.h; }
    ctx.drawImage(els.srcVideo, r.x, r.y, r.w, r.h, 0, 0, cv.width, cv.height);
    broadcaster.rafId = requestAnimationFrame(tick);
  };
  tick();

  net.outgoingStream = cv.captureStream(30);
  // Show the cropped feed on our own board too — viewers get it via the
  // peer.call below, but the host needs srcObject set explicitly.
  els.video.srcObject = net.outgoingStream;
  els.video.play().catch(() => {});
  // Replace any existing outgoing video track on each viewer call.
  for (const [peerId, v] of net.viewers.entries()) {
    if (v.call) v.call.close();
    v.call = net.peer.call(peerId, net.outgoingStream);
  }
  setStatus(`hosting · broadcasting · ${net.peer.id}`, "hosting");
  els.hostDialog.close();
});

/* --------------------------------------------------------------------------
 * Per-map labels, dev-mode authoring, and the glossary panel.
 *
 * Labels are rectangles in 0..1 frac of the (square) map, defined in
 * labels.js. In normal app mode they're invisible but fire mouse-over
 * events that show the label name in a top-centre tooltip. Toggle the
 * glossary (4th toolbar button, or hold backtick) to see every label
 * for the current map listed alphabetically; hovering a label or a
 * glossary entry draws an orange dashed line connecting them.
 *
 * Dev mode (DEV button bottom-right): boxes become visible, dragging on
 * empty space creates a new one, clicking an existing one re-prompts its
 * label (empty deletes it), and "Copy JSON" puts a drop-in `const LABELS`
 * literal on the clipboard for pasting back into labels.js.
 * -------------------------------------------------------------------------- */

function currentLabels() {
  if (!state.labels[state.mapKey]) state.labels[state.mapKey] = [];
  return state.labels[state.mapKey];
}

function renderLabels() {
  els.labels.innerHTML = "";
  const arr = currentLabels();
  for (let i = 0; i < arr.length; i++) {
    const l = arr[i];
    const g = svgEl("g", { "class": "label" });
    g.dataset.idx = i;
    const rect = svgEl("rect", {
      "class": "label-box",
      x: l.x, y: l.y, width: l.w, height: l.h,
    });
    const text = svgEl("text", {
      "class": "label-text",
      x: l.x + l.w / 2, y: l.y + l.h / 2,
      "font-size": Math.min(0.022, Math.max(0.012, l.h * 0.4)),
    });
    text.textContent = l.label;
    g.append(rect, text);
    els.labels.appendChild(g);
  }
  if (state.glossary.open) renderGlossary();
}

function renderGlossary() {
  const arr = currentLabels();
  // Sort alphabetically but keep the original index so connector lines
  // can find the right box.
  const sorted = arr
    .map((l, i) => ({ ...l, idx: i }))
    .sort((a, b) => a.label.localeCompare(b.label));
  els.glossaryList.innerHTML = "";
  for (const l of sorted) {
    const li = document.createElement("li");
    li.dataset.idx = l.idx;
    li.textContent = l.label;
    li.addEventListener("pointerover", () => setHoverLabel(l.idx));
    li.addEventListener("pointerout",  () => {
      if (state.hoverLabel === l.idx) setHoverLabel(null);
    });
    els.glossaryList.appendChild(li);
  }
}

function setHoverLabel(idx) {
  state.hoverLabel = idx;
  document.querySelectorAll("#glossary li.hover, .label.hover, .connector-line.hover, .connector-dot.hover")
    .forEach(n => n.classList.remove("hover"));
  if (idx == null) { els.tooltip.hidden = true; return; }
  const l = currentLabels()[idx];
  if (!l) { els.tooltip.hidden = true; return; }
  els.tooltip.textContent = l.label;
  els.tooltip.hidden = false;
  document.querySelector(`#glossary li[data-idx="${idx}"]`)?.classList.add("hover");
  document.querySelector(`.label[data-idx="${idx}"]`)?.classList.add("hover");
  document.querySelectorAll(`.connector-line[data-idx="${idx}"], .connector-dot[data-idx="${idx}"]`)
    .forEach(n => n.classList.add("hover"));
}

function renderAllConnectors() {
  els.connectorLines.innerHTML = "";
  if (!state.glossary.open) return;
  const arr = currentLabels();
  // SVG's user coords are CSS pixels relative to its own top-left. Once
  // the notice pushes #stage down, that's no longer (0,0) of the viewport,
  // so we subtract the SVG's offset to convert getBoundingClientRect()
  // viewport pixels back into SVG-local pixels.
  const svgRect = els.connectorLines.ownerSVGElement.getBoundingClientRect();
  const surface = els.surface.getBoundingClientRect();
  const entries = els.glossaryList.querySelectorAll("li");
  for (const li of entries) {
    const idx = parseInt(li.dataset.idx, 10);
    const l = arr[idx];
    if (!l) continue;
    const e = li.getBoundingClientRect();
    const cx = surface.left + (l.x + l.w / 2) * surface.width - svgRect.left;
    const cy = surface.top  + (l.y + l.h / 2) * surface.height - svgRect.top;
    const ex = e.left - svgRect.left;
    const ey = e.top + e.height / 2 - svgRect.top;
    els.connectorLines.append(
      svgEl("line",   { "class": "connector-line", "data-idx": idx,
                        x1: cx, y1: cy, x2: ex, y2: ey }),
      svgEl("circle", { "class": "connector-dot",  "data-idx": idx,
                        cx: cx, cy: cy, r: 3 }),
      svgEl("circle", { "class": "connector-dot",  "data-idx": idx,
                        cx: ex, cy: ey, r: 3 }),
    );
  }
  // Re-apply hover highlight if any.
  if (state.hoverLabel != null) {
    document.querySelectorAll(`.connector-line[data-idx="${state.hoverLabel}"], .connector-dot[data-idx="${state.hoverLabel}"]`)
      .forEach(n => n.classList.add("hover"));
  }
}

// Hover events on label boxes (delegated on the labels group).
els.labels.addEventListener("pointerover", e => {
  const g = e.target.closest(".label");
  if (!g) return;
  setHoverLabel(parseInt(g.dataset.idx, 10));
});
els.labels.addEventListener("pointerout", e => {
  const g = e.target.closest(".label");
  if (!g) return;
  if (state.hoverLabel === parseInt(g.dataset.idx, 10)) setHoverLabel(null);
});

/* ---- Glossary toggle (toolbar button + tilde-hold) -------------------- */

function setGlossaryOpen(open, viaHold = false) {
  state.glossary.open = open;
  state.glossary.holding = !!(viaHold && open);
  els.glossary.hidden = !open;
  // Toolbar highlight is owned by setTool — don't touch it here.
  if (open) {
    renderGlossary();
    requestAnimationFrame(renderAllConnectors);  // wait for layout to settle
  } else {
    els.connectorLines.innerHTML = "";
  }
}

// Glossary list scrolls if it overflows; lines must follow. (Resize is
// handled by the global ResizeObserver further down the file.)
document.getElementById("glossary").addEventListener("scroll", () => {
  if (state.glossary.open) renderAllConnectors();
});

document.addEventListener("keydown", e => {
  if (e.key !== "`" && e.key !== "~") return;
  if (e.target?.matches?.("input, textarea, select, [contenteditable]")) return;
  if (state.dev) return;            // glossary is app-mode only
  if (state.glossary.open) return;  // already open via toolbar — leave it
  setGlossaryOpen(true, true);
  e.preventDefault();
});
document.addEventListener("keyup", e => {
  if (e.key !== "`" && e.key !== "~") return;
  if (!state.glossary.holding) return;
  setGlossaryOpen(false);
});

/* ---- Dev mode --------------------------------------------------------- */

function setDevMode(on) {
  state.dev = on;
  document.body.classList.toggle("dev-mode", on);
  els.copyLabelsBtn.hidden = !on;
  // Toolbar highlight is owned by setTool — don't touch it here.
}

function setNetWindowOpen(open) {
  state.net.open = open;
  els.netWindow.hidden = !open;
  document.querySelector('.tool[data-tool="net"]')?.classList.toggle("active", open);
}

// Drag the network panel by its title bar.
{
  const tb = els.netWindow.querySelector(".floating-titlebar");
  let dragging = false, sx = 0, sy = 0, pid = null;
  tb.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    const r = els.netWindow.getBoundingClientRect();
    sx = e.clientX - r.left;
    sy = e.clientY - r.top;
    dragging = true;
    pid = e.pointerId;
    tb.setPointerCapture(pid);
    e.preventDefault();
  });
  tb.addEventListener("pointermove", e => {
    if (!dragging) return;
    // The window is position:absolute inside #stage, so style.left/top is
    // measured from #stage's edge — translate the viewport pointer back
    // into stage-local pixels and clamp to the stage.
    const parent = els.netWindow.offsetParent || document.body;
    const pr = parent.getBoundingClientRect();
    const x = Math.max(0, Math.min(pr.width  - 80, e.clientX - sx - pr.left));
    const y = Math.max(0, Math.min(pr.height - 30, e.clientY - sy - pr.top));
    els.netWindow.style.left  = x + "px";
    els.netWindow.style.top   = y + "px";
    els.netWindow.style.right = "auto";
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (pid != null) { try { tb.releasePointerCapture(pid); } catch {} }
    pid = null;
  };
  tb.addEventListener("pointerup", end);
  tb.addEventListener("pointercancel", end);
}

// Visible by default → mark the NET tool active to match.
setNetWindowOpen(true);

els.copyLabelsBtn.addEventListener("click", async () => {
  const f = (n) => {
    const s = n.toFixed(4);
    return s.replace(/\.?0+$/, "") || "0";
  };
  const lines = ["const LABELS = {"];
  for (const k of Object.keys(state.labels)) {
    const arr = state.labels[k] || [];
    if (!arr.length) { lines.push(`  ${k}: [],`); continue; }
    lines.push(`  ${k}: [`);
    for (const l of arr) {
      lines.push(`    { x: ${f(l.x)}, y: ${f(l.y)}, w: ${f(l.w)}, h: ${f(l.h)}, label: ${JSON.stringify(l.label)} },`);
    }
    lines.push(`  ],`);
  }
  lines.push("};");
  const text = lines.join("\n");
  try {
    await navigator.clipboard.writeText(text);
    els.copyLabelsBtn.textContent = "Copied!";
    setTimeout(() => { els.copyLabelsBtn.textContent = "Copy JSON"; }, 1500);
  } catch {
    window.prompt("Copy and paste into labels.js:", text);
  }
});

// In dev mode: drag on empty surface creates a new box, click an existing
// one prompts to relabel/delete. Capture phase so we run before drawing.
els.surface.addEventListener("pointerdown", e => {
  if (!state.dev || e.button !== 0) return;
  if (state.tool === "draw" || state.tool === "pin") return;
  if (e.target.closest(".label, .marker")) return;
  e.stopPropagation();
  const f = evtToFrac(e);
  const preview = svgEl("rect", {
    "class": "label-box-preview",
    x: f.x, y: f.y, width: 0, height: 0,
  });
  els.surface.appendChild(preview);
  state.boxDrag = { x0: f.x, y0: f.y, preview };
  els.surface.setPointerCapture(e.pointerId);
}, true);

els.surface.addEventListener("pointermove", e => {
  if (!state.boxDrag) return;
  const f = evtToFrac(e);
  const x = Math.min(state.boxDrag.x0, f.x);
  const y = Math.min(state.boxDrag.y0, f.y);
  const w = Math.abs(f.x - state.boxDrag.x0);
  const h = Math.abs(f.y - state.boxDrag.y0);
  state.boxDrag.preview.setAttribute("x", x);
  state.boxDrag.preview.setAttribute("y", y);
  state.boxDrag.preview.setAttribute("width", w);
  state.boxDrag.preview.setAttribute("height", h);
}, true);

els.surface.addEventListener("pointerup", e => {
  if (!state.boxDrag) return;
  const f = evtToFrac(e);
  const x = Math.min(state.boxDrag.x0, f.x);
  const y = Math.min(state.boxDrag.y0, f.y);
  const w = Math.abs(f.x - state.boxDrag.x0);
  const h = Math.abs(f.y - state.boxDrag.y0);
  state.boxDrag.preview.remove();
  state.boxDrag = null;
  if (w < 0.005 || h < 0.005) return;     // ignore stray clicks
  const label = (window.prompt("Label for this region:") || "").trim();
  if (!label) return;
  currentLabels().push({ x, y, w, h, label });
  renderLabels();
}, true);

// Click an existing label in dev mode to rename or delete (empty input deletes).
els.labels.addEventListener("click", e => {
  if (!state.dev) return;
  const g = e.target.closest(".label");
  if (!g) return;
  const idx = parseInt(g.dataset.idx, 10);
  const arr = currentLabels();
  const cur = arr[idx];
  if (!cur) return;
  const next = window.prompt("Label (empty to delete):", cur.label);
  if (next === null) return;
  if (next.trim() === "") arr.splice(idx, 1);
  else                    cur.label = next.trim();
  renderLabels();
});

document.addEventListener("mapchange", () => {
  renderLabels();
  setHoverLabel(null);
  if (state.glossary.open) {
    renderGlossary();
    requestAnimationFrame(renderAllConnectors);
  }
});

renderLabels();

/* --------------------------------------------------------------------------
 * Notice — broadcast top-of-screen banner with a dashed border in the same
 * colour. Anyone can fire one from the combobox in the top bar, and the
 * active notice is part of the room state so joiners pick it up.
 *
 *   "Push /red"                 → red bg, white text, black outline (defaults)
 *   "Hide /black white black"   → bg, fg, outline (space-separated tokens)
 *
 * Default colours when no /…: black bg, white text, black outline.
 * -------------------------------------------------------------------------- */

function parseNotice(input) {
  const slash = input.indexOf("/");
  if (slash === -1) {
    return { text: input.trim(), bg: "#000", fg: "#fff", outline: "#000" };
  }
  const text = input.slice(0, slash).trim();
  const tokens = input.slice(slash + 1).trim().split(/\s+/).filter(Boolean);
  return {
    text,
    bg:      tokens[0] || "#000",
    fg:      tokens[1] || "#fff",
    outline: tokens[2] || "#000",
  };
}

function applyNotice(notice) {
  // Pure local apply — used for incoming messages and state-sync so we
  // don't echo back. Calls into showNotice/hideNotice with fromRemote=true.
  if (notice && notice.text) showNotice(notice, true);
  else                       hideNotice(true);
}

function showNotice(notice, fromRemote = false) {
  state.notice = notice;
  els.noticeText.textContent = notice.text;
  document.body.style.setProperty("--notice-bg",      notice.bg);
  document.body.style.setProperty("--notice-fg",      notice.fg);
  document.body.style.setProperty("--notice-outline", notice.outline);
  document.body.classList.add("notice-on");
  if (!fromRemote) broadcast({ type: "notice", notice });
}

function hideNotice(fromRemote = false) {
  state.notice = null;
  document.body.classList.remove("notice-on");
  if (!fromRemote) broadcast({ type: "notice", notice: null });
}

els.noticeClose.addEventListener("click", () => hideNotice());

// Combobox: focus shows defaults, click fills + sends, Enter sends typed text.
els.noticeInput.addEventListener("focus", () => { els.noticeOptions.hidden = false; });
els.noticeInput.addEventListener("blur",  () => {
  setTimeout(() => { els.noticeOptions.hidden = true; }, 150);
});
els.noticeOptions.addEventListener("mousedown", e => {
  // mousedown beats blur ordering — pick + submit in one step.
  const li = e.target.closest("li");
  if (!li) return;
  e.preventDefault();
  showNotice(parseNotice(li.dataset.value));
  els.noticeInput.value = "";
  els.noticeInput.blur();
  els.noticeOptions.hidden = true;
});
els.noticeInput.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    e.preventDefault();
    const text = els.noticeInput.value.trim();
    if (!text) return;
    showNotice(parseNotice(text));
    rememberNoticeOption(text);
    els.noticeInput.value = "";
    els.noticeOptions.hidden = true;
    els.noticeInput.blur();
  } else if (e.key === "Escape") {
    els.noticeOptions.hidden = true;
    els.noticeInput.blur();
  }
});

// Build a dropdown <li> styled like the built-in defaults: plain text up to
// the "/", then the slash-colour suffix coloured to match (with the special
// inverted pill for "/black" so it stays readable on the dark dropdown).
function makeNoticeOption(value) {
  const li = document.createElement("li");
  li.dataset.value = value;
  const slash = value.indexOf("/");
  if (slash === -1) {
    li.textContent = value;
    return li;
  }
  li.appendChild(document.createTextNode(value.slice(0, slash)));
  const tail = value.slice(slash);
  const bg = (tail.slice(1).split(/\s+/)[0] || "").toLowerCase();
  const span = document.createElement("span");
  span.textContent = tail;
  if (bg === "black" || bg === "#000" || bg === "#000000") {
    span.className = "slash-black";
  } else if (bg) {
    span.style.color = bg;
  }
  li.appendChild(span);
  return li;
}

// Push a typed notice into the dropdown so it's reachable for the rest of
// the session. Duplicates (including the built-in defaults) are skipped.
function rememberNoticeOption(value) {
  for (const li of els.noticeOptions.querySelectorAll("li")) {
    if (li.dataset.value === value) return;
  }
  els.noticeOptions.insertBefore(makeNoticeOption(value), els.noticeOptions.firstChild);
}

/* -------------------------------------------------------------------------- */
layoutBoard();
setStatus("offline");
