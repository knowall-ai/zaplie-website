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
  assert.equal(swa.globalHeaders['X-Content-Type-Options'], 'nosniff');
});

test('every response gets the security headers, and the marketing page a CSP with no inline script or style', () => {
  const swa = JSON.parse(readFileSync(join(website, 'src', 'staticwebapp.config.json'), 'utf8'));
  const h = swa.globalHeaders;
  assert.match(h['Strict-Transport-Security'], /max-age=63072000; includeSubDomains/);
  assert.equal(h['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.equal(h['X-Frame-Options'], 'DENY');
  assert.match(h['Permissions-Policy'], /camera=\(\)/);
  const csp = h['Content-Security-Policy'];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|script-src/, 'the page has no JavaScript at all');
});

test('the portal gets its own CSP: no inline script, framed by itself only (MSAL silent sign-in), camera for the QR scanner', () => {
  const swa = JSON.parse(readFileSync(join(website, 'src', 'staticwebapp.config.json'), 'utf8'));
  for (const route of ['/portal', '/portal/*']) {
    const r = swa.routes.find((x) => x.route === route);
    assert.ok(r, route);
    const csp = r.headers['Content-Security-Policy'];
    const script = csp.split(';').find((d) => d.trim().startsWith('script-src'));
    assert.doesNotMatch(script, /unsafe-inline|'unsafe-eval'/);
    assert.match(csp, /frame-ancestors 'self'/);
    assert.equal(r.headers['X-Frame-Options'], 'SAMEORIGIN');
    assert.match(r.headers['Permissions-Policy'], /camera=\(self\)/);
  }
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
