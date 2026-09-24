const $ = (s, r = document) => r.querySelector(s);
const NATIVE = typeof AndroidBridge !== "undefined";
const httpWaiters = {};
window.__httpDone = function (id, ok, text) {
  const w = httpWaiters[id];
  if (!w) return;
  delete httpWaiters[id];
  if (ok) w.resolve(text);
  else w.reject(new Error(text || "فشل الاتصال"));
};
const state = {
  mode: "xtream",
  server: "", username: "", password: "", m3u: "",
  userInfo: null,
  section: "home", kind: "live",
  catalog: { live: { categories: [], items: [] }, vod: { categories: [], items: [] }, series: { categories: [], items: [] } },
  packageId: null, packageName: "", query: "", playIndex: -1, listLimit: 40,
  playerUi: false, hideTimer: null, subIndex: -1, currentUrl: "", liveNav: false, seeking: false,
  favorites: JSON.parse(localStorage.getItem("xtream_favs") || "[]"),
  subCues: [], subTracks: []
};

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("xtream_cache_v3", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function cacheGet(key) {
  try {
    const db = await idb();
    return await new Promise((resolve) => {
      const r = db.transaction("kv").objectStore("kv").get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    });
  } catch (e) { return null; }
}
async function cacheSet(key, val) {
  try {
    const db = await idb();
    await new Promise((resolve) => {
      const r = db.transaction("kv", "readwrite").objectStore("kv").put(val, key);
      r.onsuccess = () => resolve();
      r.onerror = () => resolve();
    });
  } catch (e) {}
}

function cleanUrl(raw) {
  return String(raw || "").replace(/[\u200e\u200f\u202a-\u202e]/g, "").replace(/\s+/g, "").trim();
}
function normalizeServer(raw) {
  let s = cleanUrl(raw);
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  return s.replace(/\/+$/, "");
}
function xtreamFromM3u(url) {
  try {
    const u = new URL(cleanUrl(url));
    const user = u.searchParams.get("username");
    const pass = u.searchParams.get("password");
    if (user && pass) {
      return { server: u.origin, username: user, password: pass };
    }
  } catch (e) {}
  return null;
}
function xtreamApi(action, extra) {
  extra = extra || {};
  const u = new URL(state.server + "/player_api.php");
  u.searchParams.set("username", state.username);
  u.searchParams.set("password", state.password);
  if (action) u.searchParams.set("action", action);
  Object.keys(extra).forEach((k) => {
    if (extra[k] !== undefined && extra[k] !== null && extra[k] !== "") u.searchParams.set(k, String(extra[k]));
  });
  return u.toString();
}
function friendlyErr(msg) {
  const m = String(msg || "");
  if (/404/.test(m)) return "الرابط مش موجود (404). اكتب سيرفر Xtream كامل: http://الدومين:البورت";
  if (/401|403/.test(m)) return "اليوزر أو الباسورد غلط";
  if (/Unable to resolve|UnknownHost|failed to connect|Network/i.test(m)) return "مفيش اتصال بالسيرفر. راجع الرابط والنت";
  if (/malformed|Invalid URL|expected scheme/i.test(m)) return "الرابط ناقص. الصق الرابط كامل من أوله";
  return m;
}
function rawGet(url) {
  url = cleanUrl(url);
  if (!(NATIVE && AndroidBridge.httpGetAsync)) {
    return rawGetWeb(url);
  }
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error("السيرفر متأخر. جرّب Xtream أو نت أقوى"));
    }, 12000);
    const id = AndroidBridge.httpGetAsync(url);
    httpWaiters[id] = {
      resolve: (text) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (!text) return reject(new Error("رد فاضي من السيرفر"));
        if (String(text).indexOf("ERR:") === 0) return reject(new Error(friendlyErr(text.slice(4) || "فشل الاتصال")));
        resolve(text);
      },
      reject: (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error(friendlyErr(e.message || e)));
      }
    };
  });
}
async function rawGetWeb(url) {
  const direct = async () => {
    const res = await fetch(url, { mode: "cors" });
    const text = await res.text();
    if (!res.ok) throw new Error(friendlyErr(text || ("HTTP " + res.status)));
    return text;
  };
  const local = location.protocol === "file:" || location.hostname === "127.0.0.1" || location.hostname === "localhost";
  const hosted = location.protocol !== "file:" && !/github\.io$/i.test(location.hostname || "");
  if (local || location.port === "8787" || hosted) {
    try {
      if (url.indexOf("player_api.php") !== -1) {
        const src = new URL(url);
        const p = new URL("/api", location.origin);
        p.searchParams.set("server", src.origin);
        ["username", "password", "action", "category_id", "stream_id", "vod_id", "series_id", "limit"].forEach((k) => {
          const v = src.searchParams.get(k);
          if (v) p.searchParams.set(k, v);
        });
        const res = await fetch(p.toString());
        const text = await res.text();
        if (!res.ok) throw new Error(friendlyErr(text || ("HTTP " + res.status)));
        return text;
      }
      const proxy = new URL("/fetch", location.origin);
      proxy.searchParams.set("url", url);
      const res = await fetch(proxy.toString());
      const text = await res.text();
      if (!res.ok) throw new Error(friendlyErr(text || ("HTTP " + res.status)));
      return text;
    } catch (e) {
      return direct();
    }
  }
  return direct();
}
async function rawGetRetry(url) {
  try { return await rawGet(url); }
  catch (e1) {
    if (/^http:\/\//i.test(url)) {
      try { return await rawGet(url.replace(/^http:\/\//i, "https://")); } catch (e2) { throw e1; }
    }
    if (/^https:\/\//i.test(url)) {
      try { return await rawGet(url.replace(/^https:\/\//i, "http://")); } catch (e2) { throw e1; }
    }
    throw e1;
  }
}
async function api(action, extra) {
  const text = await rawGetRetry(xtreamApi(action, extra));
  try { return JSON.parse(text); } catch (e) { throw new Error("السيرفر رجّع بيانات غير صحيحة"); }
}
function hostedProxy() {
  try {
    return typeof location !== "undefined" && location.protocol !== "file:" && !/github\.io$/i.test(location.hostname || "");
  } catch (e) { return false; }
}
function proxiedMedia(url) {
  if (!url || !hostedProxy()) return url;
  if (/^https?:\/\//i.test(url) && url.indexOf(location.origin) !== 0) {
    return location.origin + "/stream?url=" + encodeURIComponent(url);
  }
  return url;
}
function streamUrl(kind, id, ext, direct) {
  if (direct) return proxiedMedia(direct);
  const folder = kind === "live" ? "live" : kind === "movie" ? "movie" : "series";
  const e = String(ext || (kind === "live" ? "m3u8" : "mp4")).replace(".", "");
  const url = state.server + "/" + folder + "/" + encodeURIComponent(state.username) + "/" + encodeURIComponent(state.password) + "/" + id + "." + e;
  return proxiedMedia(url);
}
function keyOf(section, it) { return section + ":" + (it.stream_id || it.series_id || it.url || it.name); }
function isFav(k) { return state.favorites.indexOf(k) !== -1; }
function toggleFav(k, ev) {
  if (ev) ev.stopPropagation();
  if (isFav(k)) state.favorites = state.favorites.filter((x) => x !== k);
  else state.favorites.push(k);
  localStorage.setItem("xtream_favs", JSON.stringify(state.favorites));
  if (state.section === "list") renderList();
  else if (state.section === "packages") renderPackages();
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function yearOf(it) { const raw = it.releaseDate || it.releasedate || it.year || ""; const m = String(raw).match(/(19|20)\d{2}/); return m ? m[0] : ""; }
function ratingNum(it) { const a = parseFloat(it.rating_5based); if (!isNaN(a) && a > 0) return a; const b = parseFloat(it.rating); if (!isNaN(b) && b > 0) return b > 5 ? b / 2 : b; return 0; }
function ratingText(it) { const n = ratingNum(it); return n ? (n.toFixed(1) + " / 5") : "بدون تقييم"; }
function stars(n) { const full = Math.round(n); return "★★★★★".slice(0, Math.max(0, Math.min(5, full))) + "☆☆☆☆☆".slice(0, 5 - Math.max(0, Math.min(5, full))); }
function posterOf(it) {
  let u = it.stream_icon || it.cover || it.logo || "";
  if (!u) return "";
  u = String(u).trim();
  if (typeof location !== "undefined" && location.protocol === "https:" && /^http:\/\//i.test(u)) {
    return "https://images.weserv.nl/?url=" + encodeURIComponent(u) + "&w=360&output=jpg";
  }
  return u;
}

function setMode(mode) {
  state.mode = mode;
  $("#mode-xtream").classList.toggle("on", mode === "xtream");
  $("#mode-m3u").classList.toggle("on", mode === "m3u");
  $("#box-xtream").classList.toggle("hidden", mode !== "xtream");
  $("#box-m3u").classList.toggle("hidden", mode !== "m3u");
}
$("#mode-xtream").addEventListener("click", () => setMode("xtream"));
$("#mode-m3u").addEventListener("click", () => setMode("m3u"));

function setHeader(title, sub, showSearch) {
  $("#page-title").textContent = title;
  $("#page-sub").textContent = sub || "";
  $("#search-wrap").classList.toggle("hidden", !showSearch);
  const home = state.section === "home";
  $("#back-btn").textContent = home ? "خروج" : "رجوع";
  $("#back-btn").classList.toggle("ghost", home);
}

function parseAttr(line, key) {
  const m = line.match(new RegExp(key + '="([^"]*)"', "i"));
  return m ? m[1] : "";
}
function guessKind(group, name) {
  const t = ((group || "") + " " + (name || "")).toLowerCase();
  if (/series|مسلسل|seasons?|episode|حلق/.test(t)) return "series";
  if (/movie|vod|فيلم|افلام|أفلام|cinema/.test(t)) return "vod";
  return "live";
}
function parseM3U(text) {
  const lines = String(text).split(/\r?\n/);
  const buckets = { live: [], vod: [], series: [] };
  let info = null;
  let n = 1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.indexOf("#EXTINF") === 0) {
      const name = line.split(",").slice(1).join(",").trim() || parseAttr(line, "tvg-name") || ("قناة " + n);
      info = {
        name: name,
        logo: parseAttr(line, "tvg-logo") || parseAttr(line, "logo"),
        group: parseAttr(line, "group-title") || "عام"
      };
    } else if (line.charAt(0) !== "#" && info) {
      const kind = guessKind(info.group, info.name);
      buckets[kind].push({
        num: n++,
        name: info.name,
        stream_icon: info.logo,
        cover: info.logo,
        logo: info.logo,
        category_name: info.group,
        category_id: info.group,
        url: line,
        stream_id: n,
        series_id: n
      });
      info = null;
    }
  }
  const pack = {};
  Object.keys(buckets).forEach((kind) => {
    const items = buckets[kind];
    const map = {};
    items.forEach((it) => { map[it.category_id] = it.category_name; });
    pack[kind] = {
      categories: Object.keys(map).map((id) => ({ category_id: id, category_name: map[id] })),
      items: items
    };
  });
  return pack;
}

async function loadXtreamKind(kind) {
  const map = {
    live: "get_live_categories",
    vod: "get_vod_categories",
    series: "get_series_categories"
  };
  const cats = await api(map[kind]);
  const prev = state.catalog[kind] || { categories: [], items: [] };
  state.catalog[kind] = { categories: Array.isArray(cats) ? cats : [], items: prev.items || [], loadedCat: prev.loadedCat || "" };
  cacheSet("cat_" + kind, { categories: state.catalog[kind].categories, items: [] });
}
async function loadXtreamPackage(kind, catId) {
  const map = {
    live: "get_live_streams",
    vod: "get_vod_streams",
    series: "get_series"
  };
  if (!catId || catId === "*" || catId === "fav") return [];
  const items = await api(map[kind], { category_id: catId });
  const list = Array.isArray(items) ? items : [];
  const cur = state.catalog[kind] || { categories: [], items: [] };
  cur.items = list;
  cur.loadedCat = String(catId);
  state.catalog[kind] = cur;
  cacheSet("cat_" + kind, { categories: cur.categories, items: [], loadedCat: "" });
  return list;
}
async function loadM3UCatalog() {
  const text = await rawGetRetry(state.m3u);
  if (text.indexOf("#EXTM3U") === -1 && text.indexOf("#EXTINF") === -1) throw new Error("الملف مش قائمة M3U صحيحة");
  const pack = parseM3U(text);
  state.catalog = pack;
  cacheSet("cat_all_m3u", pack);
}

function saveSession() {
  localStorage.setItem("xtream_session", JSON.stringify({
    mode: state.mode, server: state.server, username: state.username, password: state.password, m3u: state.m3u, auto: true
  }));
}

async function afterLogin() {
  $("#login-screen").classList.add("hidden");
  $("#app-screen").classList.remove("hidden");
  showHome();
}

async function doLogin(fromAuto) {
  const err = $("#login-error");
  err.classList.add("hidden");
  const btn = $("#login-btn");
  btn.disabled = true;
  btn.textContent = "جاري الدخول...";
  if (fromAuto) $("#boot-msg").classList.remove("hidden");
  try {
    if (state.mode === "m3u") {
      state.m3u = cleanUrl($("#m3u").value || state.m3u || "");
      if (!state.m3u) throw new Error("اكتب رابط الـ M3U");
      if (!/^https?:\/\//i.test(state.m3u)) {
        throw new Error("الرابط ناقص. الصق الرابط كامل زي http://server:port/get.php?username=...&password=...&type=m3u_plus");
      }
      const extracted = xtreamFromM3u(state.m3u);
      if (extracted) {
        state.mode = "xtream";
        state.server = extracted.server;
        state.username = extracted.username;
        state.password = extracted.password;
        $("#server").value = state.server;
        $("#username").value = state.username;
        $("#password").value = state.password;
        setMode("xtream");
        const data = await api("");
        if (!data || !data.user_info || String(data.user_info.auth) === "0") {
          throw new Error(data && data.user_info && data.user_info.status === "Expired" ? "الاشتراك منتهي" : "بيانات الدخول غير صحيحة");
        }
        state.userInfo = data;
      } else {
        const cached = await cacheGet("cat_all_m3u");
        if (cached) state.catalog = cached;
        state.userInfo = { user_info: { username: "M3U", exp_date: null } };
        if (!cached) await loadM3UCatalog();
        else loadM3UCatalog().catch(() => {});
      }
    } else {
      state.server = normalizeServer($("#server").value || state.server);
      state.username = ($("#username").value || state.username || "").trim();
      state.password = ($("#password").value || state.password || "").trim();
      if (!state.server || !state.username || !state.password) throw new Error("كمّل بيانات Xtream");
      const cachedLive = await cacheGet("cat_live");
      const cachedVod = await cacheGet("cat_vod");
      const cachedSeries = await cacheGet("cat_series");
      if (cachedLive) state.catalog.live = cachedLive;
      if (cachedVod) state.catalog.vod = cachedVod;
      if (cachedSeries) state.catalog.series = cachedSeries;
      const data = await api("");
      if (!data || !data.user_info || String(data.user_info.auth) === "0") {
        throw new Error(data && data.user_info && data.user_info.status === "Expired" ? "الاشتراك منتهي" : "بيانات الدخول غير صحيحة");
      }
      state.userInfo = data;
    }
    saveSession();
    await afterLogin();
    if (state.mode === "xtream") {
      Promise.all([loadXtreamKind("live"), loadXtreamKind("vod"), loadXtreamKind("series")]).then(() => {
        if (state.section === "home") showHome();
      }).catch(() => {});
    }
  } catch (ex) {
    err.textContent = friendlyErr(ex.message || "تعذر تسجيل الدخول");
    err.classList.remove("hidden");
    $("#login-screen").classList.remove("hidden");
    $("#app-screen").classList.add("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "دخول";
    $("#boot-msg").classList.add("hidden");
  }
}

$("#login-form").addEventListener("submit", (e) => { e.preventDefault(); doLogin(false); });
$("#logout-btn").addEventListener("click", () => { localStorage.removeItem("xtream_session"); location.reload(); });
function openCastScreen() {
  if (NATIVE && AndroidBridge.openCast) {
    try { AndroidBridge.openCast(); } catch (e) {}
  }
}
if ($("#cast-btn")) $("#cast-btn").addEventListener("click", openCastScreen);
$("#back-btn").addEventListener("click", goBack);
$("#search").addEventListener("input", (e) => {
  state.query = e.target.value.trim().toLowerCase();
  if (state.section === "list") renderList();
  if (state.section === "packages") renderPackages();
});

function isTyping() {
  const el = document.activeElement;
  return !!(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA"));
}
function goBack() {
  if (isTyping()) { document.activeElement.blur(); return "blur"; }
  if (!$("#license-screen").classList.contains("hidden")) return "license";
  if (!$("#login-screen").classList.contains("hidden") && $("#app-screen").classList.contains("hidden")) return "login";
  if (!$("#sheet").classList.contains("hidden")) { $("#sheet").classList.add("hidden"); return "sheet"; }
  if (!$("#player-modal").classList.contains("hidden")) { closePlayer(); return "player"; }
  if (state.section === "list") { showPackages(state.kind); return "packages"; }
  if (state.section === "packages") { showHome(); return "home"; }
  if (NATIVE && AndroidBridge.exitApp) AndroidBridge.exitApp();
  return "exit";
}
window.goBack = goBack;

function showHome() {
  state.section = "home"; state.query = ""; $("#search").value = "";
  const u = (state.userInfo && state.userInfo.user_info) || {};
  const exp = u.exp_date ? new Date(Number(u.exp_date) * 1000).toLocaleDateString("ar-EG") : (state.mode === "m3u" ? "قائمة M3U" : "—");
  setHeader("الرئيسية", "مرحباً " + (u.username || state.username || "M3U"), false);
  $("#page").innerHTML = '<div class="hello"><h3>Michel</h3><p class="ltr" dir="ltr">01223531334</p><h3>اختار نوع المحتوى</h3><p>' + esc(String(exp)) + '</p></div><div class="home-grid">' +
    tile("live", "بث مباشر", (state.catalog.live.categories.length || "باقات") + (state.catalog.live.categories.length ? " باقة" : "")) +
    tile("vod", "أفلام", (state.catalog.vod.categories.length || "باقات") + (state.catalog.vod.categories.length ? " باقة" : "")) +
    tile("series", "مسلسلات", (state.catalog.series.categories.length || "باقات") + (state.catalog.series.categories.length ? " باقة" : "")) + "</div>";
  $("#page").querySelectorAll("[data-kind]").forEach((b) => b.addEventListener("click", () => showPackages(b.dataset.kind)));
}
function tile(kind, title, sub) {
  const ic = kind === "live" ? "▶" : kind === "vod" ? "★" : "▣";
  return '<button class="home-tile" data-kind="' + kind + '"><div class="ic">' + ic + "</div><div><h3>" + title + "</h3><p>" + sub + "</p></div></button>";
}
const KIND_META = { live: { title: "الباقات", label: "محطة" }, vod: { title: "باقات الأفلام", label: "فيلم" }, series: { title: "باقات المسلسلات", label: "مسلسل" } };

async function showPackages(kind) {
  state.kind = kind; state.section = "packages"; state.packageId = null; state.query = ""; $("#search").value = "";
  setHeader(KIND_META[kind].title, "دوس على الباقة", true);
  if (state.mode === "xtream" && !catsOf().length) {
    $("#page").innerHTML = '<div class="loading">جاري تحميل الباقات...</div>';
    try { await loadXtreamKind(kind); } catch (ex) { $("#page").innerHTML = '<div class="empty">' + esc(ex.message) + "</div>"; return; }
  }
  renderPackages();
}
function itemsOf() { return (state.catalog[state.kind] && state.catalog[state.kind].items) || []; }
function catsOf() { return (state.catalog[state.kind] && state.catalog[state.kind].categories) || []; }
function matchCat(it, catId) {
  if (String(it.category_id) === String(catId)) return true;
  return (it.category_ids || []).map(String).indexOf(String(catId)) !== -1;
}
function countIn(catId) {
  const cur = state.catalog[state.kind] || {};
  if (String(cur.loadedCat) !== String(catId)) return 0;
  return itemsOf().filter((it) => matchCat(it, catId)).length;
}
function renderPackages() {
  const q = state.query;
  const all = itemsOf();
  const favs = all.filter((it) => isFav(keyOf(state.kind, it)));
  let cats = catsOf().slice();
  if (q) cats = cats.filter((c) => (c.category_name || "").toLowerCase().indexOf(q) !== -1);
  const rows = [pkgBtn("fav", "المفضلة", favs.length || "", true)];
  cats.forEach((c) => rows.push(pkgBtn(String(c.category_id), c.category_name || "باقة", countIn(c.category_id) || "", false)));
  $("#page").innerHTML = '<div class="pkg-grid">' + rows.join("") + "</div>";
  $("#page").querySelectorAll(".pkg").forEach((b) => b.addEventListener("click", () => openPackage(b.dataset.id, b.dataset.name)));
}
function pkgBtn(id, name, count, fav) {
  return '<button class="pkg' + (fav ? " fav" : "") + '" data-id="' + esc(id) + '" data-name="' + esc(name) + '"><div><h3>' + esc(name) + '</h3></div><div class="count">' + count + "</div></button>";
}
function isAdultName(name) {
  const t = String(name || "").toLowerCase();
  return /adult|xxx|\+18|18\+|porn|sex|اباح|كبار|للكبار|ادلت|أدلت/.test(t);
}
function askAdultPin() {
  return new Promise((resolve) => {
    if (sessionStorage.getItem("michel_adult") === "1") { resolve(true); return; }
    $("#adult-pin").value = "";
    $("#adult-err").classList.add("hidden");
    $("#adult-lock").classList.remove("hidden");
    const ok = () => {
      const pin = ($("#adult-pin").value || "").trim();
      if (pin === "0000" || pin === "1234") {
        sessionStorage.setItem("michel_adult", "1");
        cleanup();
        resolve(true);
      } else {
        $("#adult-err").textContent = "الرقم غلط";
        $("#adult-err").classList.remove("hidden");
      }
    };
    const no = () => { cleanup(); resolve(false); };
    const cleanup = () => {
      $("#adult-lock").classList.add("hidden");
      $("#adult-ok").removeEventListener("click", ok);
      $("#adult-cancel").removeEventListener("click", no);
    };
    $("#adult-ok").addEventListener("click", ok);
    $("#adult-cancel").addEventListener("click", no);
  });
}
async function openPackage(id, name) {
  if (isAdultName(name) && !(await askAdultPin())) return;
  state.packageId = id; state.packageName = name; state.section = "list"; state.query = ""; state.listLimit = 40; $("#search").value = "";
  setHeader(name, KIND_META[state.kind].label, true);
  if (state.mode === "xtream" && id !== "fav") {
    const cur = state.catalog[state.kind] || {};
    const have = String(cur.loadedCat) === String(id) && itemsOf().length;
    if (!have) {
      $("#page").innerHTML = '<div class="loading">جاري تحميل المحتوى...</div>';
      try { await loadXtreamPackage(state.kind, id); }
      catch (ex) { $("#page").innerHTML = '<div class="empty">' + esc(ex.message) + "</div>"; return; }
    }
  }
  renderList();
}
function currentList() {
  let list = itemsOf();
  if (state.packageId === "fav") list = list.filter((it) => isFav(keyOf(state.kind, it)));
  else if (state.packageId && state.packageId !== "*") list = list.filter((it) => matchCat(it, state.packageId));
  if (state.query) list = list.filter((it) => (it.name || "").toLowerCase().indexOf(state.query) !== -1);
  if (list.length <= 400) {
    if (state.kind !== "live") list = list.slice().sort((a, b) => ratingNum(b) - ratingNum(a) || String(a.name || "").localeCompare(String(b.name || ""), "ar"));
    else list = list.slice().sort((a, b) => (Number(a.num) || 0) - (Number(b.num) || 0));
  }
  return list;
}
function renderList() {
  const list = currentList();
  if (!list.length) { $("#page").innerHTML = '<div class="empty">لا توجد نتائج في الباقة دي</div>'; return; }
  const shown = list.slice(0, state.listLimit);
  let html = "";
  if (state.kind === "live") {
    html = '<div class="ch-list">' + shown.map((it, i) => {
      const k = keyOf("live", it); const img = posterOf(it);
      return '<button class="ch" data-i="' + i + '"><div class="logo" style="' + (img ? "background-image:url('" + img.replace(/'/g, "%27") + "')" : "") + '"></div><div class="info"><h3>' + esc(it.name) + "</h3><p>محطة " + (it.num || i + 1) + '</p></div><span class="star ' + (isFav(k) ? "on" : "") + '" data-fav="' + k + '">★</span></button>';
    }).join("") + "</div>";
  } else {
    html = '<div class="vod-grid">' + shown.map((it, i) => {
      const n = ratingNum(it); const img = posterOf(it);
      return '<button class="vod" data-i="' + i + '"><div class="poster" style="' + (img ? "background-image:url('" + img.replace(/'/g, "%27") + "')" : "") + '">' + (n ? '<span class="badge">★ ' + n.toFixed(1) + "</span>" : '<span class="badge">بدون تقييم</span>') + '</div><div class="meta"><h3>' + esc(it.name) + "</h3><p>" + esc(ratingText(it)) + (yearOf(it) ? " • " + yearOf(it) : "") + "</p></div></button>";
    }).join("") + "</div>";
  }
  if (list.length > shown.length) html += '<button class="btn btn-gold" id="more-btn" type="button">عرض المزيد (' + (list.length - shown.length) + ")</button>";
  $("#page").innerHTML = html;
  $("#page").querySelectorAll("[data-i]").forEach((b) => b.addEventListener("click", () => openItem(currentList()[Number(b.dataset.i)], Number(b.dataset.i))));
  $("#page").querySelectorAll("[data-fav]").forEach((b) => b.addEventListener("click", (e) => toggleFav(b.dataset.fav, e)));
  const more = $("#more-btn");
  if (more) more.addEventListener("click", () => { state.listLimit += 40; renderList(); });
}
async function openItem(it, index) {
  if (state.kind === "live") { playLive(index); return; }
  if (state.kind === "vod") { showMovie(it); return; }
  await showSeries(it);
}
function itemUrl(kind, it) {
  if (it.url) return it.url;
  if (kind === "live") return streamUrl("live", it.stream_id, "m3u8");
  if (kind === "vod") return streamUrl("movie", it.stream_id, it.container_extension || "mp4");
  return streamUrl("series", it.stream_id || it.id, it.container_extension || "mp4");
}
function playLive(index) {
  const list = currentList();
  if (index < 0 || index >= list.length) return;
  state.playIndex = index;
  const it = list[index];
  play(it.name, itemUrl("live", it), true);
  if (it.stream_id && state.mode === "xtream") loadEpg(it.stream_id);
  renderPlayerMenus();
}
function showMovie(it) {
  const img = posterOf(it); const n = ratingNum(it);
  $("#sheet").classList.remove("hidden");
  $("#sheet-body").innerHTML = '<div class="detail-top"><div class="detail-poster" style="' + (img ? "background-image:url('" + img.replace(/'/g, "%27") + "')" : "") + '"></div><div><h2>' + esc(it.name) + '</h2><p class="stars">' + stars(n) + "</p><p>" + esc(ratingText(it)) + (yearOf(it) ? " • " + yearOf(it) : "") + "</p><p>" + esc(it.genre || it.category_name || "") + "</p></div></div><p>" + esc(it.plot || it.description || "لا يوجد وصف") + '</p><button class="btn btn-play" id="play-now">تشغيل الفيلم</button>';
  $("#play-now").addEventListener("click", () => { $("#sheet").classList.add("hidden"); play(it.name, itemUrl("vod", it), false, { kind: "vod", id: it.stream_id || it.vod_id }); renderPlayerMenus(); });
}
async function showSeries(it) {
  $("#sheet").classList.remove("hidden");
  if (it.url) {
    $("#sheet-body").innerHTML = "<h2>" + esc(it.name) + '</h2><button class="btn btn-play" id="play-now">تشغيل</button>';
    $("#play-now").addEventListener("click", () => { $("#sheet").classList.add("hidden"); play(it.name, it.url, false); });
    return;
  }
  $("#sheet-body").innerHTML = '<div class="loading">جاري تحميل المسلسل...</div>';
  try {
    const data = await api("get_series_info", { series_id: it.series_id });
    const info = Object.assign({}, it, data.info || {});
    const episodes = data.episodes || {};
    const seasons = Object.keys(episodes).sort((a, b) => Number(a) - Number(b));
    let current = seasons[0];
    const n = ratingNum(info); const img = posterOf(info) || posterOf(it);
    const draw = () => {
      const eps = episodes[current] || [];
      $("#sheet-body").innerHTML = '<div class="detail-top"><div class="detail-poster" style="' + (img ? "background-image:url('" + img.replace(/'/g, "%27") + "')" : "") + '"></div><div><h2>' + esc(it.name) + '</h2><p class="stars">' + stars(n) + "</p><p>" + esc(ratingText(info)) + (yearOf(info) ? " • " + yearOf(info) : "") + "</p><p>" + esc(info.genre || "") + "</p></div></div><p>" + esc(info.plot || info.description || "لا يوجد وصف") + '</p><div class="seasons">' + seasons.map((s) => '<button class="chip' + (s === current ? " active" : "") + '" data-s="' + s + '">موسم ' + s + "</button>").join("") + "</div>" + eps.map((ep) => '<button class="episode" data-id="' + ep.id + '" data-ext="' + (ep.container_extension || "mp4") + '">' + esc(ep.title || ("حلقة " + ep.episode_num)) + "</button>").join("");
      $("#sheet-body").querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => { current = c.dataset.s; draw(); }));
      $("#sheet-body").querySelectorAll(".episode").forEach((b) => b.addEventListener("click", () => { $("#sheet").classList.add("hidden"); play(it.name + " — " + b.textContent, streamUrl("series", b.dataset.id, b.dataset.ext), false, { kind: "series", id: b.dataset.id }); }));
    };
    draw();
  } catch (ex) { $("#sheet-body").innerHTML = '<div class="empty">' + esc(ex.message) + "</div>"; }
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return "00:00";
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const two = (n) => (n < 10 ? "0" + n : "" + n);
  return h ? h + ":" + two(m) + ":" + two(s) : two(m) + ":" + two(s);
}
function seekBy(delta) {
  const video = $("#video");
  if (state.liveNav) return;
  const cur = video.currentTime || 0;
  const d = isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  let next = cur + delta;
  if (next < 0) next = 0;
  if (d && next > d - 0.3) next = Math.max(0, d - 0.5);
  try { video.currentTime = next; } catch (e) {}
  updateSeek();
  showToolbar(true);
}
function updateSeek() {
  const video = $("#video");
  const d = isFinite(video.duration) ? video.duration : 0;
  $("#tcur").textContent = fmtTime(video.currentTime || 0);
  $("#tdur").textContent = d ? fmtTime(d) : "--:--";
  if (!state.seeking && d) $("#seek").value = String(Math.round((video.currentTime / d) * 1000));
}
function play(title, url, liveNav, media) {
  $("#player-modal").classList.remove("hidden");
  $("#player-title").textContent = title;
  $("#tb-title").textContent = title;
  state.liveNav = !!liveNav;
  state.subCues = [];
  state.subTracks = [];
  const overlay = $("#sub-overlay");
  if (overlay) overlay.textContent = "";
  $("#prev-btn").style.visibility = liveNav ? "visible" : "hidden";
  $("#next-btn").style.visibility = liveNav ? "visible" : "hidden";
  $("#tb-prev").style.visibility = liveNav ? "visible" : "hidden";
  $("#tb-next").style.visibility = liveNav ? "visible" : "hidden";
  $("#tb-rew").style.display = liveNav ? "none" : "";
  $("#tb-fwd").style.display = liveNav ? "none" : "";
  $("#tb-rew30").style.display = liveNav ? "none" : "";
  $("#tb-fwd30").style.display = liveNav ? "none" : "";
  $("#seek-wrap").style.display = liveNav ? "none" : "flex";
  url = proxiedMedia(url);
  state.currentUrl = url;
  state.subIndex = -1;
  $("#tb-cc").classList.remove("on");
  $("#tb-cc-lab").textContent = "ترجمة";
  const video = $("#video");
  video.pause();
  if (video._hls) { try { video._hls.destroy(); } catch (e) {} video._hls = null; }
  video.removeAttribute("src");
  try { video.load(); } catch (e) {}
  [...video.querySelectorAll("track")].forEach((t) => t.remove());
  const useHls = /\.m3u8(\?|$)/i.test(url) && window.Hls && Hls.isSupported();
  if (useHls) {
    const hls = new Hls({ enableWorker: false, maxBufferLength: 30 });
    hls.loadSource(url);
    hls.attachMedia(video);
    video._hls = hls;
    hls.subtitleDisplay = true;
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, function () {
      const tracks = hls.subtitleTracks || [];
      tracks.forEach(function (t, i) {
        const label = t.name || t.lang || ("ترجمة " + (i + 1));
        if (!state.subTracks.some(function (x) { return x.label === label; })) {
          state.subTracks.push({ label: label, cues: [], hlsIndex: i });
        }
      });
      if (tracks.length && state.subIndex < 0) {
        hls.subtitleTrack = 0;
        state.subIndex = 0;
        setSubStatus(state.subTracks[0].label, true);
      }
    });
  } else {
    video.src = url;
  }
  const p = video.play();
  if (p && p.catch) p.catch(function () {});
  showPlayerUi(false);
  showToolbar(true);
  updateSeek();
  const grabNative = () => {
    try {
      const list = video.textTracks || [];
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if (!t || (t.kind !== "subtitles" && t.kind !== "captions")) continue;
        t.mode = "hidden";
        const cues = [];
        const cc = t.cues || [];
        for (let j = 0; j < cc.length; j++) {
          const c = cc[j];
          if (c && c.text) cues.push({ start: c.startTime, end: c.endTime, text: c.text });
        }
        if (cues.length) {
          const label = t.label || t.language || ("مسار " + (state.subTracks.length + 1));
          if (!state.subTracks.some((x) => x.label === label && x.cues.length === cues.length)) {
            state.subTracks.push({ label: label, cues: cues });
          }
        }
      }
      if (state.subTracks.length && state.subIndex < 0) {
        state.subIndex = 0;
        state.subCues = state.subTracks[0].cues;
        setSubStatus(state.subTracks[0].label, true);
      }
    } catch (e) {}
  };
  video.onloadedmetadata = grabNative;
  video.onloadeddata = grabNative;
}
function closePlayer() {
  const video = $("#video");
  video.pause();
  if (video._hls) { try { video._hls.destroy(); } catch (e) {} video._hls = null; }
  video.removeAttribute("src"); video.load();
  try {
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
  } catch (e) {}
  state.subCues = []; state.subTracks = [];
  const overlay = $("#sub-overlay");
  if (overlay) overlay.textContent = "";
  $("#player-modal").classList.add("hidden");
  $("#player-ui").classList.add("hidden");
  $("#toolbar").classList.add("hidden");
}
function showToolbar(on) {
  $("#toolbar").classList.toggle("hidden", !on);
  if (state.hideTimer) clearTimeout(state.hideTimer);
  if (on) state.hideTimer = setTimeout(() => { $("#toolbar").classList.add("hidden"); showPlayerUi(false); }, 5000);
}
function showPlayerUi(on) {
  state.playerUi = !!on;
  $("#player-ui").classList.toggle("hidden", !on);
}
function togglePlayerUi() {
  const barHidden = $("#toolbar").classList.contains("hidden");
  if (barHidden) { showToolbar(true); return; }
  showToolbar(false);
  showPlayerUi(false);
}
function renderPlayerMenus() {
  const cats = [{ category_id: "*", category_name: "الكل" }].concat(catsOf());
  $("#cat-pane").innerHTML = cats.map((c) => '<button class="pcat' + (String(state.packageId || "*") === String(c.category_id) ? " on" : "") + '" data-id="' + esc(String(c.category_id)) + '" data-name="' + esc(c.category_name) + '">' + esc(c.category_name) + "</button>").join("");
  const list = currentList().slice(0, 80);
  $("#ch-pane").innerHTML = list.map((it, i) => '<button class="pch' + (i === state.playIndex ? " on" : "") + '" data-i="' + i + '">' + esc(it.name) + "</button>").join("");
  $("#cat-pane").querySelectorAll(".pcat").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    state.packageId = b.dataset.id;
    state.packageName = b.dataset.name;
    state.playIndex = 0;
    renderPlayerMenus();
  }));
  $("#ch-pane").querySelectorAll(".pch").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const i = Number(b.dataset.i);
    const it = currentList()[i];
    if (!it) return;
    state.playIndex = i;
    if (state.kind === "live") playLive(i);
    else if (state.kind === "vod") {
      showPlayerUi(false);
      play(it.name, itemUrl("vod", it), false, { kind: "vod", id: it.stream_id || it.vod_id });
    } else {
      showPlayerUi(false);
      showSeries(it);
    }
  }));
}
function srtToVtt(srt) {
  return "WEBVTT\n\n" + String(srt).replace(/\r+/g, "").replace(/(\d+)\n(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1\n$2.$3");
}
function setSubStatus(t, on) {
  $("#tb-cc-lab").textContent = t;
  $("#tb-cc").classList.toggle("on", !!on);
}
function parseSrt(text) {
  const blocks = String(text || "").replace(/\r/g, "").split(/\n\n+/);
  const cues = [];
  const toSec = (t) => {
    const p = t.replace(",", ".").split(":");
    return Number(p[0]) * 3600 + Number(p[1]) * 60 + parseFloat(p[2] || 0);
  };
  blocks.forEach((b) => {
    const lines = b.trim().split("\n");
    const timeLine = lines.find((l) => l.indexOf("-->") !== -1);
    if (!timeLine) return;
    const m = timeLine.match(/(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/);
    if (!m) return;
    cues.push({
      start: toSec(m[1]),
      end: toSec(m[2]),
      text: lines.slice(lines.indexOf(timeLine) + 1).join("\n")
    });
  });
  return cues;
}
function collectSubUrls(data, playUrl, media) {
  const out = [];
  const langs = [];
  const add = (url, label) => {
    if (!url || typeof url !== "string") return;
    url = String(url).trim().replace(/^['"]|['"]$/g, "");
    if (url.indexOf("//") === 0) url = "http:" + url;
    if (!/^https?:\/\//i.test(url) && state.server && url.charAt(0) === "/") url = state.server + url;
    if (!/^https?:\/\//i.test(url)) return;
    out.push({ url: url, label: label || "ترجمة" });
  };
  const addLang = (s) => {
    const t = String(s || "").trim();
    if (t && t.length < 40 && !/^https?:/i.test(t) && langs.indexOf(t) === -1) langs.push(t);
  };
  const walk = (node, label, depth) => {
    if (!node || depth > 8) return;
    if (typeof node === "string") {
      const looksSub = /sub|srt|vtt|ass|caption|track/i.test(node + " " + (label || ""));
      if (looksSub && (/^https?:\/\//i.test(node) || node.indexOf("/") === 0)) add(node, label);
      else if (/^\[{/.test(node.trim()) || /^\{/.test(node.trim())) {
        try { walk(JSON.parse(node), label, depth + 1); } catch (e) {}
      } else if (/ar|en|fr|es|de|tr|العرب|انجليز|French|English|Arabic|Spanish/i.test(node)) addLang(node);
      return;
    }
    if (Array.isArray(node)) { node.forEach((x) => walk(x, label, depth + 1)); return; }
    if (typeof node !== "object") return;
    const lab = node.language || node.lang || node.label || node.title || node.name || label;
    add(node.url || node.subtitle_url || node.src || node.file || node.path || node.link || node.location || node.subtitle, lab);
    if (lab && /sub|caption|lang|ar|en|عرب/i.test(String(lab))) addLang(lab);
    Object.keys(node).forEach((k) => {
      walk(node[k], (node[k] && node[k].language) || lab || k, depth + 1);
    });
  };
  walk(data, "ترجمة", 0);
  const sid = media && (media.id || media.stream_id || media.vod_id);
  const bases = [];
  if (playUrl && /^https?:/i.test(playUrl)) bases.push(playUrl.replace(/\.(m3u8|mp4|mkv|ts|avi|mpg)(\?.*)?$/i, ""));
  if (state.mode === "xtream" && sid) {
    ["movie", "series"].forEach((folder) => {
      bases.push(state.server + "/" + folder + "/" + state.username + "/" + state.password + "/" + sid);
    });
    add(state.server + "/subtitle/" + state.username + "/" + state.password + "/" + sid, "subtitle");
    add(state.server + "/subtitles/" + state.username + "/" + state.password + "/" + sid, "subtitles");
    add(state.server + "/subtitles/" + state.username + "/" + state.password + "/" + sid + ".srt", "subtitles");
  }
  const extras = [".srt", ".vtt", ".ar.srt", ".ara.srt", ".en.srt", ".eng.srt", ".ar.vtt", ".en.vtt", "_ar.srt", "_en.srt"];
  bases.forEach((b) => extras.forEach((ext) => add(b + ext, ext.replace(".", ""))));
  const seen = {};
  return {
    files: out.filter((t) => { if (seen[t.url]) return false; seen[t.url] = 1; return true; }),
    langs: langs
  };
}
async function loadSubFile(url) {
  const text = await rawGet(url);
  if (!text || text.length < 12) throw new Error("empty");
  const head = text.slice(0, 80);
  if (/^\s*</.test(text) || /not found|404|error/i.test(head)) throw new Error("html");
  if (/#EXTM3U/.test(head) && /TYPE=SUBTITLES|#EXT-X-MEDIA/i.test(text)) {
    throw new Error("master");
  }
  if (/#EXTM3U/.test(head)) {
    const base = new URL(url, state.server || "http://local");
    const parts = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && parts.length < 40; i++) {
      const line = lines[i].trim();
      if (!line || line.charAt(0) === "#") continue;
      try {
        const abs = new URL(line, base).toString();
        const piece = await rawGet(abs);
        if (piece && piece.length > 10) parts.push(piece);
      } catch (e) {}
    }
    if (!parts.length) throw new Error("empty-hls");
    return parseSrt(parts.join("\n\n").replace(/WEBVTT[^\n]*/gi, ""));
  }
  return parseSrt(/WEBVTT/i.test(text) ? text.replace(/WEBVTT[^\n]*/i, "") : text);
}
function parseHlsSubTags(text, playUrl) {
  const out = [];
  if (!text) return out;
  let base;
  try { base = new URL(playUrl); } catch (e) { return out; }
  const re = /#EXT-X-MEDIA:[^\n]+/gi;
  let m;
  while ((m = re.exec(text))) {
    const line = m[0];
    if (!/TYPE=SUBTITLES/i.test(line)) continue;
    const uri = (line.match(/URI="([^"]+)"/i) || [])[1];
    const name = (line.match(/NAME="([^"]+)"/i) || [])[1] || (line.match(/LANGUAGE="([^"]+)"/i) || [])[1] || "ترجمة";
    if (!uri) continue;
    try { out.push({ url: new URL(uri, base).toString(), label: name }); } catch (e) {}
  }
  return out;
}
async function prepareSubs(url, media) {
  setSubStatus("ترجمة...", false);
  state.subTracks = [];
  const found = [];
  const langs = [];
  const pushPack = (pack) => {
    (pack.files || []).forEach((t) => found.push(t));
    (pack.langs || []).forEach((l) => { if (langs.indexOf(l) === -1) langs.push(l); });
  };
  if (state.mode === "xtream" && media && media.id) {
    try {
      const action = media.kind === "series" ? "get_series_info" : "get_vod_info";
      const extra = media.kind === "series" ? { series_id: media.id } : { vod_id: media.id };
      const data = await api(action, extra);
      pushPack(collectSubUrls(data, url, media));
    } catch (e) {}
  }
  pushPack(collectSubUrls({}, url, media));
  if (url && /\.m3u8(\?|$)/i.test(url)) {
    try {
      parseHlsSubTags(await rawGet(url), url).forEach((t) => found.push(t));
    } catch (e) {}
  }
  const seen = {};
  const uniq = found.filter((t) => { if (seen[t.url]) return false; seen[t.url] = 1; return true; });
  for (let i = 0; i < uniq.length && state.subTracks.length < 10; i++) {
    try {
      const cues = await loadSubFile(uniq[i].url);
      if (cues.length) state.subTracks.push({ label: uniq[i].label || ("لغة " + (state.subTracks.length + 1)), cues: cues });
    } catch (e) {}
  }
  if (state.subTracks.length) {
    state.subIndex = 0;
    state.subCues = state.subTracks[0].cues;
    setSubStatus(state.subTracks[0].label, true);
  } else if (langs.length) {
    setSubStatus("مدمجة — " + langs.slice(0, 3).join(" / "), false);
  } else {
    setSubStatus("لا توجد ترجمة", false);
  }
}
async function toggleSubs() {
  const video = $("#video");
  if (!state.subTracks.length) {
    setSubStatus("لا توجد ترجمة", false);
    return;
  }
  state.subIndex += 1;
  if (state.subIndex >= state.subTracks.length) {
    state.subIndex = -1;
    state.subCues = [];
    if (video._hls) video._hls.subtitleTrack = -1;
    const overlay = $("#sub-overlay");
    if (overlay) overlay.textContent = "";
    setSubStatus("بدون ترجمة", false);
    return;
  }
  const tr = state.subTracks[state.subIndex];
  state.subCues = tr.cues || [];
  if (video._hls && tr.hlsIndex != null) video._hls.subtitleTrack = tr.hlsIndex;
  setSubStatus(tr.label, true);
}
function paintSub() {
  const overlay = $("#sub-overlay");
  if (!overlay) return;
  if (!state.subCues.length || state.subIndex < 0) { overlay.textContent = ""; return; }
  const t = $("#video").currentTime || 0;
  let text = "";
  for (let i = 0; i < state.subCues.length; i++) {
    if (t >= state.subCues[i].start && t <= state.subCues[i].end) { text = state.subCues[i].text; break; }
  }
  overlay.textContent = text;
}
function togglePlay() {
  const video = $("#video");
  if (video.paused) { video.play(); $("#tb-play").textContent = "إيقاف"; }
  else { video.pause(); $("#tb-play").textContent = "تشغيل"; }
}
$("#player-modal").addEventListener("pointerup", (e) => {
  if (e.target.closest(".toolbar") || e.target.closest(".player-ui") || e.target.closest(".back-btn") || e.target.closest(".icon-btn")) return;
  togglePlayerUi();
});
$("#player-modal").addEventListener("mousemove", () => {
  if (!$("#player-modal").classList.contains("hidden")) showToolbar(true);
});
$("#video").addEventListener("playing", () => { showPlayerUi(false); $("#tb-play").textContent = "إيقاف"; });
$("#video").addEventListener("loadeddata", () => showPlayerUi(false));
$("#video").addEventListener("pause", () => { $("#tb-play").textContent = "تشغيل"; });
$("#player-ui").addEventListener("click", (e) => {
  if (e.target === $("#player-ui") || e.target.classList.contains("player-body")) showPlayerUi(false);
});
async function loadEpg(streamId) {
  $("#epg-line").textContent = "";
  try {
    const data = await api("get_short_epg", { stream_id: streamId, limit: 2 });
    const list = data.epg_listings || [];
    if (!list.length) return;
    let title = list[0].title || "";
    try { title = decodeURIComponent(escape(atob(title))); } catch (e) {}
    if (title) $("#epg-line").textContent = "الآن: " + title;
  } catch (e) {}
}
$("#close-player").addEventListener("click", closePlayer);
$("#sheet-close").addEventListener("click", () => $("#sheet").classList.add("hidden"));
$("#prev-btn").addEventListener("click", () => playLive(state.playIndex - 1));
$("#next-btn").addEventListener("click", () => playLive(state.playIndex + 1));
$("#tb-back").addEventListener("click", closePlayer);
$("#tb-prev").addEventListener("click", () => playLive(state.playIndex - 1));
$("#tb-next").addEventListener("click", () => playLive(state.playIndex + 1));
$("#tb-play").addEventListener("click", togglePlay);
$("#tb-list").addEventListener("click", () => { showToolbar(true); showPlayerUi(true); renderPlayerMenus(); });
$("#tb-cc").addEventListener("click", toggleSubs);
async function openVlc() {
  if (!state.currentUrl) return;
  if (NATIVE && AndroidBridge.openExternal) {
    try { AndroidBridge.openExternal(state.currentUrl); setSubStatus("كاست", true); return; } catch (e) {}
  }
  try {
    const res = await fetch("/vlc?url=" + encodeURIComponent(state.currentUrl));
    if (!res.ok) throw new Error("no vlc");
  } catch (e) {
    setSubStatus("كاست", false);
  }
}
if ($("#tb-vlc")) $("#tb-vlc").addEventListener("click", openVlc);
$("#tb-rew").addEventListener("click", () => seekBy(-10));
$("#tb-fwd").addEventListener("click", () => seekBy(10));
$("#tb-rew30").addEventListener("click", () => seekBy(-30));
$("#tb-fwd30").addEventListener("click", () => seekBy(30));
let lastTap = 0;
$("#video").addEventListener("click", (e) => {
  if (state.liveNav) return;
  const now = Date.now();
  if (now - lastTap < 280) {
    const x = e.clientX || 0;
    const mid = window.innerWidth / 2;
    seekBy(x < mid ? -10 : 10);
  }
  lastTap = now;
});
$("#seek").addEventListener("input", () => {
  state.seeking = true;
  const video = $("#video");
  const d = isFinite(video.duration) ? video.duration : 0;
  if (d) $("#tcur").textContent = fmtTime((Number($("#seek").value) / 1000) * d);
});
$("#seek").addEventListener("change", () => {
  const video = $("#video");
  const d = isFinite(video.duration) ? video.duration : 0;
  if (d) video.currentTime = (Number($("#seek").value) / 1000) * d;
  state.seeking = false;
  showToolbar(true);
});
$("#video").addEventListener("timeupdate", () => { updateSeek(); paintSub(); });
$("#video").addEventListener("durationchange", updateSeek);

const APP_CODES = ["MICHEL-OWNER", "MICHEL-001"];
function unlockApp() {
  $("#license-screen").classList.add("hidden");
  $("#login-screen").classList.remove("hidden");
}
$("#license-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const err = $("#license-error");
  const code = ($("#license-code").value || "").trim().toUpperCase();
  if (APP_CODES.indexOf(code) === -1) {
    err.textContent = "الكود غلط";
    err.classList.remove("hidden");
    return;
  }
  localStorage.setItem("michel_license", code);
  unlockApp();
});

function isTvBox() {
  return NATIVE || /AFT|AFTS|AFTN|AFTM|FireTV|Android TV|SMART-TV|Silk|BRAVIA|MiBox|GoogleTV/i.test(navigator.userAgent || "");
}
document.body.classList.toggle("tv", isTvBox());
function tvVisible(el) {
  if (!el || el.disabled) return false;
  if (el.closest && el.closest(".hidden")) return false;
  const r = el.getBoundingClientRect();
  return r.width > 8 && r.height > 8;
}
function tvItems() {
  const playerOpen = !$("#player-modal").classList.contains("hidden");
  const sheetOpen = !$("#sheet").classList.contains("hidden");
  const adult = !$("#adult-lock").classList.contains("hidden");
  const lic = !$("#license-screen").classList.contains("hidden");
  const login = !$("#login-screen").classList.contains("hidden");
  let sel = "";
  if (adult) sel = "#adult-pin, #adult-ok, #adult-cancel";
  else if (lic) sel = "#license-code, #license-btn";
  else if (login) sel = "#login-screen .mode, #login-screen input, #login-btn";
  else if (sheetOpen) sel = "#sheet-close, #sheet-body button";
  else if (playerOpen) {
    if (!$("#player-ui").classList.contains("hidden")) sel = "#close-player, #prev-btn, #next-btn, .pcat, .pch";
    else if (!$("#toolbar").classList.contains("hidden")) sel = "#toolbar button";
    else sel = "";
  } else sel = "#back-btn, #logout-btn, .home-tile, .pkg, .vod, .ch, #more-btn";
  return sel ? [...document.querySelectorAll(sel)].filter(tvVisible) : [];
}
let tvI = 0;
function tvFocus(i) {
  const items = tvItems();
  if (!items.length) return;
  tvI = ((i % items.length) + items.length) % items.length;
  items.forEach((el) => el.classList.remove("tv-on"));
  const el = items[tvI];
  el.classList.add("tv-on");
  try { el.focus(); } catch (e) {}
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function tvGridStep() {
  if ($(".vod-grid") && tvVisible($(".vod"))) {
    const first = $(".vod");
    const w = first.getBoundingClientRect().width || 190;
    return Math.max(2, Math.floor((window.innerWidth - 36) / (w + 16)));
  }
  return 1;
}
window.tvRemote = function (cmd) {
  const playerOpen = !$("#player-modal").classList.contains("hidden");
  const uiOpen = playerOpen && !$("#player-ui").classList.contains("hidden");
  const tbOpen = playerOpen && !$("#toolbar").classList.contains("hidden");
  if (cmd === "back") {
    if (isTyping()) { document.activeElement.blur(); return true; }
    if (playerOpen && (tbOpen || uiOpen)) {
      showToolbar(false);
      showPlayerUi(false);
      return true;
    }
    goBack();
    setTimeout(() => tvFocus(0), 50);
    return true;
  }
  if (cmd === "play") { togglePlay(); showToolbar(true); return true; }
  if (cmd === "menu") {
    if (playerOpen) { showToolbar(true); showPlayerUi(true); renderPlayerMenus(); setTimeout(() => tvFocus(0), 40); }
    return true;
  }
  if (playerOpen && !uiOpen && !tbOpen) {
    if (cmd === "ok" || cmd === "up") { showToolbar(true); setTimeout(() => tvFocus(0), 40); return true; }
    if (cmd === "down") { showToolbar(true); showPlayerUi(true); renderPlayerMenus(); setTimeout(() => tvFocus(0), 40); return true; }
    if (cmd === "left") { if (state.liveNav) playLive(state.playIndex - 1); else seekBy(-10); return true; }
    if (cmd === "right") { if (state.liveNav) playLive(state.playIndex + 1); else seekBy(10); return true; }
    return true;
  }
  const items = tvItems();
  if (!items.length) return true;
  const cur = document.activeElement;
  const idx = items.indexOf(cur);
  if (idx >= 0) tvI = idx;
  const step = tvGridStep();
  if (cmd === "up") tvFocus(tvI - step);
  else if (cmd === "down") tvFocus(tvI + step);
  else if (cmd === "left") tvFocus(tvI + 1);
  else if (cmd === "right") tvFocus(tvI - 1);
  else if (cmd === "ok") {
    const el = items[tvI] || cur;
    if (el && el.tagName !== "INPUT") el.click();
  }
  return true;
};
document.addEventListener("keydown", (e) => {
  if (isTyping()) {
    if (e.key === "Escape") { document.activeElement.blur(); e.preventDefault(); }
    return;
  }
  const map = {
    ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
    Enter: "ok", NumpadEnter: "ok", Escape: "back",
    MediaPlayPause: "play", MediaPlay: "play", MediaPause: "play"
  };
  const cmd = map[e.key];
  if (!cmd) return;
  e.preventDefault();
  window.tvRemote(cmd);
});
setTimeout(() => { if (isTvBox()) tvFocus(0); }, 400);

(async function boot() {
  const code = (localStorage.getItem("michel_license") || "").toUpperCase();
  if (APP_CODES.indexOf(code) === -1) return;
  unlockApp();
  const saved = (() => { try { return JSON.parse(localStorage.getItem("xtream_session") || "null"); } catch (e) { return null; } })();
  if (!saved) return;
  setMode(saved.mode || "xtream");
  $("#server").value = saved.server || "";
  $("#username").value = saved.username || "";
  $("#password").value = saved.password || "";
  $("#m3u").value = saved.m3u || "";
  state.server = saved.server || "";
  state.username = saved.username || "";
  state.password = saved.password || "";
  state.m3u = saved.m3u || "";
  await doLogin(true);
})();
