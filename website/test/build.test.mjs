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

test('staticwebapp.config.json falls back to the portal for /portal/* and still serves the video as video/mp4', () => {
  const swa = JSON.parse(readFileSync(join(website, 'src', 'staticwebapp.config.json'), 'utf8'));
  assert.equal(swa.navigationFallback.rewrite, '/portal/index.html');
  assert.ok(swa.navigationFallback.exclude.includes('/portal/static/*'), 'the portal bundle is served as files');
  assert.equal(swa.mimeTypes['.mp4'], 'video/mp4');
  assert.equal(swa.mimeTypes['.woff2'], 'font/woff2');
  });

// Resolves the headers Static Web Apps sends for a path, following its documented rules:
// globalHeaders on every response; a matching route's headers override same-named ones, but
// route rules are not applied to a request answered by navigationFallback (a deep link such as
// /portal/feed). `files` is the set of paths that exist in dist/.
const glob = (pattern) => new RegExp(`^${pattern.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\{([^}]*)\}/g, (_, alts) => `(${alts.split(',').join('|')})`).replace(/\*/g, '.*')}$`);
const resolveHeaders = (swa, path, files) => {
  const file = path.endsWith('/') ? `${path}index.html` : path;
  const excluded = swa.navigationFallback.exclude.some((p) => glob(p).test(path));
  if (!files.has(file) && excluded) return { status: 404 };
  const fallback = !files.has(file);
  const route = fallback ? undefined : swa.routes.find((r) => r.route === path || glob(r.route).test(path) || (r.route === '/index.html' && path === '/'));
  return { status: 200, served: fallback ? swa.navigationFallback.rewrite : file, headers: { ...swa.globalHeaders, ...(route?.headers ?? {}) } };
};

const SITE_FILES = new Set(['/index.html', '/styles.css', '/favicon.svg', '/portal/index.html', '/portal/static/js/main.js']);

test('every response gets the security headers', () => {
  const swa = JSON.parse(readFileSync(join(website, 'src', 'staticwebapp.config.json'), 'utf8'));
  const h = swa.globalHeaders;
  assert.match(h['Strict-Transport-Security'], /max-age=63072000; includeSubDomains/);
  assert.equal(h['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
});

test('the marketing page (/ and /index.html) gets a CSP with no script at all, no framing and no camera', () => {
  const swa = JSON.parse(readFileSync(join(website, 'src', 'staticwebapp.config.json'), 'utf8'));
  for (const path of ['/', '/index.html']) {
    const { served, headers: h } = resolveHeaders(swa, path, SITE_FILES);
    assert.equal(served, '/index.html', path);
    const csp = h['Content-Security-Policy'];
    assert.match(csp, /default-src 'none'/, path);
    assert.match(csp, /frame-ancestors 'none'/, path);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|script-src/, `${path}: the page has no JavaScript at all`);
    assert.equal(h['X-Frame-Options'], 'DENY', path);
    assert.match(h['Permissions-Policy'], /camera=\(\)/, path);
    assert.equal(h['Strict-Transport-Security'], swa.globalHeaders['Strict-Transport-Security'], `${path} keeps the global headers`);
  }
});

test('portal deep links, served by navigationFallback, get the portal CSP: no inline script, framed by itself only (MSAL), camera for the QR scanner', () => {
  const swa = JSON.parse(readFileSync(join(website, 'src', 'staticwebapp.config.json'), 'utf8'));
  // /portal/auth-end is where MSAL's redirect lands; /typo shows unknown paths fall back too.
  for (const path of ['/portal/', '/portal/feed', '/portal/wallet', '/portal/auth-end', '/portal/static/js/main.js', '/typo']) {
    const { status, headers: h } = resolveHeaders(swa, path, SITE_FILES);
    assert.equal(status, 200, path);
    const csp = h['Content-Security-Policy'];
    const script = csp.split(';').find((d) => d.trim().startsWith('script-src'));
    assert.ok(script, `${path} has a script-src`);
    assert.doesNotMatch(script, /unsafe-inline|'unsafe-eval'/, path);
    assert.match(csp, /frame-ancestors 'self'/, path);
    assert.match(csp, /https:\/\/login\.microsoftonline\.com/, path);
    assert.equal(h['X-Frame-Options'], 'SAMEORIGIN', path);
    assert.match(h['Permissions-Policy'], /camera=\(self\)/, path);
  }
  assert.equal(resolveHeaders(swa, '/portal/feed', SITE_FILES).served, '/portal/index.html');
  assert.equal(resolveHeaders(swa, '/portal/static/js/missing.js', SITE_FILES).status, 404, 'a missing bundle file is a 404, not the app');
});

test('no portal path is matched by a route, as routes are skipped for fallback responses in production', () => {
  const swa = JSON.parse(readFileSync(join(website, 'src', 'staticwebapp.config.json'), 'utf8'));
  for (const r of swa.routes) assert.doesNotMatch(r.route, /^\/portal/, `${r.route}: put portal headers in globalHeaders`);
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
