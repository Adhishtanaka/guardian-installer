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

const hint = (e) => /EACCES|EPERM|Access is denied|requested operation requires elevation/i.test(String(e.stderr || e.message))
  ? 'permission denied. Run as Administrator (Windows) or with sudo.'
  : String(e.message).split('\n')[0];

/** Show "… label" while fn runs, then swap it for a ✓ (or a ✗ with a fix hint). */
function step(label, fn, doneLabel = label) {
  const clear = () => tty && process.stdout.write('\r\x1b[2K');
  if (tty) process.stdout.write(`  ${dim('…')} ${dim(label)}`);
  try { fn(); } catch (e) { clear(); fail(`${label}: ${hint(e)}`); return false; }
  clear(); ok(doneLabel); return true;
}

function box(lines, color = green) {
  const w = Math.max(...lines.map((l) => l.length));
  console.log(`\n  ${color('┌' + '─'.repeat(w + 2) + '┐')}`);
  for (const l of lines) console.log(`  ${color('│')} ${l.padEnd(w)} ${color('│')}`);
  console.log(`  ${color('└' + '─'.repeat(w + 2) + '┘')}`);
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return a;
}

async function confirm(question, yes) {
  if (yes || !tty) return true;
  const a = await ask(`${question} ${dim('[Y/n]')} `);
  return a === '' || a === 'y' || a === 'yes';
}

async function menu() {
  console.log(`  ${bold('1)')} Install Guardian`);
  console.log(`  ${bold('2)')} Uninstall`);
  console.log(`  ${bold('3)')} Check status`);
  console.log(`  ${bold('q)')} Quit\n`);
  const a = await ask('  Choose: ');
  return { 1: 'install', 2: 'uninstall', 3: 'status' }[a] || null;
}

// Which supported browsers are on this computer (policy is set for all of them anyway,
// so one installed later is protected too).
const FOUND = {
  darwin: { chrome: ['/Applications/Google Chrome.app'], chromium: ['/Applications/Chromium.app'], edge: ['/Applications/Microsoft Edge.app'], brave: ['/Applications/Brave Browser.app'] },
  win32: { chrome: ['C:\\Program Files\\Google\\Chrome', 'C:\\Program Files (x86)\\Google\\Chrome'], edge: ['C:\\Program Files (x86)\\Microsoft\\Edge', 'C:\\Program Files\\Microsoft\\Edge'], brave: ['C:\\Program Files\\BraveSoftware'] },
  linux: { chrome: ['/opt/google/chrome'], chromium: ['/usr/bin/chromium', '/usr/bin/chromium-browser'], edge: ['/opt/microsoft/msedge'], brave: ['/opt/brave.com/brave', '/usr/bin/brave-browser'] },
};
const detect = (os) => Object.entries(FOUND[os] || {}).filter(([, ps]) => ps.some(existsSync)).map(([n]) => n);

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

// --- actions (each returns the browsers it configured) -----------------------
function installWindows(id, dry) {
  const done = [];
  for (const [name, b] of Object.entries(BROWSERS)) {
    if (!b.win) continue;
    const key = `HKLM\\SOFTWARE\\Policies\\${b.win}`;
    const write = () => {
      for (const [k, v] of Object.entries(policyFor(b, id))) {
        const [type, data] = typeof v === 'object' ? ['REG_SZ', JSON.stringify(v)] : ['REG_DWORD', String(Number(v))];
        if (!dry) run('reg', ['add', key, '/v', k, '/t', type, '/d', data, '/f']);
      }
    };
    if (step(`Configuring ${name}`, write, `${name} → ${key}`)) done.push(name);
  }
  return done;
}
function uninstallWindows(dry) {
  const done = [];
  for (const [name, b] of Object.entries(BROWSERS)) {
    if (!b.win) continue;
    const key = `HKLM\\SOFTWARE\\Policies\\${b.win}`;
    // Delete only our values, never the whole key: an admin may have other policies there.
    const del = () => { for (const k of Object.keys(policyFor(b, 'x'))) if (!dry) try { run('reg', ['delete', key, '/v', k, '/f']); } catch { /* not set */ } };
    if (step(`Removing ${name} policy`, del, `${name} policy removed`)) done.push(name);
  }
  return done;
}

function installLinux(id, dry, root) {
  const done = [];
  for (const [name, b] of Object.entries(BROWSERS)) {
    const dir = join(root, b.linux);
    const write = () => { if (!dry) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'guardian.json'), JSON.stringify(policyFor(b, id), null, 2)); } };
    if (step(`Configuring ${name}`, write, `${name} → ${join(dir, 'guardian.json')}`)) done.push(name);
  }
  return done;
}
function uninstallLinux(dry, root) {
  const done = [];
  for (const [name, b] of Object.entries(BROWSERS)) {
    const f = join(root, b.linux, 'guardian.json');
    if (!existsSync(f)) { skip(`${name}: nothing to remove`); continue; }
    if (step(`Removing ${name} policy`, () => { if (!dry) rmSync(f); }, `${name} → removed ${f}`)) done.push(name);
  }
  return done;
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
  const write = () => { if (!dry) { writeFileSync(file, profile); run('open', [file]); } };
  return step('Building configuration profile', write, `profile opened: ${file}`) ? Object.keys(BROWSERS) : [];
}
function uninstallMac(dry) {
  return step('Removing configuration profile', () => { if (!dry) run('profiles', ['remove', '-identifier', PROFILE_ID]); },
    'profile removed') ? Object.keys(BROWSERS) : [];
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
  const given = args.find((a) => !a.startsWith('--') && a !== val('id') && a !== val('root') && a !== val('os'));
  const id = val('id') || EXTENSION_ID;
  const dry = flag('dry-run');
  const root = val('root') || '';       // tests point Linux paths at a temp dir
  const os = val('os') || process.platform;   // --os lets tests exercise another platform's branch

  let cmd = given || 'install';
  if (!given && tty && !flag('yes')) {      // no command typed in a terminal: show the menu
    banner('Setup');
    cmd = await menu();
    if (!cmd) return console.log('\n  Bye.');
  } else banner(cmd === 'uninstall' ? 'Uninstall' : cmd === 'status' ? 'Status' : 'Install');

  if (cmd === 'status') {
    if (os === 'linux') for (const [n, b] of Object.entries(BROWSERS)) {
      const on = existsSync(join(root, b.linux, 'guardian.json'));
      (on ? ok : skip)(`${n}: ${on ? 'protected' : 'not set'}`);
    } else if (os === 'darwin') {
      let on = false;
      try { on = run('profiles', ['list']).toString().includes(PROFILE_ID); } catch { /* profiles needs root on some macOS versions */ }
      on ? ok('profile installed') : skip('profile not found (re-run with sudo for a definitive answer)');
    }
    else console.log(`  ${dim('Open chrome://policy in each browser to confirm.')}`);
    return;
  }
  if (!['install', 'uninstall'].includes(cmd)) return fail(`unknown command "${cmd}" (use install, uninstall or status)`);
  if (cmd === 'install' && /^REPLACE_/.test(id)) return fail('no extension ID yet. Pass --id <Chrome Web Store ID>.');
  if (!dry && os !== 'darwin' && !root && !isAdmin())
    return fail(os === 'win32' ? 'run this from an Administrator terminal.' : `run with sudo: sudo node ${process.argv[1]} ${cmd}`);
  if (!['linux', 'darwin', 'win32'].includes(os)) return fail(`${os} is not supported`);

  const found = detect(os);
  if (cmd === 'install') {
    console.log(`  Extension  ${bold(id)}`);
    console.log(`  Browsers   ${found.length ? found.join(', ') : dim('none found (policy is set for any you install later)')}`);
    console.log(`  Will       force-install Guardian; disable Incognito, Guest mode, new profiles, developer mode`);
    console.log(`  ${dim('The child must use a standard (non-admin) account, or this can be undone.')}\n`);
  }
  if (!(await confirm(cmd === 'install' ? 'Install now?' : 'Remove Guardian policies?', flag('yes')))) return console.log('  Cancelled.');
  console.log();

  const install = cmd === 'install';
  const done = os === 'win32' ? (install ? installWindows(id, dry) : uninstallWindows(dry))
    : os === 'linux' ? (install ? installLinux(id, dry, root) : uninstallLinux(dry, root))
    : (install ? installMac(id, dry) : uninstallMac(dry));

  const next = os === 'darwin' && install
    ? ['Next: System Settings → General → Device Management', '      → Guardian → Install, then restart your browsers.']
    : ['Next: restart your browsers, then open chrome://policy.'];
  if (process.exitCode) return box(['Some steps failed. Fix the ✗ lines above and run again.'], red);
  box([
    `${install ? 'Protected' : 'Removed'}: ${done.join(', ') || 'nothing'}`,
    ...(install ? [`Found here: ${found.join(', ') || 'no supported browser'}`, ...next] : []),
    ...(dry ? ['(dry run: nothing was changed)'] : []),
  ]);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { fail(e.message); });
