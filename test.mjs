// Run: node test.mjs   (smallest check that fails if the policy output breaks)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { policyFor, BROWSERS, macProfileDoc } from './guardian-install.mjs';

const ID = 'a'.repeat(32);
const cli = (...a) => execFileSync('node', ['guardian-install.mjs', ...a, '--id', ID, '--yes'], { encoding: 'utf8' });

// Linux: one JSON per browser, Edge uses InPrivate, others Incognito
const root = mkdtempSync(join(tmpdir(), 'guardian-'));
cli('install', '--os', 'linux', '--root', root);
for (const b of Object.values(BROWSERS)) {
  const p = JSON.parse(readFileSync(join(root, b.linux, 'guardian.json'), 'utf8'));
  assert.equal(p.ExtensionSettings[ID].installation_mode, 'force_installed');
  assert.equal(p[b.edge ? 'InPrivateModeAvailability' : 'IncognitoModeAvailability'], 1);
  assert.equal(b.edge ? 'IncognitoModeAvailability' in p : 'InPrivateModeAvailability' in p, false);
}
cli('uninstall', '--os', 'linux', '--root', root);
assert.equal(existsSync(join(root, BROWSERS.chrome.linux, 'guardian.json')), false);

// macOS: profile must be valid plist and name every browser domain
if (process.platform === 'darwin') {
  const f = join(root, 'g.mobileconfig');
  writeFileSync(f, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${macProfileDoc(ID)}\n</plist>`);
  execFileSync('plutil', ['-lint', f]);
  const out = execFileSync('plutil', ['-p', f], { encoding: 'utf8' });
  for (const b of Object.values(BROWSERS)) assert.ok(out.includes(b.mac), b.mac);
}
// refuses to install without a real ID
assert.throws(() => execFileSync('node', ['guardian-install.mjs', 'install', '--yes', '--dry-run', '--id', 'REPLACE_ME'], { stdio: 'pipe' }));
console.log('all checks passed');
