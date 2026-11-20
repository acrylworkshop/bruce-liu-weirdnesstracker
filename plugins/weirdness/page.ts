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
 */

const STYLES = `
:root{color-scheme:dark light;--bg:#0a0a0e;--panel:#15151c;--panel-2:#1d1d26;--line:#2a2a35;--text:#ececf2;--dim:#9c9caa;--accent:#7c8cff;--accent-soft:rgba(124,140,255,.16);--hot:#ff6b81;--warm:#ffd166;--cool:#4dd4ac}
@media (prefers-color-scheme:light){:root{--bg:#f5f5f9;--panel:#ffffff;--panel-2:#f1f1f6;--line:#e0e0e8;--text:#17171d;--dim:#62626f;--accent:#5468ff;--accent-soft:rgba(84,104,255,.13);--hot:#d9480f;--warm:#b8860b;--cool:#0f8f6f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;max-width:1240px;margin:0 auto;padding:26px 22px 10px}
h1{font-size:1.5rem;margin:0 0 4px;letter-spacing:-.01em}
h2{font-size:.95rem;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:22px 0 10px}
h2:first-child{margin-top:0}
p{margin:0 0 10px}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.lede{color:var(--dim);margin:0;max-width:52ch}
.home{flex:none;padding:8px 14px;border:1px solid var(--line);border-radius:10px;color:var(--text);background:var(--panel)}
main{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:22px;max-width:1240px;margin:0 auto;padding:12px 22px 48px;align-items:start}
@media (max-width:940px){main{grid-template-columns:minmax(0,1fr)}}
.stage,.side{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:16px}
.frame{position:relative;aspect-ratio:4/3;background:#05050a;border-radius:14px;overflow:hidden;border:1px solid var(--line)}
.frame video,.frame img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
.frame video{transform:scaleX(-1)}
.frame canvas{position:absolute;inset:0;width:100%;height:100%}
.badge{position:absolute;left:12px;top:12px;display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:8px 14px;border-radius:12px;background:rgba(8,8,14,.72);color:#fff;backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,.14)}
.badge span{font-size:2rem;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}
.badge small{font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;opacity:.7}
.notice{position:absolute;inset:auto 12px 12px;margin:0;padding:8px 12px;border-radius:10px;background:rgba(8,8,14,.72);color:#e9e9f2;font-size:.86rem}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 4px}
button,.file{padding:8px 14px;border-radius:10px;border:1px solid var(--line);background:var(--panel-2);color:var(--text);font:inherit;cursor:pointer}
button:hover,.file:hover{border-color:var(--accent)}
button:disabled{opacity:.45;cursor:not-allowed}
button.primary{background:var(--accent);border-color:transparent;color:#fff;font-weight:600}
.file{position:relative;overflow:hidden}
.file input{position:absolute;inset:0;opacity:0;cursor:pointer}
.tuning{display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin:10px 0 0;color:var(--dim);font-size:.86rem}
.tuning label{display:flex;align-items:center;gap:8px}
select,input[type=range]{accent-color:var(--accent);background:var(--panel-2);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:5px 8px;font:inherit}
input[type=range]{padding:0}
.status{color:var(--dim);font-size:.84rem;margin:10px 0 0;min-height:1.2em}
.factors{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:8px;margin-top:12px}
.factor{background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:7px 9px}
.factor b{display:block;font-size:.76rem;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
.factor i{display:block;height:5px;border-radius:3px;background:var(--accent);margin-top:6px;opacity:.85}
.factor em{font-style:normal;font-size:.78rem;color:var(--dim);font-variant-numeric:tabular-nums}
.people{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.person{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;gap:8px;padding:8px;border:1px solid var(--line);border-radius:12px;background:var(--panel-2)}
.person.active{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft) inset}
.person .name{min-width:0;background:transparent;border:1px solid transparent;border-radius:8px;padding:3px 5px;color:var(--text);font:inherit;font-weight:600}
.person .name:hover{border-color:var(--line)}
.person .name:focus{outline:none;border-color:var(--accent);background:var(--bg)}
.person .meta{display:block;color:var(--dim);font-size:.76rem;padding:0 6px;font-variant-numeric:tabular-nums}
.person .pick{display:flex;align-items:center;gap:6px;color:var(--dim);font-size:.76rem}
.person .drop{padding:2px 8px;border-radius:8px;color:var(--dim);background:transparent}
.merge{font-size:.76rem;padding:3px 6px;max-width:8.5rem}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:8px;margin:0}
.stats div{background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:7px 9px}
.stats dt{font-size:.7rem;text-transform:uppercase;letter-spacing:.07em;color:var(--dim)}
.stats dd{margin:2px 0 0;font-weight:600;font-variant-numeric:tabular-nums}
.chart{margin-top:4px}
.chart svg{width:100%;height:auto;display:block;overflow:visible}
.legend{display:flex;flex-wrap:wrap;gap:10px;font-size:.76rem;color:var(--dim);margin:6px 0 0}
.legend span{display:flex;align-items:center;gap:5px}
.legend i{width:10px;height:10px;border-radius:3px;display:inline-block}
table{width:100%;border-collapse:collapse;font-size:.84rem}
th,td{text-align:right;padding:5px 6px;border-top:1px solid var(--line);font-variant-numeric:tabular-nums}
th:first-child,td:first-child{text-align:left}
thead th{color:var(--dim);font-weight:500;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;border-top:0}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(78px,1fr));gap:8px}
.shots figure{margin:0;background:var(--panel-2);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.shots img{width:100%;aspect-ratio:1;object-fit:cover;display:block}
.shots figcaption{font-size:.72rem;padding:3px 5px;color:var(--dim);text-align:center;font-variant-numeric:tabular-nums}
.empty{color:var(--dim);font-size:.88rem}
.flash{margin:8px 0 0;padding:7px 11px;border-radius:9px;background:var(--accent-soft);color:var(--text);font-size:.84rem}
`

export const page = (version: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Weirdness tracker</title>
    <style>${STYLES}</style>
  </head>
  <body>
    <header>
      <div>
        <h1>Weirdness tracker</h1>
        <p class="lede">Point the camera at your face. The weirder it looks, the more points you collect, and the tracker keeps a picture and a score of every capture so you can see how your weirdness changes.</p>
      </div>
      <a class="home" id="home" href="./">Home</a>
    </header>
    <main>
      <section class="stage">
        <div class="frame">
          <video id="video" autoplay muted playsinline></video>
          <img id="photo" alt="A picture to read a face from" hidden>
          <canvas id="overlay"></canvas>
          <div class="badge" id="badge" hidden><span id="live-score">0</span><small>weirdness</small></div>
          <p class="notice" id="notice">Camera off</p>
        </div>
        <div class="actions">
          <button class="primary" id="start">Start camera</button>
          <button id="snap" disabled>Capture now</button>
          <label class="file">Use a photo<input id="file" type="file" accept="image/*"></label>
        </div>
        <div class="tuning">
          <label>Auto capture
            <select id="interval">
              <option value="2">every 2s</option>
              <option value="5">every 5s</option>
              <option value="15">every 15s</option>
              <option value="30">every 30s</option>
              <option value="60">every minute</option>
              <option value="0">only by hand</option>
            </select>
          </label>
          <label>Same person under <input id="threshold" type="range" min="0.3" max="0.8" step="0.01"><output id="threshold-out"></output></label>
        </div>
        <div class="factors" id="factors"></div>
        <p class="status" id="status"></p>
        <p class="flash" id="flash" hidden></p>
      </section>
      <aside class="side">
        <h2>People</h2>
        <ul class="people" id="people"></ul>
        <h2 id="history-title">History</h2>
        <dl class="stats" id="stats"></dl>
        <div class="chart" id="history-chart"></div>
        <h2>Compare</h2>
        <div class="chart" id="compare-chart"></div>
        <div id="compare-table"></div>
        <h2>Latest faces</h2>
        <div class="shots" id="shots"></div>
      </aside>
    </main>
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
