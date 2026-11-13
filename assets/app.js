"use strict";
/* 中港體育速報 HK-China Sports Express */

// All 22 sport keys the live data actually uses (plan §1.5). The 6 keys the
// old app.js missed (cricket, handball, f1, motorsport, baseball, bowling)
// are included so their 29 articles filter and label correctly instead of
// falling back to "others".
const SPORTS = {
  football:    {en:"Football",     zh_hant:"足球",         zh_hans:"足球"},
  basketball:  {en:"Basketball",   zh_hant:"籃球",         zh_hans:"篮球"},
  badminton:   {en:"Badminton",    zh_hant:"羽毛球",       zh_hans:"羽毛球"},
  table_tennis:{en:"Table Tennis", zh_hant:"乒乓球",       zh_hans:"乒乓球"},
  tennis:      {en:"Tennis",       zh_hant:"網球",         zh_hans:"网球"},
  athletics:   {en:"Athletics",    zh_hant:"田徑",         zh_hans:"田径"},
  swimming:    {en:"Swimming",     zh_hant:"游泳",         zh_hans:"游泳"},
  volleyball:  {en:"Volleyball",   zh_hant:"排球",         zh_hans:"排球"},
  cycling:     {en:"Cycling",      zh_hant:"單車",         zh_hans:"单车"},
  rugby:       {en:"Rugby",        zh_hant:"欖球",         zh_hans:"榄球"},
  golf:        {en:"Golf",         zh_hant:"高爾夫球",     zh_hans:"高尔夫球"},
  snooker:     {en:"Snooker",      zh_hant:"桌球",         zh_hans:"台球"},
  boxing_mma:  {en:"Boxing / MMA", zh_hant:"拳擊／綜合格鬥", zh_hans:"拳击／综合格斗"},
  esports:     {en:"Esports",      zh_hant:"電競",         zh_hans:"电竞"},
  racing:      {en:"Racing",       zh_hant:"賽車／賽馬",   zh_hans:"赛车／赛马"},
  cricket:     {en:"Cricket",      zh_hant:"板球",         zh_hans:"板球"},
  handball:    {en:"Handball",     zh_hant:"手球",         zh_hans:"手球"},
  f1:          {en:"Formula 1",    zh_hant:"一級方程式",   zh_hans:"一级方程式"},
  motorsport:  {en:"Motorsport",   zh_hant:"賽車運動",     zh_hans:"赛车运动"},
  baseball:    {en:"Baseball",     zh_hant:"棒球",         zh_hans:"棒球"},
  bowling:     {en:"Bowling",      zh_hant:"保齡球",       zh_hans:"保龄球"},
  others:      {en:"Others",       zh_hant:"其他",         zh_hans:"其他"}
};

const STR = {
  en:{siteName:"HK-China Sports Express",search:"Search news, tags, teams…",all:"All",latest:"Latest",
      readMore:"Read full story →",copied:"Link copied!",noResult:"No news found. Try another keyword.",
      loadMore:"Load earlier news",updated:"Updated",articles:"articles",loading:"Loading…",
      footer:"Summaries are rewritten by our editors. Photos belong to their original sources."},
  zh_hant:{siteName:"中港體育速報",search:"搜尋新聞、標籤、球隊…",all:"全部",latest:"最新",
      readMore:"閱讀原文 →",copied:"連結已複製！",noResult:"搵唔到相關新聞，試下其他關鍵字。",
      loadMore:"載入更早新聞",updated:"更新於",articles:"則新聞",loading:"載入中…",
      footer:"摘要由本站重新編寫，圖片版權歸原新聞機構所有。"},
  zh_hans:{siteName:"中港体育速报",search:"搜索新闻、标签、球队…",all:"全部",latest:"最新",
      readMore:"阅读原文 →",copied:"链接已复制！",noResult:"找不到相关新闻，试试其他关键字。",
      loadMore:"加载更早新闻",updated:"更新于",articles:"则新闻",loading:"加载中…",
      footer:"摘要由本站重新编写，图片版权归原新闻机构所有。"}
};

const $ = s => document.querySelector(s);
// Sports source is a plain string (institution name) + source_url; an
// object source {name, url} is still accepted for robustness.
const srcName = a => (a.source && typeof a.source === "object" ? a.source.name : a.source) || "";
const srcUrl  = a => (a.source && typeof a.source === "object" ? a.source.url : a.source_url) || "";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

let LANG = localStorage.getItem("hks_lang") || "zh_hant";
if (!STR[LANG]) LANG = "zh_hant";
let ALL = [];            // loaded articles (accumulated pages from the API)
let DATES = [];          // [{date,count}] desc
let UPDATED_AT = "";
let TOTAL = 0;           // server-side total for the current filter
let PAGES = 1, PAGE = 1;
const filter = {sport:"all", date:"all", q:""};
const PAGE_SIZE = 20;

/* ---------- theme ---------- */
function setLogo(){
  const dark = document.documentElement.dataset.theme === "dark";
  const bn = document.getElementById("brandName");
  if (bn && bn.style.display === "flex") return; // text fallback active
  const l = document.getElementById("logoLight"), d = document.getElementById("logoDark");
  if (l && d) { l.style.display = dark ? "none" : ""; d.style.display = dark ? "" : "none"; }
}
function initTheme(){
  let t = localStorage.getItem("hks_theme");
  if (!t) t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = t;
  $("#themeBtn").textContent = t === "dark" ? "☀️" : "🌙";
  setLogo();
}
$("#themeBtn").addEventListener("click", () => {
  const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  localStorage.setItem("hks_theme", t);
  $("#themeBtn").textContent = t === "dark" ? "☀️" : "🌙";
  setLogo();
});

/* ---------- i18n ---------- */
function t(k){ return (STR[LANG] && STR[LANG][k]) || STR.zh_hant[k] || k; }
function applyI18n(){
  document.documentElement.lang = LANG === "en" ? "en" : (LANG === "zh_hans" ? "zh-CN" : "zh-Hant");
  document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-ph]").forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll(".lang-switch button").forEach(b => b.classList.toggle("active", b.dataset.lang === LANG));
  document.title = t("siteName") + " | HK-China Sports Express";
}
document.querySelectorAll(".lang-switch button").forEach(b => b.addEventListener("click", () => {
  LANG = b.dataset.lang; localStorage.setItem("hks_lang", LANG);
  applyI18n(); renderChips(); render();
}));

/* ---------- data (new app: server API, not data/*.json files) ---------- */
async function loadMeta(){
  const r = await fetch("/api/meta");
  const m = await r.json();
  DATES = m.dates || []; UPDATED_AT = m.updated_at || ""; TOTAL = m.total || 0;
}
async function loadPage(n){
  const params = new URLSearchParams({page:String(n), limit:String(PAGE_SIZE)});
  if (filter.sport !== "all") params.set("sport", filter.sport);
  if (filter.date !== "all") params.set("date", filter.date);
  if (filter.q.trim()) params.set("q", filter.q.trim());
  const r = await fetch("/api/articles?" + params.toString());
  const j = await r.json();
  if (n === 1) ALL = [];
  ALL.push(...(j.articles || []));
  TOTAL = j.total || 0; PAGES = j.pages || 1; PAGE = j.page || n;
  return true;
}
async function reload(){ PAGE = 1; await loadPage(1); }

/* ---------- format ---------- */
function fmtTime(iso){
  try {
    const d = new Date(iso);
    const o = {timeZone:"Asia/Hong_Kong", month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit", hour12:false};
    return new Intl.DateTimeFormat(LANG === "en" ? "en-HK" : (LANG === "zh_hans" ? "zh-CN" : "zh-HK"), o).format(d);
  } catch(e){ return (iso || "").slice(0, 16).replace("T", " "); }
}
function fmtDate(ds){
  const [y, m, d] = ds.split("-");
  return LANG === "en" ? `${d}/${m}` : `${m}月${d}日`;
}
function articleUrl(a){
  const base = location.href.split("#")[0].replace(/index\.html$/, "").replace(/\/?$/, "/");
  return base + "a/" + a.id + ".html";
}

/* ---------- render ---------- */
function renderChips(){
  const sc = $("#sportChips");
  sc.innerHTML = `<button class="chip${filter.sport==="all"?" active":""}" data-sport="all">${esc(t("all"))}</button>` +
    Object.keys(SPORTS).map(k => `<button class="chip${filter.sport===k?" active":""}" data-sport="${k}">${esc(SPORTS[k][LANG]||SPORTS[k].en)}</button>`).join("");
  sc.querySelectorAll(".chip").forEach(c => c.addEventListener("click", async () => { filter.sport = c.dataset.sport; await reload(); renderChips(); render(); }));

  const dc = $("#dateChips");
  const counts = {}; DATES.forEach(d => counts[d.date] = d.count);
  dc.innerHTML = `<button class="chip${filter.date==="all"?" active":""}" data-date="all">${esc(t("latest"))}</button>` +
    DATES.map(d => `<button class="chip${filter.date===d.date?" active":""}" data-date="${d.date}">${esc(fmtDate(d.date))} <span class="n">${d.count}</span></button>`).join("");
  dc.querySelectorAll(".chip").forEach(c => c.addEventListener("click", async () => {
    filter.date = c.dataset.date;
    await reload();
    renderChips(); render();
  }));
}

function cardHTML(a){
  const url = articleUrl(a);
  // Sports rule (live site): no image => NO thumb element at all (never a
  // noimg placeholder). A failed image load removes the whole thumb.
  const sportName = esc((SPORTS[a.sport]||SPORTS.others)[LANG]);
  const img = a.image_url
    ? `<a class="thumb" href="a/${esc(a.id)}.html"><img src="${esc(a.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.closest('.thumb').remove()"><span class="thumb-badge">${sportName}</span></a>`
    : ``;
  const tags = (a.tags[LANG] || a.tags.zh_hant || []).map(g => `<button class="tag" data-tag="${esc(g)}">#${esc(g)}</button>`).join("");
  return `<article class="card" id="a-${esc(a.id)}">
    ${img}
    <div class="card-body">
      <div class="card-top"><span class="sport-tag">${esc((SPORTS[a.sport]||SPORTS.others)[LANG])}</span><span>${esc(fmtTime(a.published_at))}</span></div>
      <h2 class="card-title"><a href="a/${esc(a.id)}.html">${esc(a.title[LANG] || a.title.zh_hant)}</a></h2>
      <p class="card-summary">${esc(a.summary[LANG] || a.summary.zh_hant)}</p>
      <div class="tags">${tags}</div>
      <div class="card-foot">
        <span class="src">${esc(srcName(a))}</span>
        <span class="actions">
          <a class="abtn primary" href="${esc(srcUrl(a))}" target="_blank" rel="noopener">${esc(t("readMore"))}</a>
          <button class="abtn" data-share="fb" data-id="${esc(a.id)}">f</button>
          <button class="abtn" data-share="native" data-id="${esc(a.id)}">⤴</button>
          <button class="abtn" data-share="copy" data-id="${esc(a.id)}">🔗</button>
        </span>
      </div>
    </div>
  </article>`;
}

function render(){
  // Server already applied the sport/date/search filter; ALL is the
  // accumulated pages. The meta count is the server-side total, so it stays
  // correct even before load-more is pressed.
  const list = ALL;
  $("#cards").innerHTML = list.map(cardHTML).join("");
  $("#empty").hidden = list.length > 0;
  $("#meta").textContent = `${TOTAL} ${t("articles")}` + (UPDATED_AT ? ` · ${t("updated")} ${fmtTime(UPDATED_AT)}` : "");
  $("#loadMore").hidden = !(PAGE < PAGES);
  $("#loadMore").textContent = t("loadMore");
  document.querySelectorAll("[data-share]").forEach(b => b.addEventListener("click", ev => { ev.stopPropagation(); doShare(b.dataset.share, b.dataset.id); }));
  document.querySelectorAll(".tag").forEach(b => b.addEventListener("click", async () => {
    filter.q = b.dataset.tag; $("#search").value = filter.q; await reload(); render();
    window.scrollTo({top:0, behavior:"smooth"});
  }));
}

let toastTimer;
function toast(msg){
  const el = $("#toast"); el.textContent = msg; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

function doShare(kind, id){
  const a = ALL.find(x => x.id === id); if (!a) return;
  const url = articleUrl(a);
  const title = a.title[LANG] || a.title.zh_hant;
  if (kind === "fb") {
    window.open("https://www.facebook.com/sharer/sharer.php?u=" + encodeURIComponent(url), "_blank", "width=600,height=540");
  } else if (kind === "native" && navigator.share) {
    navigator.share({title, text:(a.summary[LANG]||a.summary.zh_hant), url}).catch(()=>{});
  } else {
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(
      () => toast(t("copied")),
      () => { prompt(url, url); });
  }
}

let searchTimer;
$("#search").addEventListener("input", e => {
  filter.q = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => { await reload(); render(); }, 300);
});
/* ---------- load more: one page at a time, on scroll or on button ---------- */
// The list is never preloaded: each step fetches exactly one page
// (PAGE_SIZE rows) from /api/articles. Scrolling to the Load More button
// loads the next page automatically; the button stays as a fallback.
let loadingMore = false;
async function loadNext(){
  if (loadingMore || PAGE >= PAGES) return;
  loadingMore = true;
  const btn = $("#loadMore"); if (btn) btn.disabled = true;
  try { await loadPage(PAGE + 1); render(); }
  finally { loadingMore = false; if (btn) btn.disabled = false; }
}
$("#loadMore").addEventListener("click", loadNext);

/* ---------- init ---------- */
(async function(){
  initTheme(); applyI18n();
  $("#meta").textContent = t("loading");
  try {
    await loadMeta();
    await loadPage(1);
  } catch(e){ /* offline / empty */ }
  renderChips(); render();
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) loadNext();
    }, { rootMargin: "400px" });
    io.observe($("#loadMore"));
  }
  if (location.hash.startsWith("#a-")) {
    const el = document.getElementById(location.hash.slice(1));
    if (el) setTimeout(() => el.scrollIntoView({block:"center"}), 400);
  }
})();
