// Builds the site into a scratch copy and checks what the deploy relies on.
// No dependencies: node --test website/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const website = join(dirname(fileURLToPath(import.meta.url)), '..');

// build.mjs writes dist/ next to itself, so each test builds a copy of website/
// in a temporary directory and leaves the real dist/ alone.
const buildCopy = (env = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'getzaplie-'));
  const copy = join(dir, 'website');
  cpSync(website, copy, { recursive: true, filter: (p) => !p.includes(`${join('website', 'dist')}`) && !p.includes(`${join('website', 'test')}`) });
  const output = execFileSync(process.execPath, [join(copy, 'build.mjs')], {
    env: { ...process.env, PORTAL_DIST: join(dir, 'no-portal-here'), ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { dir, dist: join(copy, 'dist'), output };
};

// A real bundle can contain text shaped like a {{placeholder}}; the build must leave it alone.
const PORTAL_SCRIPT = 'const t = "{{count}} zaps";';

const fakePortal = (dir, scriptSrc, iconHref = '/portal/favicon.ico') => {
  const portal = join(dir, 'portal-build');
  mkdirSync(join(portal, 'static', 'js'), { recursive: true });
  writeFileSync(join(portal, 'index.html'), `<!doctype html><html><head><link rel="icon" href="${iconHref}"/><script defer="defer" src="${scriptSrc}"></script></head><body><div id="root"></div></body></html>`);
  writeFileSync(join(portal, 'static', 'js', 'main.js'), PORTAL_SCRIPT);
  return portal;
};

test('the header has a Login button that opens the portal at /portal/', (t) => {
  const { dir, dist } = buildCopy();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.match(header, /<a class="btn[^"]*" href="\/portal\/">Login<\/a>/);
  assert.match(header, /Get Zaplie/, 'the Get Zaplie button stays');
});

test('no {{placeholder}} survives the build', (t) => {
  const { dir, dist } = buildCopy();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of ['index.html', 'styles.css']) {
    assert.doesNotMatch(readFileSync(join(dist, file), 'utf8'), /\{\{\s*\w+\s*\}\}/, file);
  }
});

test('staticwebapp.config.json has no site-wide fallback, sends 404s to /404.html, and still serves the video as video/mp4', () => {
  const swa = JSON.parse(readFileSync(join(website, 'src', 'staticwebapp.config.json'), 'utf8'));
  assert.equal(swa.navigationFallback, undefined, 'a site-wide fallback would answer every unknown path with 200');
  assert.deepEqual(swa.responseOverrides['404'], { rewrite: '/404.html' }, 'no statusCode, so the response stays a 404');
  assert.equal(swa.mimeTypes['.mp4'], 'video/mp4');
  assert.equal(swa.mimeTypes['.woff2'], 'font/woff2');
});

// Resolves what Static Web Apps sends for a path, following its documented rules
// (learn.microsoft.com/azure/static-web-apps/configuration): routes are tried in order and the
// first match wins; `/portal/*` does not match `/portal`; a rewrite serves another file; a path with
// no file is a 404, answered by responseOverrides; globalHeaders go on every response, and a matched
// route's headers replace same-named ones. `files` is the set of paths that exist in dist/.
const glob = (pattern) => new RegExp(`^${pattern.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\{([^}]*)\}/g, (_, alts) => `(${alts.split(',').join('|')})`).replace(/\*/g, '.*')}$`);
const resolve = (swa, path, files) => {
  const route = swa.routes.find((r) => glob(r.route).test(path));
  const target = route?.rewrite ?? path;
  const file = [target, `${target.replace(/\/$/, '')}/index.html`].find((f) => files.has(f));
  const headers = { ...swa.globalHeaders, ...(route?.headers ?? {}) };
  if (file) return { status: 200, served: file, headers };
  return { status: 404, served: swa.responseOverrides['404'].rewrite, headers };
};

const SITE_FILES = new Set(['/index.html', '/404.html', '/styles.css', '/404.css', '/favicon.svg', '/img/zaplie-hero.webp', '/portal/index.html', '/portal/manifest.json', '/portal/favicon.ico', '/portal/static/js/main.js', '/portal/static/media/logo.svg']);
const PORTAL_ROUTES = ['/portal', '/portal/', '/portal/feed', '/portal/wallet', '/portal/rewards', '/portal/settings', '/portal/users', '/portal/automations', '/portal/reports', '/portal/login', '/portal/auth-start', '/portal/auth-end', '/portal/feed/anything/deeper'];
const loadSwa = () => JSON.parse(readFileSync(join(website, 'src', 'staticwebapp.config.json'), 'utf8'));

const assertMarketingHeaders = (h, path) => {
  const csp = h['Content-Security-Policy'];
  assert.match(csp, /default-src 'none'/, path);
  assert.match(csp, /frame-ancestors 'none'/, path);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|script-src/, `${path}: no JavaScript at all`);
  assert.equal(h['X-Frame-Options'], 'DENY', path);
  assert.match(h['Permissions-Policy'], /camera=\(\)/, path);
};
const assertPortalHeaders = (h, path) => {
  const csp = h['Content-Security-Policy'];
  const script = csp.split(';').find((d) => d.trim().startsWith('script-src'));
  assert.ok(script, `${path} has a script-src`);
  assert.doesNotMatch(script, /unsafe-inline|'unsafe-eval'/, path);
  assert.match(csp, /frame-ancestors 'self'/, path);
  assert.match(csp, /https:\/\/login\.microsoftonline\.com/, path);
  assert.equal(h['X-Frame-Options'], 'SAMEORIGIN', path);
  assert.match(h['Permissions-Policy'], /camera=\(self\)/, path);
};

test('every response gets the security headers', () => {
  const h = loadSwa().globalHeaders;
  assert.match(h['Strict-Transport-Security'], /max-age=63072000; includeSubDomains/);
  assert.equal(h['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
});

test('the marketing page gets the strict CSP (no script, no framing, no camera) from globalHeaders', () => {
  const swa = loadSwa();
  for (const path of ['/', '/index.html']) {
    const { status, served, headers } = resolve(swa, path, SITE_FILES);
    assert.equal(status, 200, path);
    assert.equal(served, '/index.html', path);
    assertMarketingHeaders(headers, path);
  }
});

test('unknown paths outside the portal are real 404s with the 404 page and the strict CSP', () => {
  const swa = loadSwa();
  for (const path of ['/typo', '/foo/bar', '/foo/', '/index.htm', '/portalx', '/img/missing.webp', '/missing.css']) {
    const { status, served, headers } = resolve(swa, path, SITE_FILES);
    assert.equal(status, 404, path);
    assert.equal(served, '/404.html', path);
    assertMarketingHeaders(headers, path);
  }
});

test('every portal route, including MSAL\'s /portal and /portal/auth-end, serves the portal with the portal CSP', () => {
  const swa = loadSwa();
  for (const path of PORTAL_ROUTES) {
    const { status, served, headers } = resolve(swa, path, SITE_FILES);
    assert.equal(status, 200, path);
    assert.equal(served, '/portal/index.html', path);
    assertPortalHeaders(headers, path);
  }
});

test('portal files are served as themselves, and a missing one is a 404, not the app', () => {
  const swa = loadSwa();
  for (const path of ['/portal/static/js/main.js', '/portal/static/media/logo.svg', '/portal/manifest.json', '/portal/favicon.ico']) {
    const { status, served } = resolve(swa, path, SITE_FILES);
    assert.equal(status, 200, path);
    assert.equal(served, path, `${path} is not rewritten to index.html`);
  }
  for (const path of ['/portal/static/js/missing.js', '/portal/nope.png', '/portal/asset-manifest.json', '/portal/static/anything']) {
    assert.equal(resolve(swa, path, SITE_FILES).status, 404, path);
  }
});

test('the portal routes all carry the same headers, and only portal paths get them', () => {
  const swa = loadSwa();
  const portalRoutes = swa.routes.filter((r) => r.route === '/portal' || r.route.startsWith('/portal/'));
  assert.equal(portalRoutes.length, swa.routes.length, 'every route is a portal route; the rest of the site uses globalHeaders');
  for (const r of portalRoutes) assert.deepEqual(r.headers, portalRoutes[0].headers, r.route);
  const last = swa.routes.at(-1);
  assert.deepEqual(last, { route: '/portal/*', rewrite: '/portal/index.html', headers: last.headers }, 'the portal catch-all comes last, after the file rules');
});

test('404.html is built: placeholders filled, no inline style or script, root-relative URLs, noindex, and the marketing CSP again as a meta tag', (t) => {
  const { dir, dist } = buildCopy();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const html = readFileSync(join(dist, '404.html'), 'utf8');
  assert.doesNotMatch(html, /\{\{\s*\w+\s*\}\}/);
  assert.match(html, /href="mailto:support@knowall\.ai\?subject=/, 'the support address is filled in');
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(html, /rel="canonical"/, 'a 404 is not a canonical page');
  assert.doesNotMatch(html, /<script|<style|\sstyle="|\son\w+="/i, 'nothing the strict CSP would block');
  assert.match(html, /href="\/portal\/">Login</);
  assert.match(html, /href="\/"/, 'a way back to the homepage');
  // Served at any depth (/a/b/c), so a relative URL would break.
  const urls = [...html.matchAll(/\s(?:src|href|srcset)="([^"#]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:|mailto:)/.test(u));
  assert.ok(urls.length > 0);
  for (const u of urls) for (const part of u.split(',')) assert.match(part.trim(), /^\//, `${u} must be root-relative`);
  const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)[1];
  const header = loadSwa().globalHeaders['Content-Security-Policy'];
  assert.equal(meta, header.replace(" frame-ancestors 'none';", ''), 'same policy as the header, minus frame-ancestors (header-only)');
  assert.ok(existsSync(join(dist, '404.css')));
});

test('without a portal build, /portal/ says so instead of 404ing', (t) => {
  const { dir, dist, output } = buildCopy();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.ok(existsSync(join(dist, 'index.html')));
  const page = readFileSync(join(dist, 'portal', 'index.html'), 'utf8');
  assert.match(page, /isn't on this site yet/);
  assert.match(page, /mailto:support@knowall\.ai/, 'the support address is filled in');
  assert.doesNotMatch(page, /\{\{\s*\w+\s*\}\}/);
  assert.equal(existsSync(join(dist, 'portal-unavailable.html')), false, 'the template is not published on its own');
  assert.match(output + '', /Built /);
});

test('a portal built for /portal/ is copied to dist/portal', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'getzaplie-portal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const portal = fakePortal(dir, '/portal/static/js/main.js');
  const built = buildCopy({ PORTAL_DIST: portal });
  t.after(() => rmSync(built.dir, { recursive: true, force: true }));
  assert.ok(existsSync(join(built.dist, 'portal', 'index.html')));
  assert.equal(readFileSync(join(built.dist, 'portal', 'static', 'js', 'main.js'), 'utf8'), PORTAL_SCRIPT, 'the portal bundle is copied untouched');
});

test('a portal built for the root is refused', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'getzaplie-portal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const portal = fakePortal(dir, '/static/js/main.js');
  assert.throws(() => buildCopy({ PORTAL_DIST: portal }), /not built for \/portal\//);
});

test('a portal with one asset outside /portal/ is refused too', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'getzaplie-portal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const portal = fakePortal(dir, '/static/js/main.js', '/portal/favicon.ico');
  assert.throws(() => buildCopy({ PORTAL_DIST: portal }), /not built for \/portal\/.*\/static\/js\/main\.js/);
});

test('a portal whose index has no root-relative URL at all is refused', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'getzaplie-portal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const portal = fakePortal(dir, 'static/js/main.js', 'favicon.ico');
  assert.throws(() => buildCopy({ PORTAL_DIST: portal }), /not built for \/portal\//);
});
