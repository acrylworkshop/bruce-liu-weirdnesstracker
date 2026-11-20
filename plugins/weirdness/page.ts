/**
 * The tracker's page: the camera stage, the live weirdness, the people it has seen and the charts of how their weirdness
 * changed. The markup is static; `client.js` fills it from `/api/state` and draws the charts.
 *
 * The page is served at the plugin's own path (`/weirdness`, or `/app/weirdness` in the frame), so every URL it asks for is
 * worked out in the browser from the page's own address instead of being written here: `base` is that address with a
 * trailing slash, and `client.js` resolves `api/...`, `vendor/...` and `score.js` against it. That is what keeps the same
 * source working on the app's own server and under the frame's canvas prefix.
 *
 * `version` is a digest of this plugin's client modules: it rides along as a query string so a browser that cached an older
 * copy (the face bundle is cached for a day) still runs the file that is on disk after an edit and a reload.
 *
 * The layout is stage first, review second: one column is the camera and the eight things driving the number, the other is
 * a compact rail of the people and one card about the person picked from it. Everything that changes a person's data
 * (rename, merge, delete) lives in that one card, so a rail of ten people is ten rows and not forty controls.
 */

const STYLES = `
:root{
  color-scheme:light dark;
  --bg:#f6f6fa;
  --surface:#ffffff;
  --surface-2:#f1f1f6;
  --surface-3:#e9e9f1;
  --line:#e3e3ea;
  --line-2:#d2d2dd;
  --text:#16161c;
  --muted:#67677a;
  --accent:#5b5bd6;
  --accent-2:#8b5cf6;
  --accent-soft:rgba(91,91,214,.11);
  --calm:#0f9d76;
  --odd:#a86a00;
  --weird:#cf2f63;
  --shadow:0 1px 2px rgba(18,18,28,.05),0 12px 30px -18px rgba(18,18,28,.35);
  --radius:16px;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0a0a0e;
    --surface:#131319;
    --surface-2:#1a1a22;
    --surface-3:#23232d;
    --line:#26262f;
    --line-2:#35353f;
    --text:#ececf2;
    --muted:#9898a8;
    --accent:#8b8cff;
    --accent-2:#b79cff;
    --accent-soft:rgba(139,140,255,.14);
    --calm:#3ddcae;
    --odd:#f6c453;
    --weird:#ff7a9c;
    --shadow:0 1px 2px rgba(0,0,0,.6),0 18px 40px -22px rgba(0,0,0,.95);
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;
  min-height:100vh;
  background:
    radial-gradient(1100px 460px at 50% -220px,var(--accent-soft),transparent 72%),
    var(--bg);
  color:var(--text);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased;
}
.wrap{max-width:1180px;margin:0 auto;padding:0 20px 56px}
h1,h2,h3{letter-spacing:-.015em}
p{margin:0}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}

/* ---------- top ---------- */
.top{display:flex;align-items:flex-start;gap:18px;padding:28px 0 22px}
.brand{display:flex;gap:13px;align-items:flex-start;min-width:0;flex:1}
.logo{flex:none;width:40px;height:40px;border-radius:13px;display:grid;place-items:center;color:#fff;
  background:linear-gradient(150deg,var(--accent),var(--accent-2));box-shadow:0 8px 20px -10px var(--accent)}
.logo svg{width:24px;height:24px}
.top h1{font-size:1.5rem;line-height:1.15;margin:0 0 5px}
.lede{margin:0;color:var(--muted);font-size:.92rem;max-width:64ch}

/* ---------- buttons ---------- */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:9px 15px;border-radius:11px;
  border:1px solid var(--line-2);background:var(--surface);color:var(--text);font:inherit;font-size:.88rem;
  font-weight:550;cursor:pointer;white-space:nowrap;transition:border-color .15s,color .15s,background .15s,transform .1s}
.btn svg{width:16px;height:16px;flex:none}
.btn:hover{border-color:var(--accent);color:var(--accent)}
.btn:active{transform:translateY(1px)}
.btn:disabled{opacity:.45;cursor:not-allowed;transform:none}
.btn:disabled:hover{border-color:var(--line-2);color:inherit}
.btn.primary{background:var(--accent);border-color:transparent;color:#fff;box-shadow:0 10px 22px -14px var(--accent)}
.btn.primary:hover{background:var(--accent);border-color:transparent;color:#fff;filter:brightness(1.08)}
.btn.primary:disabled:hover{filter:none}
.btn.ghost{background:transparent}
.btn.small{padding:5px 11px;font-size:.8rem;border-radius:9px}
.btn.danger{color:var(--weird)}
.btn.danger:hover{border-color:var(--weird);color:var(--weird)}
.linkish{padding:0;border:0;background:none;color:var(--accent);font:inherit;font-size:.78rem;font-weight:550;cursor:pointer}
.linkish:hover{text-decoration:underline}
.file{position:relative;overflow:hidden}
.file input{position:absolute;inset:0;opacity:0;cursor:pointer;font-size:0}
kbd{font:inherit;font-size:.68rem;line-height:1;padding:3px 5px;border-radius:5px;border:1px solid var(--line-2);
  background:var(--surface-2);color:var(--muted);margin-left:2px}

/* ---------- layout ---------- */
.layout{display:grid;grid-template-columns:minmax(0,1.12fr) minmax(0,.88fr);gap:18px;align-items:start}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}
.stage{padding:14px;display:flex;flex-direction:column;gap:12px}
.side{display:flex;flex-direction:column;gap:18px;min-width:0}

/* ---------- the camera stage ---------- */
.frame{position:relative;aspect-ratio:4/3;border-radius:12px;overflow:hidden;background:#05050a;border:1px solid var(--line)}
.frame video,.frame img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
.frame video{transform:scaleX(-1)}
.frame canvas{position:absolute;inset:0;width:100%;height:100%}
.placeholder{position:absolute;inset:0;display:grid;place-content:center;justify-items:center;gap:12px;
  text-align:center;padding:22px;color:#8e8ea8}
.placeholder svg{width:84px;height:84px;opacity:.55}
.placeholder p{margin:0;font-size:.86rem;max-width:26ch;line-height:1.45}
.readout{position:absolute;left:14px;bottom:14px;display:flex;align-items:center;gap:12px;padding:9px 16px 9px 14px;
  border-radius:14px;background:rgba(7,7,13,.68);border:1px solid rgba(255,255,255,.13);color:#fff;
  -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
.readout[hidden]{display:none}
.readout .num{font-size:2.5rem;font-weight:750;line-height:.88;letter-spacing:-.035em;
  font-variant-numeric:tabular-nums;color:var(--band,#fff);text-shadow:0 2px 14px rgba(0,0,0,.5)}
.readout-text{display:grid;gap:1px}
.readout-text small{font-size:.62rem;text-transform:uppercase;letter-spacing:.12em;opacity:.65}
.readout-text b{font-size:.86rem;font-weight:600;letter-spacing:.005em}
.readout[data-band=calm]{--band:var(--calm)}
.readout[data-band=odd]{--band:var(--odd)}
.readout[data-band=weird]{--band:var(--weird)}
.chips{position:absolute;right:12px;top:12px;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:.72rem;
  background:rgba(7,7,13,.66);border:1px solid rgba(255,255,255,.13);color:#e9e9f2;
  -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.chip[hidden]{display:none}
.chip .dot{width:6px;height:6px;border-radius:50%;background:var(--weird);box-shadow:0 0 0 3px rgba(255,122,156,.18);
  animation:pulse 2s ease-in-out infinite}
@keyframes pulse{50%{opacity:.35}}

.controls{display:flex;flex-wrap:wrap;gap:8px}
.status{margin:0;color:var(--muted);font-size:.82rem;min-height:1.3em}
.flash{margin:0;padding:8px 12px;border-radius:10px;background:var(--accent-soft);border:1px solid transparent;
  color:var(--text);font-size:.83rem}
.flash[hidden]{display:none}

/* ---------- capture settings ---------- */
.settings{border:1px solid var(--line);border-radius:12px;background:var(--surface-2);padding:0 12px}
.settings>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;
  cursor:pointer;list-style:none;font-size:.82rem}
.settings>summary::-webkit-details-marker{display:none}
.settings-title{font-weight:600;color:var(--text);display:inline-flex;align-items:center;gap:7px}
.settings-title::before{content:"";width:6px;height:6px;border-right:1.6px solid var(--muted);
  border-bottom:1.6px solid var(--muted);transform:rotate(-45deg) translate(-1px,-1px);transition:transform .15s}
.settings[open] .settings-title::before{transform:rotate(45deg) translate(-1px,-1px)}
.settings-hint{color:var(--muted);font-size:.76rem;font-variant-numeric:tabular-nums;text-align:right}
.settings-body{display:grid;gap:2px;padding:4px 0 12px;border-top:1px solid var(--line)}
.row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:7px 0;font-size:.84rem;color:var(--muted)}
.row-value{display:inline-flex;align-items:center;gap:9px}
.row select,.row input[type=range]{font:inherit;font-size:.82rem;color:var(--text);background:var(--surface);
  border:1px solid var(--line-2);border-radius:8px;padding:4px 7px;accent-color:var(--accent)}
.row input[type=range]{padding:0;width:112px;border:0;background:transparent}
output{font-variant-numeric:tabular-nums;color:var(--text);min-width:2.6em;text-align:right}

/* ---------- what is driving it ---------- */
.drivers{display:grid;gap:9px;padding-top:2px}
.drivers-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.drivers h3{margin:0;font-size:.76rem;text-transform:uppercase;letter-spacing:.085em;color:var(--muted);font-weight:600}
.hint{margin:0;color:var(--muted);font-size:.74rem;font-variant-numeric:tabular-nums}
.factors{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 16px}
.factor{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 8px;font-size:.78rem;align-items:baseline}
.factor .flabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
.factor .fval{color:var(--muted);font-variant-numeric:tabular-nums;font-size:.76rem}
.factor .fbar{grid-column:1/-1;height:4px;border-radius:3px;background:var(--surface-3);overflow:hidden}
.factor .fbar i{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,var(--accent),var(--accent-2));
  transition:width .25s ease}
.factor.top .flabel{font-weight:600}
.factor.top .fbar i{background:linear-gradient(90deg,var(--accent-2),var(--weird))}
.factors-empty{grid-column:1/-1;color:var(--muted);font-size:.8rem;margin:0}

/* ---------- people rail ---------- */
.card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 16px 10px}
.card-head h2{margin:0;font-size:.92rem;font-weight:650;display:inline-flex;align-items:center;gap:7px}
.count{font-size:.72rem;font-weight:600;color:var(--muted);background:var(--surface-2);border:1px solid var(--line);
  border-radius:999px;padding:0 7px;line-height:1.7;font-variant-numeric:tabular-nums}
.people{list-style:none;margin:0;padding:0 8px 10px;display:flex;flex-direction:column;gap:1px;max-height:min(46vh,360px);
  overflow-y:auto;overscroll-behavior:contain}
.people-empty{padding:2px 8px 12px;color:var(--muted);font-size:.84rem}
.person{display:flex;align-items:center;gap:4px;border-radius:10px;padding:0 4px 0 0}
.person.is-selected{background:var(--accent-soft)}
.person .row{flex:1;min-width:0;display:flex;align-items:center;gap:10px;padding:6px 8px;border:0;
  border-radius:10px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.person .row:hover{background:var(--surface-2)}
.person.is-selected .row:hover{background:transparent}
.avatar{flex:none;width:30px;height:30px;border-radius:9px;background:var(--surface-3) center/cover no-repeat;
  display:grid;place-items:center;font-size:.72rem;font-weight:650;color:var(--muted);overflow:hidden}
.who{flex:1;min-width:0;display:grid;gap:1px}
.pname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:.88rem}
.pmeta{color:var(--muted);font-size:.72rem;font-variant-numeric:tabular-nums;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.spark{flex:none;width:46px;height:18px;overflow:visible;opacity:.9}
.pscore{flex:none;font-weight:700;font-size:.95rem;font-variant-numeric:tabular-nums;min-width:2.6em;text-align:right}
.band-calm{color:var(--calm)}
.band-odd{color:var(--odd)}
.band-weird{color:var(--weird)}
.cmp{flex:none;width:15px;height:15px;margin:0 2px 0 0;accent-color:var(--accent);cursor:pointer}
.cmp-title{padding:0 8px 8px;color:var(--muted);font-size:.72rem}

/* ---------- the selected person ---------- */
.detail-head{display:flex;align-items:center;gap:11px;padding:14px 16px 12px}
.detail-head .avatar{width:46px;height:46px;border-radius:13px;font-size:.95rem}
.detail-head .who{gap:2px}
.name-input{width:100%;font:inherit;font-size:1.05rem;font-weight:650;letter-spacing:-.015em;color:var(--text);
  background:transparent;border:1px solid transparent;border-radius:8px;padding:1px 6px;margin-left:-6px}
.name-input:hover:not(:disabled){border-color:var(--line-2)}
.name-input:focus{outline:none;border-color:var(--accent);background:var(--surface-2)}
.name-input:disabled{opacity:.6}
.detail-meta{margin:0;padding-left:1px;color:var(--muted);font-size:.76rem;font-variant-numeric:tabular-nums}
.menu{position:relative;flex:none}
.menu>summary{list-style:none;width:32px;height:32px;border-radius:9px;border:1px solid var(--line);display:grid;
  place-items:center;cursor:pointer;color:var(--muted);font-size:1rem;line-height:1}
.menu>summary::-webkit-details-marker{display:none}
.menu>summary:hover{border-color:var(--line-2);color:var(--text)}
.menu[open]>summary{border-color:var(--accent);color:var(--accent)}
.menu .pop{position:absolute;right:0;top:calc(100% + 6px);z-index:20;width:212px;padding:11px;border-radius:12px;
  background:var(--surface);border:1px solid var(--line-2);box-shadow:var(--shadow);display:grid;gap:9px;font-size:.8rem}
.pop-label{display:grid;gap:5px;color:var(--muted);font-size:.74rem}
.pop-label select{width:100%;font:inherit;font-size:.82rem;color:var(--text);background:var(--surface-2);
  border:1px solid var(--line-2);border-radius:8px;padding:5px 6px}
.tabs{display:flex;gap:2px;padding:0 16px;border-bottom:1px solid var(--line)}
.tab{position:relative;padding:9px 12px;margin-bottom:-1px;border:0;border-bottom:2px solid transparent;
  background:none;color:var(--muted);font:inherit;font-size:.85rem;cursor:pointer;display:inline-flex;
  align-items:center;gap:6px}
.tab:hover{color:var(--text)}
.tab[aria-selected=true]{color:var(--text);font-weight:600;border-bottom-color:var(--accent)}
.badge{font-size:.66rem;font-weight:650;color:#fff;background:var(--accent);border-radius:999px;padding:0 5px;
  line-height:1.55;font-variant-numeric:tabular-nums}
.badge[hidden]{display:none}
.panel{padding:14px 16px 16px;display:grid;gap:12px}
.panel[hidden]{display:none}
.panel:focus-visible{outline-offset:-2px}

.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin:0}
.stat{background:var(--surface-2);border:1px solid var(--line);border-radius:10px;padding:7px 9px;min-width:0}
.stat dt{font-size:.64rem;text-transform:uppercase;letter-spacing:.075em;color:var(--muted)}
.stat dd{margin:2px 0 0;font-size:1.02rem;font-weight:650;font-variant-numeric:tabular-nums;
  overflow:hidden;text-overflow:ellipsis}
.stats-empty{grid-column:1/-1;color:var(--muted);font-size:.84rem;margin:0}
.verdict-line{display:grid;gap:2px;padding:10px 12px;border-radius:11px;background:var(--surface-2);
  border:1px solid var(--line);font-size:.83rem}
.verdict-line b{font-weight:650}
.verdict-line span{color:var(--muted)}
.verdict-line.up b{color:var(--weird)}
.verdict-line.down b{color:var(--calm)}
.subhead{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-top:2px}
.subhead h3{margin:0;font-size:.76rem;text-transform:uppercase;letter-spacing:.085em;color:var(--muted);font-weight:600}

/* ---------- charts ---------- */
.chart{position:relative;color:var(--text)}
.chart svg{width:100%;height:auto;display:block;overflow:visible}
.chart .tip{position:absolute;z-index:5;transform:translate(-50%,-100%);padding:5px 9px;border-radius:9px;
  background:var(--surface);border:1px solid var(--line-2);box-shadow:var(--shadow);font-size:.72rem;
  white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .12s;font-variant-numeric:tabular-nums}
.chart .tip.on{opacity:1}
.chart .tip b{font-weight:650}
.chart .tip .tiptime{color:var(--muted);display:block;font-size:.68rem}
.chart .legend{display:flex;flex-wrap:wrap;gap:6px 12px;margin-top:8px;font-size:.74rem;color:var(--muted)}
.chart .legend span{display:inline-flex;align-items:center;gap:5px}
.chart .legend i{width:9px;height:9px;border-radius:3px;display:inline-block}
.empty{margin:0;color:var(--muted);font-size:.84rem}
.empty[hidden]{display:none}

/* ---------- faces ---------- */
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(62px,1fr));gap:6px}
.shots figure{margin:0;border-radius:9px;overflow:hidden;background:var(--surface-2);border:1px solid var(--line)}
.shots img{width:100%;aspect-ratio:1;object-fit:cover;display:block}
.shots figcaption{font-size:.62rem;padding:2px 3px;text-align:center;color:var(--muted);
  font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ---------- the compare table ---------- */
table{width:100%;border-collapse:collapse;font-size:.8rem}
th,td{text-align:right;padding:6px 6px;border-top:1px solid var(--line);font-variant-numeric:tabular-nums;
  white-space:nowrap}
th:first-child,td:first-child{text-align:left;white-space:normal}
thead th{border-top:0;color:var(--muted);font-weight:500;font-size:.68rem;text-transform:uppercase;letter-spacing:.055em}
tbody tr.is-selected td{color:var(--accent)}
tbody td:first-child{font-weight:550}

/* ---------- narrow ---------- */
@media (min-width:981px) and (min-height:920px){
  .stage{position:sticky;top:16px}
}
@media (max-width:980px){
  .layout{grid-template-columns:minmax(0,1fr)}
  .people{max-height:min(44vh,340px)}
  .top{flex-wrap:wrap}
}
@media (max-width:620px){
  .wrap{padding:0 14px 44px}
  .top{padding:20px 0 16px}
  .top h1{font-size:1.3rem}
  .lede{font-size:.87rem}
  .stage{padding:10px;gap:10px}
  .factors{grid-template-columns:minmax(0,1fr)}
  .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .readout .num{font-size:2rem}
  .settings>summary{flex-direction:column;align-items:flex-start;gap:2px}
  .settings-hint{text-align:left}
  th,td{padding:6px 4px;font-size:.74rem}
  th:nth-child(4),td:nth-child(4){display:none}
}
@media (prefers-reduced-motion:reduce){
  *{animation:none!important;transition:none!important}
}
`

export const page = (version: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>Weirdness tracker</title>
    <style>${STYLES}</style>
  </head>
  <body>
    <div class="wrap">
      <header class="top">
        <div class="brand">
          <span class="logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
              <circle cx="12" cy="12" r="9.2" stroke-dasharray="2.2 3"/>
              <circle cx="9.2" cy="10.1" r="1.05" fill="currentColor" stroke="none"/>
              <circle cx="14.8" cy="10.1" r="1.05" fill="currentColor" stroke="none"/>
              <path d="M9.3 14.3c.95 1.15 1.85 1.7 2.7 1.7s1.75-.55 2.7-1.7"/>
            </svg>
          </span>
          <div>
            <h1>Weirdness tracker</h1>
            <p class="lede">Point the camera at your face. The weirder you look, the higher the score. Every capture keeps a picture and a number, so you can tell whether you are getting weirder or calming down.</p>
          </div>
        </div>
        <a class="btn ghost" id="home" href="./">Home</a>
      </header>

      <main class="layout">
        <section class="card stage" id="stage" aria-labelledby="stage-title">
          <h2 class="sr-only" id="stage-title">Camera</h2>

          <div class="frame" id="frame">
            <video id="video" autoplay muted playsinline></video>
            <img id="photo" alt="The picture a face is read from" hidden>
            <canvas id="overlay" aria-hidden="true"></canvas>
            <div class="placeholder" id="placeholder">
              <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                <circle cx="32" cy="32" r="21" stroke-dasharray="3 4.5"/>
                <circle cx="25.5" cy="27.5" r="2" fill="currentColor" stroke="none"/>
                <circle cx="38.5" cy="27.5" r="2" fill="currentColor" stroke="none"/>
                <path d="M24.5 38c2.3 2.9 5 4.3 7.5 4.3s5.2-1.4 7.5-4.3" stroke-linecap="round"/>
              </svg>
              <p id="notice">Camera off. Start the camera, or pick a photo, to read a face.</p>
            </div>
            <div class="readout" id="readout" data-band="calm" hidden>
              <span class="num" id="live-score">0</span>
              <span class="readout-text"><small>weirdness</small><b id="live-verdict"></b></span>
            </div>
            <div class="chips">
              <span class="chip" id="mode-chip" hidden><i class="dot" aria-hidden="true"></i><span id="mode-label">Recording</span></span>
              <span class="chip" id="model-chip">Loading face models…</span>
            </div>
          </div>

          <div class="controls">
            <button class="btn primary" id="start" type="button" disabled>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.7l1-1.6A1.5 1.5 0 0 1 9.5 4h5a1.5 1.5 0 0 1 1.3.7l1 1.6h1.7A2.5 2.5 0 0 1 21 8.8v8.7A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5Z"/>
                <circle cx="12" cy="13" r="3.6"/>
              </svg>
              <span id="start-label">Loading face models…</span>
            </button>
            <button class="btn" id="snap" type="button" disabled>Capture now <kbd>C</kbd></button>
            <label class="btn file">Use a photo<input id="file" type="file" accept="image/*"></label>
          </div>

          <p class="status" id="status" role="status" aria-live="polite">Loading the face models…</p>
          <p class="flash" id="flash" role="status" hidden></p>

          <details class="settings" id="settings">
            <summary>
              <span class="settings-title">Capture settings</span>
              <span class="settings-hint" id="settings-hint"></span>
            </summary>
            <div class="settings-body">
              <label class="row">Auto capture
                <select id="interval">
                  <option value="2">every 2s</option>
                  <option value="5">every 5s</option>
                  <option value="15">every 15s</option>
                  <option value="30">every 30s</option>
                  <option value="60">every minute</option>
                  <option value="0">only by hand</option>
                </select>
              </label>
              <div class="row"><label for="threshold">Same person under</label>
                <span class="row-value"><input id="threshold" type="range" min="0.3" max="0.8" step="0.01"><output id="threshold-out" for="threshold"></output></span>
              </div>
              <div class="row"><span>Sound</span>
                <button class="btn small" id="sound" type="button" aria-pressed="true">Sound on</button>
              </div>
            </div>
          </details>

          <div class="drivers">
            <div class="drivers-head">
              <h3>What is driving it</h3>
              <p class="hint" id="drivers-hint">Waiting for a face</p>
            </div>
            <ul class="factors" id="factors"></ul>
          </div>
        </section>

        <aside class="side">
          <section class="card people-card" aria-labelledby="people-title">
            <div class="card-head">
              <h2 id="people-title">People <span class="count" id="people-count">0</span></h2>
              <button class="linkish" id="compare-hint" type="button">Compare</button>
            </div>
            <ul class="people" id="people"></ul>
          </section>

          <section class="card detail" aria-label="The selected person">
            <div class="detail-head">
              <span class="avatar" id="detail-avatar" aria-hidden="true"></span>
              <div class="who">
                <input class="name-input" id="rename" aria-label="Name of this person" maxlength="40" placeholder="No one selected" disabled>
                <p class="detail-meta" id="detail-meta">Capture a face to start the history.</p>
              </div>
              <details class="menu" id="person-menu">
                <summary title="More actions for this person" aria-label="More actions for this person">⋯</summary>
                <div class="pop">
                  <label class="pop-label">Merge into
                    <select id="merge" aria-label="Merge this person into another person"></select>
                  </label>
                  <button class="btn small danger" id="delete" type="button">Delete person</button>
                </div>
              </details>
            </div>

            <div class="tabs" role="tablist" aria-label="Person views">
              <button class="tab" id="tab-history" type="button" role="tab" aria-selected="true" aria-controls="panel-history" tabindex="0">History</button>
              <button class="tab" id="tab-compare" type="button" role="tab" aria-selected="false" aria-controls="panel-compare" tabindex="-1">Compare <span class="badge" id="compare-count" hidden>0</span></button>
            </div>

            <div class="panel" id="panel-history" role="tabpanel" aria-labelledby="tab-history" tabindex="0">
              <dl class="stats" id="stats"></dl>
              <p class="verdict-line" id="verdict-line"><b id="verdict-headline">No readings yet</b><span id="verdict-detail">A person appears here once a face has been captured.</span></p>
              <div class="chart" id="history-chart"></div>
              <div class="subhead"><h3>Latest faces</h3><span class="hint" id="shots-hint">The newest 24 are kept</span></div>
              <div class="shots" id="shots"></div>
            </div>

            <div class="panel" id="panel-compare" role="tabpanel" aria-labelledby="tab-compare" tabindex="0" hidden>
              <div class="chart" id="compare-chart"></div>
              <div id="compare-table"></div>
            </div>
          </section>
        </aside>
      </main>
    </div>
    <script>
      (function () {
        var base = location.pathname.replace(/\\/+$/, '') + '/'
        var home = new URL('..', new URL(base, location.origin))
        var link = document.getElementById('home')
        if (link) link.setAttribute('href', home.pathname)
        var script = document.createElement('script')
        script.type = 'module'
        script.src = base + 'client.js?v=${version}'
        document.head.appendChild(script)
      })()
    </script>
  </body>
</html>`
