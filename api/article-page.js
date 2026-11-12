// GET /api/article-page?slug=<id> — full article HTML, server-rendered so that
// og:title / og:description / og:image / og:url are in the first HTML (social
// sharing and Google need this; client-side JS cannot do it).
// Rewrites in vercel.json map /a/<id>.html here, so article URLs do not change.
// Template replicates the live static a/*.html pages: same classes, same
// header, same language-switch script (adapted to fetch /api/article).
// Sports rule (2026-10-30): when an article has NO image, the whole
// article-hero div is omitted — never a noimg placeholder (unlike the news
// site). With an image, a failed load replaces the <img> with a noimg div,
// exactly like the live static pages.
"use strict";
const { getArticle, siteUrl, setCache } = require("../lib/data");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

const STANDARD_FOOTER = "摘要由本站重新編寫，圖片版權歸原新聞機構所有。";

function fmtDateTime(iso) {
  return (iso || "").slice(0, 16).replace("T", " ");
}

// Inline script from the live article pages, with one change: it fetches
// /api/article?slug= instead of ../data/<date>.json (there are no data files here).
const LANG_SCRIPT = `
(function(){
  var SITE='港體育';
  function esc(s){return String(s).replace(/[&<>\"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c];});}
  function setLogo(){var dark=document.documentElement.getAttribute('data-theme')==='dark';var bn=document.getElementById('brandName');if(bn&&bn.style.display==='flex')return;var l=document.getElementById('logoLight'),d=document.getElementById('logoDark');if(l&&d){l.style.display=dark?'none':'';d.style.display=dark?'':'none';}}
  var LANG='zh_hant';
  try{ LANG=localStorage.getItem('hks_lang')||'zh_hant'; }catch(e){}
  var aid=location.pathname.split('/').pop().replace(/\\.html$/,'');
  function pick(o){ return (o&&(o[LANG]||o.zh_hant))||''; }
  function setActive(){
    var btns=document.querySelectorAll('.lang-switch button');
    for(var i=0;i<btns.length;i++) btns[i].classList.toggle('active', btns[i].getAttribute('data-lang')===LANG);
  }
  function apply(a){
    setActive();
    document.documentElement.lang = LANG==='en'?'en':(LANG==='zh_hans'?'zh-CN':'zh-Hant');
    if(!a) return;
    var h1=document.querySelector('h1.article-title');
    var lead=document.querySelector('p.article-summary');
    var tags=document.querySelector('.article-tags');
    var t=pick(a.title), s=pick(a.summary);
    if(h1&&t) h1.textContent=t;
    if(lead&&s) lead.textContent=s;
    if(tags&&a.tags){
      var arr=a.tags[LANG]||a.tags.zh_hant||[];
      if(typeof arr==='string') arr=[arr];
      var h='';
      for(var i=0;i<arr.length;i++) h+='<button class="tag">#'+esc(arr[i])+'</button>';
      tags.innerHTML=h;
    }
    if(t) document.title=t+' | '+SITE;
  }
  var btns=document.querySelectorAll('.lang-switch button');
  for(var i=0;i<btns.length;i++)(function(b){
    b.addEventListener('click',function(){
      LANG=b.getAttribute('data-lang');
      try{ localStorage.setItem('hks_lang',LANG); }catch(e){}
      apply(window.__ADATA||null);
    });
  })(btns[i]);
  var tb=document.getElementById('themeBtn');
  function setIcon(){ if(tb) tb.textContent=document.documentElement.getAttribute('data-theme')==='dark'?'\\u2600\\uFE0F':'\\uD83C\\uDF19'; }
  if(tb) tb.addEventListener('click',function(){
    var cur=document.documentElement.getAttribute('data-theme')==='dark';
    var t=cur?'light':'dark';
    document.documentElement.setAttribute('data-theme',t);
    try{ localStorage.setItem('hks_theme',t); }catch(e){}
    setIcon(); setLogo();
  });
  setIcon(); setActive(); setLogo();
  fetch('/api/article?slug='+encodeURIComponent(aid)).then(function(r){ if(!r.ok) throw 0; return r.json(); }).then(function(j){
    window.__ADATA=j.article||null; apply(window.__ADATA);
  }).catch(function(){});
})();
`;

function pageHTML(a, base) {
  const zhTitle = a.title.zh_hant || a.title.en || "";
  const zhSummary = a.summary.zh_hant || a.summary.en || "";
  const tags = (a.tags.zh_hant || []).map((g) => `<button class="tag">#${esc(g)}</button>`).join("");
  const url = `${base}/a/${a.id}.html`;
  // Sports rule: no image => NO hero div at all (verified on the live site:
  // imageless article pages contain no article-hero and no noimg).
  const img = a.image_url
    ? `<div class="article-hero"><img src="${esc(a.image_url)}" alt="" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=&quot;noimg&quot;>🏅</div>'"></div>`
    : "";
  const caption = a.image_caption
    ? `<p style="font-size:13px;color:#888;margin:8px 0 0">${esc(a.image_caption)}</p>`
    : "";
  const ogImage = a.image_url ? `<meta property="og:image" content="${esc(a.image_url)}">\n` : "";
  const footer = esc(a.footer_note || STANDARD_FOOTER);
  // Sports source is a plain string; source_url is a separate field.
  const srcName = esc(typeof a.source === "string" ? a.source : (a.source?.name || ""));
  const srcUrl = esc(a.source_url || (a.source && a.source.url) || "");
  return `<!DOCTYPE html>
<html lang="zh-Hant" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(zhTitle)} | 港體育</title>
<meta name="description" content="${esc(zhSummary)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="港體育 Hong Kong Sports">
<meta property="og:title" content="${esc(zhTitle)}">
<meta property="og:description" content="${esc(zhSummary)}">
${ogImage}<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="../assets/favicon.png">
<link rel="stylesheet" href="../assets/style.css">
<script>try{var _t=localStorage.getItem("hks_theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.dataset.theme=_t;}catch(e){}
function logoFallback(){var b=document.getElementById("brandName");if(b)b.style.display="flex";["logoLight","logoDark"].forEach(function(id){var e=document.getElementById(id);if(e)e.style.display="none";});}</script>
<!-- Vercel Web Analytics: window.va stub + script. This is exactly what
     @vercel/analytics v2 inject() does in production (it loads
     /_vercel/insights/script.js); no npm package is needed for a
     no-build static site. -->
<script>
  window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
</script>
<script defer src="/_vercel/insights/script.js"></script>
</head>
<body>
<header class="topbar">
  <a class="brand" href="../" aria-label="home">
    <img id="logoLight" class="logo-img" src="../assets/logo-light.png" alt="港體育 Hong Kong Sports" onerror="logoFallback()">
    <img id="logoDark" class="logo-img" src="../assets/logo-dark.png" alt="港體育 Hong Kong Sports" style="display:none" onerror="logoFallback()">
    <span class="brand-name" id="brandName" style="display:none"><strong>港體育</strong><small>HONG KONG SPORTS</small></span>
  </a>
  <div class="controls">
    <div class="lang-switch" role="group" aria-label="language"><button data-lang="en">EN</button><button data-lang="zh_hant">繁</button><button data-lang="zh_hans">简</button></div>
    <button id="themeBtn" class="icon-btn" aria-label="theme">🌙</button>
  </div>
</header>
<main class="article-wrap">
${img}
${caption}  <div class="card-top"><span class="sport-tag">${esc(a.sport)}</span><span>${esc(fmtDateTime(a.published_at))}</span><span> · ${srcName}</span></div>
  <h1 class="article-title">${esc(zhTitle)}</h1>
  <p class="lead article-summary">${esc(zhSummary)}</p>
  <div class="tags article-tags">${tags}</div>
  <div style="margin:20px 0;display:flex;gap:10px;flex-wrap:wrap">
    <a class="abtn primary" style="font-size:15px;padding:10px 22px" href="${srcUrl}" target="_blank" rel="noopener">閱讀原文 →</a>
    <a class="abtn" style="font-size:15px;padding:10px 18px" href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}" target="_blank" rel="noopener">分享到 Facebook</a>
  </div>
</main>
<footer><p>${footer}</p></footer>
<script>${LANG_SCRIPT}</script>
</body>
</html>
`;
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ ok: false, error: "method not allowed" });
    return;
  }
  const slug = String((req.query || {}).slug || "").trim();
  if (!slug) { res.status(400).send("missing slug"); return; }
  try {
    const a = await getArticle(slug);
    if (!a) { res.status(404).send("not found"); return; }
    setCache(res, 60);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(pageHTML(a, siteUrl(req)));
  } catch (e) {
    res.status(500).send(String(e.message || e).slice(0, 200));
  }
};
