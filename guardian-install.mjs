#!/usr/bin/env node
// Guardian installer: force-installs the extension in every Chromium browser and
// turns off Incognito, Guest mode, new profiles and developer mode.
//   node guardian-install.mjs [install|uninstall|status] [--yes] [--dry-run] [--id <ext id>]
// Needs admin: `sudo` on Linux, an Administrator terminal on Windows. macOS ends in a
// System Settings click (Apple requires it for configuration profiles).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ponytail: fill in after Chrome Web Store approval, or pass --id
const EXTENSION_ID = 'REPLACE_WITH_WEB_STORE_ID';
const UPDATE_URL = 'https://clients2.google.com/service/update2/crx';
const PROFILE_ID = 'com.guardian.profile';

// --- policy ------------------------------------------------------------------
// name -> where each OS keeps its policies (macOS domain, Windows key, Linux dir)
export const BROWSERS = {
  chrome:   { mac: 'com.google.Chrome',   win: 'Google\\Chrome',            linux: '/etc/opt/chrome/policies/managed' },
  chromium: { mac: 'org.chromium.Chromium', win: null,                      linux: '/etc/chromium/policies/managed' },
  edge:     { mac: 'com.microsoft.Edge',  win: 'Microsoft\\Edge',           linux: '/etc/opt/edge/policies/managed', edge: true },
  brave:    { mac: 'com.brave.Browser',   win: 'BraveSoftware\\Brave',      linux: '/etc/brave/policies/managed' },
};

export function policyFor(browser, id) {
  return {
    ExtensionSettings: { [id]: { installation_mode: 'force_installed', update_url: UPDATE_URL, toolbar_pin: 'force_pinned' } },
    // Edge calls Incognito "InPrivate"; sending the wrong name shows an "unknown policy" warning.
    [browser.edge ? 'InPrivateModeAvailability' : 'IncognitoModeAvailability']: 1,
    BrowserGuestModeEnabled: false,
    BrowserAddPersonEnabled: false,
    ExtensionDeveloperModeSettings: 1,
    DeveloperToolsAvailability: 2,
  };
}

// --- tiny terminal UI --------------------------------------------------------
const tty = process.stdout.isTTY;
const c = (n, s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : s);
const green = (s) => c(32, s), red = (s) => c(31, s), dim = (s) => c(2, s), bold = (s) => c(1, s);
const ok = (s) => console.log(`  ${green('✓')} ${s}`);
const skip = (s) => console.log(`  ${dim('·')} ${dim(s)}`);
const fail = (s) => { console.log(`  ${red('✗')} ${s}`); process.exitCode = 1; };

function banner(title) {
  console.log(`\n${green('🛡  Guardian')} ${dim('·')} ${bold(title)}\n`);
}

async function confirm(question, yes) {
  if (yes || !tty) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} ${dim('[Y/n]')} `)).trim().toLowerCase();
  rl.close();
  return a === '' || a === 'y' || a === 'yes';
}

// --- platform helpers --------------------------------------------------------
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' });

function isAdmin() {
  if (process.platform === 'win32') {
    try { run('net', ['session']); return true; } catch { return false; }
  }
  return process.getuid() === 0;
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function plistValue(v, pad = '') {
  if (typeof v === 'boolean') return `${pad}<${v}/>`;
  if (typeof v === 'number') return `${pad}<integer>${v}</integer>`;
  if (typeof v === 'string') return `${pad}<string>${xml(v)}</string>`;
  const inner = Object.entries(v)
    .map(([k, x]) => `${pad}  <key>${xml(k)}</key>\n${plistValue(x, pad + '  ')}`).join('\n');
  return `${pad}<dict>\n${inner}\n${pad}</dict>`;
}

// --- actions -----------------------------------------------------------------
function installWindows(id, dry) {
  for (const [name, b] of Object.entries(BROWSERS)) {
    if (!b.win) continue;
    const key = `HKLM\\SOFTWARE\\Policies\\${b.win}`;
    for (const [k, v] of Object.entries(policyFor(b, id))) {
      const [type, data] = typeof v === 'object' ? ['REG_SZ', JSON.stringify(v)]
        : [ 'REG_DWORD', String(Number(v))];
      if (!dry) run('reg', ['add', key, '/v', k, '/t', type, '/d', data, '/f']);
    }
    ok(`${name}: policy written to ${key}`);
  }
}
function uninstallWindows(dry) {
  for (const [name, b] of Object.entries(BROWSERS)) {
    if (!b.win) continue;
    const key = `HKLM\\SOFTWARE\\Policies\\${b.win}`;
    // Delete only our values, never the whole key: an admin may have other policies there.
    for (const k of Object.keys(policyFor(b, 'x'))) {
      if (!dry) try { run('reg', ['delete', key, '/v', k, '/f']); } catch { /* not set */ }
    }
    ok(`${name}: Guardian policy removed`);
  }
}

function installLinux(id, dry, root) {
  for (const [name, b] of Object.entries(BROWSERS)) {
    const dir = join(root, b.linux);
    if (!dry) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'guardian.json'), JSON.stringify(policyFor(b, id), null, 2)); }
    ok(`${name}: ${join(dir, 'guardian.json')}`);
  }
}
function uninstallLinux(dry, root) {
  for (const [name, b] of Object.entries(BROWSERS)) {
    const f = join(root, b.linux, 'guardian.json');
    if (existsSync(f)) { if (!dry) rmSync(f); ok(`${name}: removed ${f}`); } else skip(`${name}: nothing to remove`);
  }
}

// ponytail: plistValue has no arrays; macProfileDoc writes the two array wrappers by hand.
function installMac(id, dry) {
  const file = join(tmpdir(), 'Guardian.mobileconfig');
  const profile = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${macProfileDoc(id)}
</plist>
`;
  if (!dry) { writeFileSync(file, profile); run('open', [file]); }
  ok(`profile written to ${file}`);
  console.log(`\n  ${bold('One last step:')} System Settings → General → Device Management → Guardian → Install.`);
  console.log(`  ${dim('Then quit and reopen your browsers.')}`);
}
function uninstallMac(dry) {
  if (!dry) run('profiles', ['remove', '-identifier', PROFILE_ID]);
  ok('profile removed (asks for your admin password)');
}

// Full profile as a plist dict; the one payload's Forced values are arrays.
export function macProfileDoc(id) {
  const forced = (b) => `<key>Forced</key><array><dict><key>mcx_preference_settings</key>${plistValue(policyFor(b, id))}</dict></array>`;
  const domains = Object.values(BROWSERS).map((b) => `<key>${b.mac}</key><dict>${forced(b)}</dict>`).join('\n');
  return `<dict>
<key>PayloadType</key><string>Configuration</string>
<key>PayloadIdentifier</key><string>${PROFILE_ID}</string>
<key>PayloadUUID</key><string>${randomUUID().toUpperCase()}</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadScope</key><string>System</string>
<key>PayloadDisplayName</key><string>Guardian</string>
<key>PayloadDescription</key><string>Force-installs Guardian and turns off Incognito, Guest mode and developer mode.</string>
<key>PayloadContent</key><array><dict>
<key>PayloadType</key><string>com.apple.ManagedClient.preferences</string>
<key>PayloadIdentifier</key><string>${PROFILE_ID}.browsers</string>
<key>PayloadUUID</key><string>${randomUUID().toUpperCase()}</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadDisplayName</key><string>Guardian browser policy</string>
<key>PayloadContent</key><dict>
${domains}
</dict></dict></array>
</dict>`;
}

// --- main --------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const flag = (n) => args.includes(`--${n}`);
  const val = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const cmd = args.find((a) => !a.startsWith('--') && a !== val('id') && a !== val('root') && a !== val('os')) || 'install';
  const id = val('id') || EXTENSION_ID;
  const dry = flag('dry-run');
  const root = val('root') || '';       // tests point Linux paths at a temp dir
  const os = val('os') || process.platform;   // --os lets tests exercise another platform's branch

  banner(cmd === 'uninstall' ? 'Uninstall' : cmd === 'status' ? 'Status' : 'Install');

  if (cmd === 'status') {
    if (os === 'linux') for (const [n, b] of Object.entries(BROWSERS))
      (existsSync(join(root, b.linux, 'guardian.json')) ? ok : skip)(`${n}: ${existsSync(join(root, b.linux, 'guardian.json')) ? 'protected' : 'not set'}`);
    else if (os === 'darwin') console.log(`  ${run('profiles', ['list']).toString().includes(PROFILE_ID) ? green('✓ profile installed') : dim('· profile not installed')}`);
    else console.log(`  ${dim('Open chrome://policy in each browser to confirm.')}`);
    return;
  }
  if (!['install', 'uninstall'].includes(cmd)) return fail(`unknown command "${cmd}" (use install, uninstall or status)`);
  if (cmd === 'install' && /^REPLACE_/.test(id)) return fail('no extension ID yet. Pass --id <Chrome Web Store ID>.');
  if (!dry && os !== 'darwin' && !root && !isAdmin())
    return fail(os === 'win32' ? 'run this from an Administrator terminal.' : `run with sudo: sudo node ${process.argv[1]} ${cmd}`);
  if (!['linux', 'darwin', 'win32'].includes(os)) return fail(`${os} is not supported`);

  if (cmd === 'install') {
    console.log(`  Extension  ${bold(id)}`);
    console.log(`  Will: force-install Guardian, disable Incognito/Guest/new profiles/developer mode.`);
    console.log(`  ${dim('Child must use a standard (non-admin) account, or this can be undone.')}\n`);
  }
  if (!(await confirm(cmd === 'install' ? 'Install now?' : 'Remove Guardian policies?', flag('yes')))) return console.log('  Cancelled.');

  if (os === 'win32') cmd === 'install' ? installWindows(id, dry) : uninstallWindows(dry);
  else if (os === 'linux') cmd === 'install' ? installLinux(id, dry, root) : uninstallLinux(dry, root);
  else cmd === 'install' ? installMac(id, dry) : uninstallMac(dry);

  if (os !== 'darwin' && !process.exitCode) console.log(`\n  ${bold('Done.')} ${dim('Restart your browsers, then check chrome://policy.')}`);
  if (dry) console.log(`  ${dim('(dry run: nothing was changed)')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { fail(e.message); });
