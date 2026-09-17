/* Poor Man's Filament Tracker UI — all API paths relative for HA ingress. */
const $ = (sel) => document.querySelector(sel);

const state = {
  spools: [], usage: [], recent: [], status: null, catalog: null,
  showArchived: false, currency: "INR",
};

const CURRENCIES = [
  { code: "USD", symbol: "$", label: "$ USD" },
  { code: "EUR", symbol: "€", label: "€ EUR" },
  { code: "GBP", symbol: "£", label: "£ GBP" },
  { code: "INR", symbol: "₹", label: "₹ INR" },
  { code: "JPY", symbol: "¥", label: "¥ JPY" },
  { code: "CNY", symbol: "¥", label: "¥ CNY" },
  { code: "AUD", symbol: "A$", label: "A$ AUD" },
  { code: "CAD", symbol: "C$", label: "C$ CAD" },
  { code: "CHF", symbol: "Fr", label: "Fr CHF" },
  { code: "KRW", symbol: "₩", label: "₩ KRW" },
  { code: "BRL", symbol: "R$", label: "R$ BRL" },
  { code: "MXN", symbol: "$", label: "$ MXN" },
];
const currencySymbol = (code) => CURRENCIES.find((c) => c.code === code)?.symbol || code;

// Detection "note" values come from the server in English (internal keys used
// for logic/CSS matching) — this maps them to Japanese for display only.
const NOTE_JA = {
  "auto-select disabled": "自動選択は無効です",
  "no matching spool": "一致するスプールがありません",
  "multiple spools match — verify": "複数のスプールが一致しています — 要確認",
  "multiple spools match — using last loaded, please verify": "複数のスプールが一致 — 前回読み込んだものを使用中、確認してください",
  "matches loaded spool": "読み込み済みのスプールと一致",
  "match found, but not switching mid-print": "一致しましたが、印刷中は切り替えません",
  "auto-loaded": "自動で読み込みました",
  "verified by user": "確認済み",
  "loaded from Home Assistant": "Home Assistantから読み込み",
};
const noteJa = (n) => NOTE_JA[n] || n;

const KIND_JA = { print: "印刷", failed: "失敗", manual: "手動", adjust: "調整" };

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}
const post = (path, body) => api(path, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body || {}),
});
const put = (path, body) => api(path, {
  method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const fmt = (g) => (g >= 1000 ? (g / 1000).toFixed(2) + " kg" : Math.round(g * 10) / 10 + " g");
const fmtCost = (c) => currencySymbol(state.currency) + c.toFixed(2);
const pct = (s) => (s.initial_weight_g ? Math.max(0, Math.min(100, (100 * s.remaining_g) / s.initial_weight_g)) : 0);
// Cost isn't stored per print — derive it from the spool's cost/weight ratio at read time.
const rowCost = (u) => (u.spool_cost && u.spool_initial_weight_g ? (u.grams / u.spool_initial_weight_g) * u.spool_cost : null);
const spoolSpent = (s) => (s.cost && s.initial_weight_g ? Math.max(0, ((s.initial_weight_g - s.remaining_g) / s.initial_weight_g) * s.cost) : null);
const barClass = (p) => (p < 10 ? "bad" : p < 25 ? "warn" : "");
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const spoolLabel = (s) => `${s.brand} ${s.name}`.trim();

function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 3200);
}

async function refresh() {
  const archived = state.showArchived ? "?archived=1" : "";
  [state.spools, state.usage, state.recent, state.status] = await Promise.all([
    api("api/spools" + archived),
    api("api/usage"),
    api("api/usage?recent=1"),
    api("api/status"),
  ]);
  if (state.status?.currency) state.currency = state.status.currency;
  const sel = $("#currency-select");
  if (sel && document.activeElement !== sel) sel.value = state.currency;
  render();
}

function render() {
  renderPills();
  renderVerify();
  renderBanner();
  renderHero();
  renderDetection();
  renderSpools();
  renderRecent();
  renderHistory();
}

function pillHTML(title, sub) {
  return `<span class="dot"></span><span class="pl"><b>${esc(title)}</b><small>${esc(sub)}</small></span>`;
}

function renderPills() {
  const st = state.status || {};
  const printer = $("#pill-printer");
  printer.className = "pill " + (st.connected ? "on" : "off");
  printer.innerHTML = pillHTML(
    "プリンター",
    `${st.mode === "direct" ? "直接接続" : "HA経由"} · ${st.connected ? "オンライン" : "オフライン"}`
  );
  const haOn = st.ha_available || st.ha_control?.available;
  const ha = $("#pill-ha");
  ha.className = "pill " + (haOn ? "on" : "off");
  ha.innerHTML = pillHTML(
    "Home Assistant",
    haOn ? (st.ha_control?.available ? "同期+制御" : "同期のみ") : "オフライン"
  );
  if (st.ha_control?.entity_id) ha.title = st.ha_control.entity_id;
}

function renderVerify() {
  const el = $("#verify-card");
  const det = state.status?.detection;
  el.classList.toggle("hidden", !det?.ambiguous);
  if (!det?.ambiguous) return;
  const active = state.status?.active_spool;
  const cands = det.candidates.map((c) => `
    <button class="cand" onclick="confirmSpool(${c.id})">
      <span class="swatch xs" style="background:${esc(c.color_hex)}"></span>
      ${esc(c.label)} <span class="muted">· 残り${fmt(c.remaining_g)}</span>
      ${active && active.id === c.id ? " ✓ 現在選択中" : ""}
    </button>`).join("");
  el.innerHTML = `
    <div class="alert-title">⚠️ どのスプールをセットしましたか？</div>
    <div class="muted small">プリンターにセットされたフィラメントに一致するスプールが複数あります。
    確認するまで使用量は<b>${esc(active ? spoolLabel(active) : "スプールなし")}</b>に記録されます。</div>
    <div class="cands">${cands}</div>`;
}

function renderBanner() {
  const el = $("#print-banner");
  const p = state.status?.printer;
  const printing = p && ["prepare", "running", "pause", "slicing", "init"].includes(p.status);
  el.classList.toggle("hidden", !printing);
  if (!printing) return;
  el.innerHTML = `
    <span>🖨️</span>
    <b>${esc(p.task || "印刷中…")}</b>
    <div class="prog"><div class="bar"><div style="width:${Math.round(p.progress)}%"></div></div></div>
    <span class="num">${Math.round(p.progress)}%</span>
    <span class="muted small">${p.weight ? "推定 " + fmt(p.weight) : "重量取得中"}</span>`;
}

function renderHero() {
  const s = state.spools.find((x) => x.active && !x.archived);
  const el = $("#hero");
  if (!s) {
    el.innerHTML = `<div class="empty" style="width:100%">スプールが読み込まれていません — 追加して<b>読み込む</b>を押すか、プリンターにフィラメントをセットして自動検出させてください。</div>`;
    return;
  }
  const p = pct(s);
  el.innerHTML = `
    <div class="swatch lg" style="background:${esc(s.color_hex)}"></div>
    <div class="info">
      <div class="name">${esc(spoolLabel(s))}</div>
      <div class="sub">${esc(s.material)} · 外部スプールにセット中</div>
      <div class="bar ${barClass(p)}"><div style="width:${p}%"></div></div>
      <div class="nums"><b class="num">${fmt(s.remaining_g)}</b> / ${fmt(s.initial_weight_g)} · ${p.toFixed(0)}%</div>
    </div>
    <button class="btn small" onclick="openUse(${s.id})">使用量を記録</button>`;
}

function renderDetection() {
  const el = $("#detection");
  const det = state.status?.printer?.detected;
  const info = state.status?.detection || {};
  const show = det && !info.ambiguous;
  el.classList.toggle("hidden", !show);
  if (!show) return;
  const label = det.type || det.name || "?";
  el.className = "detect" + (info.note === "no matching spool" ? " warn" : "");
  el.innerHTML =
    `🎯 プリンターのフィラメント: ` +
    (det.color ? `<span class="swatch xs" style="background:${esc(det.color.slice(0, 7))}"></span>` : "") +
    `<b>${esc(label)}</b>` +
    (info.note ? `<span>— ${esc(noteJa(info.note))}</span>` : "");
}

function renderSpools() {
  $("#spools").innerHTML = state.spools.map((s) => {
    const p = pct(s);
    const spent = spoolSpent(s);
    return `
    <div class="spool ${s.active ? "active" : ""} ${s.archived ? "archived" : ""}">
      <div class="head">
        <div class="swatch sm" style="background:${esc(s.color_hex)}"></div>
        <div class="name">${esc(spoolLabel(s))}</div>
        <div class="tag ${s.active ? "loaded" : ""}">${s.active ? "セット中" : esc(s.material)}</div>
      </div>
      <div class="bar ${barClass(p)}"><div style="width:${p}%"></div></div>
      <div class="meta num">残り${fmt(s.remaining_g)} · ${esc(s.material)}${s.cost ? " · " + currencySymbol(state.currency) + s.cost : ""}</div>
      ${spent != null ? `<div class="meta num muted small">これまでに${fmtCost(spent)}使用</div>` : ""}
      <div class="btns">
        ${s.active ? "" : `<button class="btn small primary" onclick="activate(${s.id})">読み込む</button>`}
        <button class="btn small" onclick="openEdit(${s.id})">編集</button>
        <button class="btn small ghost" onclick="archive(${s.id}, ${s.archived ? "false" : "true"})">${s.archived ? "復元" : "アーカイブ"}</button>
        <button class="btn small ghost danger" onclick="removeSpool(${s.id})">削除</button>
      </div>
    </div>`;
  }).join("") || `<div class="card empty" style="grid-column:1/-1">スプールがありません — 最初の1本を追加しましょう。</div>`;
}

function usageRow(u, showEdit) {
  const zero = u.grams === 0 && (u.kind === "print" || u.kind === "failed");
  const cost = rowCost(u);
  return `
  <div class="rowitem">
    <span class="kind ${zero ? "zero" : esc(u.kind)}">${zero ? "0g？" : esc(KIND_JA[u.kind] || u.kind)}</span>
    <div class="job">${esc(u.job_name)}</div>
    <div class="spoolchip"><span class="swatch xs" style="background:${esc(u.color_hex)}"></span>${esc(u.brand)} ${esc(u.name)}</div>
    <div class="when">${new Date(u.ts).toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" })}</div>
    <div class="grams num">${u.grams < 0 ? "+" + fmt(-u.grams) : fmt(u.grams)}</div>
    <div class="cost num muted">${cost != null ? (cost < 0 ? "+" + fmtCost(-cost) : fmtCost(cost)) : ""}</div>
    ${showEdit ? `<button class="btn small ghost" title="編集 / 割り当て変更" onclick="openUsage(${u.id})">✎</button>` : ""}
  </div>`;
}

function renderRecent() {
  const el = $("#recent");
  const prints = state.recent.filter((u) => u.kind !== "adjust");
  const others = state.spools.filter((s) => !s.archived);
  $("#moveall").classList.toggle("hidden", !prints.length || others.length < 2);
  if (prints.length && others.length >= 2) {
    $("#moveall-select").innerHTML = others
      .map((s) => `<option value="${s.id}">${esc(spoolLabel(s))}</option>`).join("");
  }
  el.innerHTML = prints.map((u) => usageRow(u, true)).join("") ||
    `<div class="empty">現在のスプールを読み込んでから印刷はありません。</div>`;
}

function renderHistory() {
  $("#history").innerHTML = state.usage.map((u) => usageRow(u, u.kind !== "adjust")).join("") ||
    `<div class="empty">まだ何もありません — 印刷が完了すると表示されます。</div>`;
}

/* ---- actions ---- */
window.activate = async (id) => { await post(`api/spools/${id}/activate`); toast("スプールを読み込みました"); refresh(); };
window.confirmSpool = async (id) => { await post("api/detection/confirm", { spool_id: id }); toast("ありがとうございます — スプールを確認しました"); refresh(); };
window.archive = async (id, flag) => { await post(`api/spools/${id}/archive`, { archived: flag }); refresh(); };
window.removeSpool = async (id) => {
  const s = state.spools.find((x) => x.id === id);
  if (!confirm(`「${spoolLabel(s)}」と履歴を削除しますか？アーカイブすれば履歴は残ります。`)) return;
  await api(`api/spools/${id}`, { method: "DELETE" });
  refresh();
};

$("#moveall-btn").onclick = async () => {
  const target = parseInt($("#moveall-select").value);
  const prints = state.recent.filter((u) => u.kind !== "adjust" && u.spool_id !== target);
  for (const u of prints) await put(`api/usage/${u.id}`, { spool_id: target });
  toast(`${prints.length}件の印刷を移動しました`);
  refresh();
};

/* ---- spool dialog + swatch picker ---- */
const dialog = $("#spool-dialog"), form = $("#spool-form");

const GENERIC_MATERIALS = ["PLA+", "PLA", "PLA Matte", "PLA Silk", "PETG",
  "ABS", "ASA", "TPU", "PC", "PA", "その他"];

const brandColors = () =>
  (state.catalog?.brands || []).find((b) => b.name === form.brand.value)?.colors || [];

function fillBrands() {
  const brands = state.catalog?.brands || [];
  $("#brand-select").innerHTML = brands
    .map((b) => `<option>${esc(b.name)}</option>`).join("");
}

function fillMaterials(current) {
  const lines = [...new Set(brandColors().map((c) => c.line))];
  const opts = [...lines, ...GENERIC_MATERIALS.filter((m) => !lines.includes(m))];
  if (current && !opts.includes(current)) opts.unshift(current);
  form.material.innerHTML = opts.map((o) => `<option>${esc(o)}</option>`).join("");
  form.material.value = current || opts[0];
}

function renderSwatches() {
  const el = $("#swatches");
  const colors = brandColors();
  el.classList.toggle("hidden", !colors.length);
  if (!colors.length) return;
  // show only the selected material's swatches when the brand offers it
  const mat = form.material.value;
  const shown = colors.some((c) => c.line === mat)
    ? colors.filter((c) => c.line === mat) : colors;
  const lines = [...new Set(shown.map((c) => c.line))];
  el.innerHTML = lines.map((line) => `
    <div class="line-label">${esc(line)}</div>
    <div class="swatch-grid">
      ${shown.filter((c) => c.line === line).map((c) => `
        <button type="button" class="sw" title="${esc(c.name)}" data-name="${esc(c.name)}"
          data-line="${esc(c.line)}" data-hex="${esc(c.hex)}" style="background:${esc(c.hex)}"></button>
      `).join("")}
    </div>`).join("");
  el.querySelectorAll(".sw").forEach((btn) => {
    btn.onclick = () => {
      el.querySelectorAll(".sw.sel").forEach((b) => b.classList.remove("sel"));
      btn.classList.add("sel");
      form.color_hex.value = btn.dataset.hex;
      form.name.value = btn.dataset.name;
      form.material.value = btn.dataset.line;
    };
  });
}

$("#brand-select").onchange = () => { fillMaterials(); renderSwatches(); };
$("#material-select").onchange = renderSwatches;

$("#btn-add").onclick = () => {
  form.reset();
  form.id.value = "";
  form.brand.value = state.catalog?.brands?.some((b) => b.name === "Numakers") ? "Numakers" : form.brand.value;
  fillMaterials("PLA+");
  $("#dialog-title").textContent = "スプールを追加";
  renderSwatches();
  dialog.showModal();
};

window.openEdit = (id) => {
  const s = state.spools.find((x) => x.id === id);
  form.reset();
  form.brand.value = [...form.brand.options].some((o) => o.value === s.brand) ? s.brand : "その他";
  fillMaterials(s.material);
  for (const f of ["id", "name", "color_hex", "initial_weight_g", "remaining_g", "cost", "notes"])
    if (form[f] && s[f] != null) form[f].value = s[f];
  $("#dialog-title").textContent = "スプールを編集";
  renderSwatches();
  dialog.showModal();
};

$("#btn-cancel").onclick = () => dialog.close();

form.onsubmit = async (e) => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(form));
  const body = {
    brand: d.brand, name: d.name, material: d.material, color_hex: d.color_hex,
    initial_weight_g: parseFloat(d.initial_weight_g) || 1000,
    notes: d.notes || "",
  };
  if (d.remaining_g !== "") body.remaining_g = parseFloat(d.remaining_g);
  body.cost = d.cost === "" ? null : parseFloat(d.cost);  // null clears a saved cost
  if (d.id) await put(`api/spools/${d.id}`, body);
  else await post("api/spools", body);
  dialog.close();
  toast(d.id ? "スプールを更新しました" : "スプールを追加しました");
  refresh();
};

/* ---- manual usage dialog ---- */
const useDialog = $("#use-dialog"), useForm = $("#use-form");
window.openUse = (id) => { useForm.reset(); useForm.id.value = id; useDialog.showModal(); };
$("#btn-use-cancel").onclick = () => useDialog.close();
useForm.onsubmit = async (e) => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(useForm));
  await post(`api/spools/${d.id}/use`, { grams: parseFloat(d.grams), job_name: d.job_name || "手動入力" });
  useDialog.close();
  refresh();
};

/* ---- edit print dialog ---- */
const usageDialog = $("#usage-dialog"), usageForm = $("#usage-form");
window.openUsage = (id) => {
  const u = [...state.usage, ...state.recent].find((x) => x.id === id);
  if (!u) return;
  usageForm.reset();
  usageForm.id.value = id;
  usageForm.grams.value = u.grams;
  $("#usage-job").textContent = `${u.job_name} · ${new Date(u.ts).toLocaleString("ja-JP")}`;
  usageForm.spool_id.innerHTML = state.spools
    .filter((s) => !s.archived || s.id === u.spool_id)
    .map((s) => `<option value="${s.id}" ${s.id === u.spool_id ? "selected" : ""}>${esc(spoolLabel(s))}</option>`)
    .join("");
  usageDialog.showModal();
};
$("#btn-usage-cancel").onclick = () => usageDialog.close();
usageForm.onsubmit = async (e) => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(usageForm));
  await put(`api/usage/${d.id}`, { grams: parseFloat(d.grams), spool_id: parseInt(d.spool_id) });
  usageDialog.close();
  toast("印刷情報を更新しました");
  refresh();
};

$("#show-archived").onchange = (e) => { state.showArchived = e.target.checked; refresh(); };

/* ---- theme ---- */
const themeBtn = $("#theme-toggle");
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem("pmft-theme", t);
  themeBtn.textContent = t === "light" ? "🌙" : "☀️";
}
setTheme(localStorage.getItem("pmft-theme") ||
  (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
themeBtn.onclick = () =>
  setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");

/* ---- currency ---- */
const currencySelect = $("#currency-select");
currencySelect.innerHTML = CURRENCIES
  .map((c) => `<option value="${c.code}">${esc(c.label)}</option>`).join("");
currencySelect.onchange = async () => {
  state.currency = currencySelect.value;
  render();
  await post("api/settings/currency", { currency: state.currency });
  toast(`通貨を${currencySelect.value}に設定しました`);
};

/* ---- boot ---- */
(async () => {
  try { state.catalog = await api("api/catalog"); } catch { state.catalog = { brands: [] }; }
  fillBrands();
  fillMaterials("PLA+");
  await refresh();
})();
setInterval(() => refresh().catch(() => {}), 8000);
