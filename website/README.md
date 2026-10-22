# getzapl.ie

The Zaplie website: one static page in plain HTML and CSS, no framework, no JavaScript, no third-party requests (the fonts are self-hosted), plus the signed-in Zaplie portal at `/portal/` (a React app built from [knowall-ai/zaplie-bot](https://github.com/knowall-ai/zaplie-bot), see below). It follows the layout of the Wardie site ([getward.ie](https://getward.ie)).

## Layout

| Path | What it is |
|---|---|
| `site.config.json` | **The one place for links and addresses**: the site URL, the sales and support email addresses, the repository and design links, and the copyright year. |
| `build.mjs` | A tiny build with no dependencies: copies `src/` to `dist/` and replaces each `{{placeholder}}` with the value from `site.config.json`. It fails if a placeholder is unknown. |
| `src/index.html` | The page. |
| `src/styles.css` | The styles: Zaplie's tokens (Bitcoin orange `#F7931A` on near-black `#0B0A09`), Playfair Display headings and Mulish body text. |
| `src/fonts/` | Mulish and Playfair Display (latin, WOFF2) from `@fontsource`, under the SIL Open Font Licence (licences alongside). |
| `src/img/` | Zaplie's images, the app mockups, the explainer video and the social preview (see below). |
| `src/CNAME` | `getzapl.ie`, for GitHub Pages. Harmless elsewhere. |
| `src/staticwebapp.config.json` | Azure Static Web Apps settings: the right content type for the video, fonts and WebP images, two security headers, and the fallback that serves the portal for `/portal/*` (see below). |
| `src/portal-unavailable.html` | What `/portal/` shows when the site is built without a portal (see below). Not published on its own. |
| `test/build.test.mjs` | `node --test website/test/build.test.mjs`: builds a copy of the site and checks the Login button, the placeholders, the Static Web Apps settings and the portal copy. No dependencies. |

## The Zaplie portal at /portal/

**Login** (top right) opens the Zaplie portal at `/portal/`. The portal is the same React app the Microsoft Teams tabs use (`tabs/` in [knowall-ai/zaplie-bot](https://github.com/knowall-ai/zaplie-bot)), built once more for this path. In a normal browser it shows its own header and footer; inside Teams they stay hidden. One site, one deployment:

```bash
# in a zaplie-bot checkout
cd tabs && npm ci
PUBLIC_URL=/portal \
REACT_APP_AAD_CLIENT_ID=<app registration client id> \
REACT_APP_TENANT_ID=<tenant id> \
REACT_APP_API_BASE_URL=https://<portal backend host> \
npm run build                    # builds tabs/build for /portal/

# back here
node website/build.mjs           # copies it into website/dist/portal
```

The portal source must support being served from `/portal/` (`tabs/src/services/appLocation.ts`, added by [knowall-ai/zaplie-bot PR 488](https://github.com/knowall-ai/zaplie-bot/pull/488)). The deploy workflow builds it from zaplie-bot's `main` and stops with an error if that support isn't there yet, or if `PORTAL_AAD_CLIENT_ID` is set without `PORTAL_AAD_TENANT_ID` and `PORTAL_API_BASE_URL`.

`build.mjs` looks for the portal build in a `zaplie-bot` checkout next to this repository (`../zaplie-bot/tabs/build`); `PORTAL_DIST=/path/to/tabs/build node website/build.mjs` points it elsewhere. Without a build the marketing page still builds, with a warning, and `/portal/` is a short page (`src/portal-unavailable.html`) saying the portal is not on this site yet, so Login never leads to a 404. A build made for the root of its own host (no `PUBLIC_URL`) is refused, as its scripts would not load from `/portal/`.

What the portal needs, and why:

- `PUBLIC_URL=/portal` sets the base path: asset URLs, the router and the Microsoft sign-in redirect (`https://getzapl.ie/portal` and `https://getzapl.ie/portal/auth-end`).
- `REACT_APP_API_BASE_URL` is the Express backend the portal talks to (the zaplie-bot App Service, which serves `/api/*` and the LNbits gateway). The Static Web App serves files only, so the portal here calls that backend across origins; it allows that already (`cors()`).
- `REACT_APP_AAD_CLIENT_ID` and `REACT_APP_TENANT_ID` are the app registration the Teams app uses. They are public identifiers, not secrets. **The app registration must list** `https://getzapl.ie/portal`, `https://getzapl.ie/portal/auth-end`, `https://www.getzapl.ie/portal` and `https://www.getzapl.ie/portal/auth-end` as single-page application redirect URIs.
- Never put an LNbits key or password in a `REACT_APP_*` variable: Create React App inlines them into the public bundle. The deploy workflow refuses a bundle that names one.

The deploy workflow builds the portal when the repository secret `PORTAL_AAD_CLIENT_ID` is set (with `PORTAL_AAD_TENANT_ID`, `PORTAL_API_BASE_URL`, and the optional `PORTAL_LNBITS_STORE_ID`, `PORTAL_LNBITS_STORE_OWNER_EMAIL`, `PORTAL_LNBITS_POINTS_LABEL`), and deploys the marketing page alone until then.

`staticwebapp.config.json` has a `navigationFallback` to `/portal/index.html`, so a refresh on `/portal/feed` or a sign-in landing on `/portal/auth-end` loads the app; the portal's `static/` bundle, the site's images, fonts and other files are excluded, so a missing file is still a 404. Static Web Apps has one fallback for the whole site, so an unknown path on the marketing page (there is only one page) also lands in the portal, which sends it to its login.

## Images

Zaplie's images come from his character kit in [knowall-ai/zaplie-bot](https://github.com/knowall-ai/zaplie-bot) (`assets/agent/`), exported to WebP for the web:

| File | From the kit | Used for |
|---|---|---|
| `zaplie-hero.webp`, `zaplie-hero-960.webp` | `images/zaplie-hero.jpg` | The hero (1920 px wide; 960 px on phones) |
| `zaplie-zapping.webp`, `zaplie-gift.webp`, `zaplie-celebrate.webp` | `images/` | How it works, steps 1 to 3 |
| `zaplie-wave.webp` | `images/zaplie-wave.jpg` | For organisations |
| `zaplie-electrified-subtle.webp` | `images/zaplie-electrified-subtle.jpg` | The closing call to action |
| `zaplie-profile.webp`, `apple-touch-icon.png` | `images/zaplie-profile.jpg` | The header logo and the home-screen icon |
| `zaplie-explainer.mp4`, `zaplie-explainer-poster.webp` | `video/zaplie-explainer.mp4` | Meet Zaplie (re-encoded at CRF 26 to 3 MB; the poster is the frame at 4 s) |
| `social-preview.png` | `CoverImage-SocialPreview.png` | Link previews (Open Graph and Twitter) |
| `screen-*.webp` | `docs/design/*.png` | See it: the Teams mockups |

To refresh an image, export it again at the same size and name.

## Preview locally

```bash
node website/build.mjs
python3 -m http.server 8080 --directory website/dist
# open http://localhost:8080/
```

Any static file server works. Rebuild after each change to `src/` or `site.config.json`.

## Deploy

The site is the contents of `website/dist/` after `node website/build.mjs`, so any static host works. It's set up for **Azure Static Web Apps**, like sergeantsamm.ie:

1. In Azure, create a Static Web App on the Free plan, with **Other** as the deployment source (no build pipeline).
2. Copy its deployment token (**Overview → Manage deployment token**) into this repository's secrets as `AZURE_STATIC_WEB_APPS_API_TOKEN`.
3. Run the **Deploy** workflow (Actions → Deploy → Run workflow). From then on, every push to `main` builds and deploys the site (`.github/workflows/deploy.yml`).
4. In the Static Web App's **Custom domains**, add `getzapl.ie` and `www.getzapl.ie`, and create the DNS records it asks for at Gandi (a TXT record to validate the apex and an ALIAS record pointing at the app; a CNAME for `www`).

`getzapl.ie` is registered with Gandi and currently shows Gandi's placeholder page until its DNS points at the app.

`src/CNAME` is only for GitHub Pages, if the site ever moves there; Azure ignores it.
