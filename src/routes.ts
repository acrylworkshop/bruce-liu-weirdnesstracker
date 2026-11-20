import type { Context } from '@deepseek-ai/cordis'
import { type Home, renderWidgets } from '../plugins/home/index.ts'
import { Acryl } from '../plugins/router/src/index.ts'
import { aboutPage } from './about.tsx'
import { FIRST_PAGE_MARKER } from './first-page.ts'

export const APP_NAME = 'weirdnesstracker'

/**
 * The only place the app's mount prefix is named. On its own server (production, `npm start`) the app mounts at the root and
 * its public URLs are `/`, `/about`, `/health`; when the ACRYL frame hosts it (`npm run dev`) the routes mount here, and the
 * frame opens its tile at `/app` (`/app/` answers too). Every page link and asset URL this template writes is derived from the prefix it is
 * mounted at, so the same source serves both.
 */
export const FRAME_MOUNT_PREFIX = '/app'

/** The scaffold's name comes from the folder, so the first screen escapes it like any other user text. */
const escapeHtml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

/**
 * The first screen: the page a browser gets at the root, which is what the ACRYL frame's first tile shows. It is a real
 * front door rather than a template notice: what the app does in two lines, then the widgets the feature plugins put
 * there (`ctx.home`), which is the tracker's people and readings, then the way into the full page.
 *
 * The About link is relative, so it works under the frame's /app mount and on the app's own server alike. The blank
 * template's first-page marker stays in an inert attribute, so a probe that looks for it in the markup still finds it
 * while the page a person reads says what the app actually does.
 */
const homePage = (name: string, widgets: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>${escapeHtml(name)}</title>
    <style>
      :root{color-scheme:light dark;--bg:#f6f6fa;--text:#16161c;--dim:#67677a;--line:#e3e3ea;--accent:#5b5bd6;--accent-soft:rgba(91,91,214,.12)}
      @media (prefers-color-scheme:dark){:root{--bg:#0a0a0e;--text:#ececf2;--dim:#9898a8;--line:#26262f;--accent:#8b8cff;--accent-soft:rgba(139,140,255,.14)}}
      *{box-sizing:border-box}
      body{margin:0;min-height:100vh;background:radial-gradient(920px 420px at 50% -200px,var(--accent-soft),transparent 72%),var(--bg);color:var(--text);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
      .wrap{max-width:46rem;margin:0 auto;padding:52px 20px 64px}
      .eyebrow{margin:0 0 10px;font-size:.72rem;font-weight:650;letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
      h1{font-size:2rem;line-height:1.1;letter-spacing:-.03em;margin:0 0 10px}
      .lede{margin:0 0 30px;color:var(--dim);font-size:1rem;max-width:52ch}
      footer{margin-top:34px;padding-top:18px;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:8px 18px;justify-content:space-between;align-items:baseline;font-size:.82rem;color:var(--dim)}
      footer nav{display:flex;gap:14px}
      a{color:var(--accent);text-decoration:none}
      a:hover{text-decoration:underline}
    </style>
  </head>
  <body>
    <main class="wrap" data-first-page="${FIRST_PAGE_MARKER}">
      <p class="eyebrow">Face measuring machine</p>
      <h1>${escapeHtml(name)}</h1>
      <p class="lede">The camera reads your face, scores how weird it looks and keeps a picture of every reading. Point it at yourself and find out how strange you can get.</p>
      ${widgets}
      <footer>
        <span>Everything stays on this machine.</span>
        <nav><a href="./about">About</a></nav>
      </footer>
    </main>
  </body>
</html>`

/**
 * The app's own pages and routes, mountable at any prefix: the standalone server mounts it at the root, the frame host at {@link FRAME_MOUNT_PREFIX}.
 * The first screen shows the widgets of the app's plugins (`ctx.home`), read at each request, so a plugin switched on or off shows at the next load.
 */
export function makeApp(home: Home, name: () => string = () => APP_NAME): Acryl {
  return (
    new Acryl()
      // A browser gets the first screen; an API client gets the JSON hello.
      .get('/', async (c) =>
        (c.req.header('accept') ?? '').includes('text/html')
          ? c.html(homePage(name(), await renderWidgets(home)))
          : c.json({ app: name(), ok: true }),
      )
      .get('/health', (c) => c.json({ ok: true }))
      .get('/about', (c) => c.html(aboutPage()))
  )
}

/** The app's own routes: an `App` mounted on the router at `options.prefix` (empty or absent: the root). The mount is removed when this plugin is disposed. */
export const routes = {
  name: 'routes',
  inject: ['router', 'home'],
  apply(ctx: Context, options: { readonly prefix?: string } = {}) {
    const prefix = options.prefix ?? ''
    // The name the app has now (Settings > App renames it), else the one the scaffold was made with.
    ctx.router.route(
      prefix === '' ? '/' : prefix,
      makeApp(ctx.home, () => ctx.get('appInstance')?.name ?? APP_NAME),
    )
  },
}
