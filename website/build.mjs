#!/usr/bin/env node
// Builds getzapl.ie: copies src/ to dist/ and fills {{placeholders}} in HTML, CSS and JS
// from site.config.json (contact addresses and links live there, once).
// No dependencies. Run: node website/build.mjs
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'src');
const dist = join(root, 'dist');
const config = JSON.parse(readFileSync(join(root, 'site.config.json'), 'utf8'));

// Derived values, so the HTML never spells out an address or subject line by hand.
const values = {
  ...config,
  salesMailto: `mailto:${config.salesEmail}?subject=${encodeURIComponent('Zaplie')}`,
  supportMailto: `mailto:${config.supportEmail}?subject=${encodeURIComponent('Zaplie support')}`,
};

if (existsSync(dist)) rmSync(dist, { recursive: true });
cpSync(src, dist, { recursive: true, filter: (p) => !p.endsWith('portal-unavailable.html') });

const templated = new Set(['.html', '.css', '.js', '.xml', '.txt', '.webmanifest']);
const missing = new Set();

/**
 * Replaces each {{placeholder}} in one file with its value, noting any that are unknown.
 * Writes the result back, or returns it when `asText` is set (for a file kept outside dist/).
 */
function fill(file, asText = false) {
  const text = readFileSync(file, 'utf8');
  const out = text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    if (!(key in values)) missing.add(key);
    return values[key] ?? '';
  });
  if (asText) return out;
  writeFileSync(file, out);
}

/** Fills every templated file under a directory, recursively; font licences are left as they are. */
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (templated.has(extname(name)) && !name.startsWith('OFL-')) fill(path);
  }
}

walk(dist);

if (missing.size) {
  console.error(`Unknown placeholders: ${[...missing].join(', ')}`);
  process.exit(1);
}

// The Zaplie portal (Login, top right) is the signed-in part of the site, at /portal/. It is
// the Teams tabs app from knowall-ai/zaplie-bot built for that path:
//   cd zaplie-bot/tabs && PUBLIC_URL=/portal REACT_APP_API_BASE_URL=https://<portal backend> npm run build
// PORTAL_DIST points at that build (default: a zaplie-bot checkout next to this repository).
// Without it the marketing page still builds, and /portal/ is simply absent. It is copied after the
// placeholders are filled: the portal is a finished build, and its bundle may legitimately contain
// text that looks like a {{placeholder}}.
const portal = process.env.PORTAL_DIST ?? join(root, '..', '..', 'zaplie-bot', 'tabs', 'build');
const portalIndex = join(portal, 'index.html');
if (existsSync(portalIndex)) {
  // A build for the root of its own host loads its scripts from /static/, which does not
  // exist here, and a mixed build would be blank too. Every root-relative URL in the
  // portal's index must be under /portal/; refuse anything else rather than publish it.
  const html = readFileSync(portalIndex, 'utf8');
  const rootRelative = [...html.matchAll(/\s(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]);
  const outside = rootRelative.filter((url) => url !== '/portal/' && !url.startsWith('/portal/'));
  if (rootRelative.length === 0 || outside.length > 0) {
    console.error(
      `The portal build at ${portal} is not built for /portal/: rebuild it with PUBLIC_URL=/portal.` +
        (outside.length ? ` Found: ${outside.join(', ')}` : ''),
    );
    process.exit(1);
  }
  cpSync(portal, join(dist, 'portal'), { recursive: true });
  console.log(`Portal included from ${portal}`);
} else {
  // Login still has somewhere to go: a short page saying the portal is not on this site
  // yet, instead of a 404 (the Static Web App's fallback would otherwise have nothing to
  // serve for /portal/ either).
  mkdirSync(join(dist, 'portal'), { recursive: true });
  writeFileSync(join(dist, 'portal', 'index.html'), fill(join(src, 'portal-unavailable.html'), true));
  console.warn(`Portal not included: no build at ${portal} (set PORTAL_DIST, or build zaplie-bot/tabs with PUBLIC_URL=/portal). /portal/ says so.`);
}

// getzapl.ie is served through Azure Front Door (WAF, rate limit). FRONTDOOR_ID is that Front Door
// profile's ID: when set, the Static Web App only answers requests that carry it in X-Azure-FDID and
// come for one of our hostnames, so the *.azurestaticapps.net address can't be used to bypass the WAF.
// Static Web Apps has no IP allow-list for Front Door, so the ID is what keeps the lock shut: it comes
// from a deploy secret and never lives in this public repository. Needs the Standard plan.
const frontDoorId = (process.env.FRONTDOOR_ID ?? '').trim();
if (frontDoorId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(frontDoorId)) {
    console.error('FRONTDOOR_ID is not a Front Door ID (a GUID); refusing to lock the site to it.');
    process.exit(1);
  }
  const swaConfig = join(dist, 'staticwebapp.config.json');
  const swa = JSON.parse(readFileSync(swaConfig, 'utf8'));
  swa.forwardingGateway = {
    requiredHeaders: { 'X-Azure-FDID': frontDoorId },
    allowedForwardedHosts: [new URL(config.siteUrl).hostname, `www.${new URL(config.siteUrl).hostname}`],
  };
  writeFileSync(swaConfig, `${JSON.stringify(swa, null, 2)}\n`);
  console.log('Locked to Front Door: requests without our X-Azure-FDID are refused');
} else {
  console.warn('FRONTDOOR_ID not set: the site also answers on its *.azurestaticapps.net address, bypassing Front Door.');
}

console.log(`Built ${dist}`);
