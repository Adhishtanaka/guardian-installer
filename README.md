# Guardian installer

Force-installs the Guardian extension in Chrome, Edge, Brave and Chromium, and turns off Incognito/InPrivate, Guest mode, new profiles and developer mode.

Needs [Node.js](https://nodejs.org) 18+.

**macOS / Linux**
```bash
curl -fsSL https://raw.githubusercontent.com/Adhishtanaka/guardian-installer/main/install.sh | sudo sh
```

**Windows** (Administrator PowerShell)
```powershell
irm https://raw.githubusercontent.com/Adhishtanaka/guardian-installer/main/install.ps1 | iex
```

Remove it: `... | sudo sh -s -- uninstall` (macOS/Linux), or `node guardian-install.mjs uninstall` (Windows).
Other commands: `status`. Flags: `--yes`, `--dry-run`, `--id <Web Store ID>`. Self-check: `node test.mjs`.

- macOS ends with a click in System Settings → General → Device Management (Apple requires it).
- The child must use a standard (non-admin) account, or the policy can be removed.
