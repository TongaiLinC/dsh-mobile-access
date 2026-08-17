# dsh-mobile-access

> [中文文档](README.md) | English

Mobile access plugin for DeepSeek Harness — let phones and tablets reach the DeepSeek Harness Web GUI over LAN or VPN, with a built-in **PC-side approval gate**, automatic **LAN / VPN / WAN detection**, and **network-mode switching**.

> For security, the DeepSeek Harness web server binds `127.0.0.1` only, and `--host 0.0.0.0` is intentionally disallowed. This plugin works through the plugin runtime (`webServer` + `subprocess`): the PC starts a **gateway proxy** (`0.0.0.0:<port>`) with one click, phones scan a QR code to connect, and first access must be approved on the PC — keeping unauthorized devices out.

---

## Features

- ✅ **PC-side approval gate**: a phone's first access requires PC approval; approve / reject / revoke / restore / delete / **revoke & forget** (revoke plus record removal in one step)
- ✅ **LAN / VPN / WAN auto-detection**: access sources are classified automatically (LAN / VPN / direct WAN), and the phone asks whether to switch when the network environment changes
- ✅ **Secure WAN access**: direct WAN connections are advised to switch to Tailscale / ZeroTier; a "block direct WAN" policy can force VPN-only access
- ✅ **QR-code access**: the PC panel embeds a QR code (pure-JS generator, zero external dependencies) — scan to connect
- ✅ **Live workspace sync**: the PC's "current session" is synced to the phone, so both sides open the same workspace
- ✅ **WebSocket realtime forwarding**: the gateway proxy fully forwards the `/api/events.mux` and `/api/events.host` WebSocket channels — messages arrive live, no manual refresh
- ✅ **Theme adaptive**: all colors use DSH theme tokens (`--dsw-alias-*`), adapting to light / dark themes and third-party skins (e.g. dsh-deep-whale)
- ✅ **Mobile UI adaptation**: input-bar tool/action rows auto-wrap, settings modal goes fullscreen, skin character layers avoid overlaps, font sizes tuned for phone screens
- ✅ **State persistence**: devices, policy, and mode selections are stored in `$DSH_HOME/dsh-mobile/state.json` and survive restarts

## Repository layout

```
dsh-mobile-access/                  # this repo IS an installable DSH plugin package (npm layout)
├── package.json                    # package manifest: dsh.bundle.patch points at cordis.patch.yml
├── cordis.patch.yml                # composition patch: inserts the plugin row into the profile
├── lib/index.js                    # Host plugin body (static cordis plugin, ESM)
├── dsh-mobile-access.js            # dynamic source (code.host function body for in-session cordis_define)
└── README.md / README.en.md        # this file
```

## Requirements

- DeepSeek Harness (Web GUI build) with the Cordis plugin system
- A PC running DSH with normal network access (Windows / macOS / Linux — address enumeration auto-adapts)
- Phone and PC on the same LAN (for LAN access), or Tailscale / ZeroTier installed on both (for VPN access)
- Windows users: allow the gateway port (default `3081`, TCP inbound) through the firewall

## Development environment

This plugin is developed with DeepSeek Harness in **Create mode**:

- Primary model: `deepseek-v4-flash` (Max mode)
- Secondary model: `deepseek-v4-pro` (Max mode)

Mobile adaptations are verified with Playwright in real browsers (iPhone / Android viewports); the full development and usage guide lives on the docs site ("DSH Guide → Chapter 17 Mobile Access Plugin").

## Installation (production install, auto-loads on restart)

This is a **static cordis plugin package** that loads automatically when DSH starts — the same installation model as official plugins (e.g. dsh-balance-plugin):

### Option 1: the `dsh plugin` command

```bash
# local directory install (development)
dsh plugin --profile web add dsh-mobile-access
# or install from GitHub
dsh plugin --profile web add dsh-mobile-access@github:TongaiLinC/dsh-mobile-access
```

### Option 2: edit the profile manually (same as existing plugins)

Edit `$DSH_HOME/profiles/web/package.json`:

```jsonc
{
  "dsh": { "profile": { "bundles": [ /* ... existing bundles ... */ "dsh-mobile-access" ] } },
  "dependencies": {
    // local development: link to the repo dir; production: use the GitHub address
    "dsh-mobile-access": "github:TongaiLinC/dsh-mobile-access"
  }
}
```

Then run `pnpm install` (or `npm install`) inside the profile directory and **restart DSH**. The plugin is active when the blue 「📱」 floating button appears at the bottom-right of the PC page.

> ✅ After a production install there is **no need to redeploy on every restart** (unlike the dynamic build); device and policy data stay in `$DSH_HOME/dsh-mobile/state.json` and are shared with the dynamic build.

### Option 3: dynamic build (development / temporary use)

Run the content of `dsh-mobile-access.js` as `code.host` in a Web GUI session via `cordis_define` + `cordis_run`. The dynamic build is **process-scoped** and must be redeployed after each DSH restart; it suits fast iteration, while production use should prefer options 1/2.

## Usage

### 1. PC: start the gateway

Click the bottom-right 「📱」 button to open the "Mobile Access" panel:

1. Click **「Start gateway」** (listens on `0.0.0.0:3081`; the port is configurable);
2. The panel renders a **QR code** (the LAN address);
3. On first use, Windows may show a firewall prompt — allow node.exe for private-network inbound.

### 2. Phone: scan to connect

- Connect the phone to the same Wi-Fi and scan the QR code with the camera / WeChat to open the GUI;
- or type `http://<PC-LAN-IP>:3081` in the browser (copyable from the panel).

### 3. First-access approval

- The phone's first visit lands on a **gate page** (waiting for approval) or a fullscreen gate overlay;
- Name the device and submit the request;
- The pending device appears under "Device approval" in the PC panel → click **「Approve」**;
- The phone is admitted automatically within about 3 seconds.

### 4. Network-mode switching

- The phone shows a **mode badge** at the top of the screen: `LAN` / `VPN` / `direct WAN`; tap it for a hint;
- When the access method changes (e.g. Wi-Fi → cellular), a popup asks whether to switch;
- On direct WAN it recommends connecting Tailscale / ZeroTier and switching to the VPN address (copyable from the "VPN addresses" section of the panel).

### 5. Device management (PC panel)

| Status | Available actions |
|---|---|
| Pending | Approve / Reject |
| Approved | Revoke (keep record) / Revoke & forget (revoke + delete record, with confirmation) |
| Rejected / Revoked | Restore / Delete record |

### 6. Security policy (PC panel)

- **Block direct WAN**: when enabled, devices from WAN sources are blocked and must connect via VPN;
- **Gateway port**: change it and click "Save policy".

## How it works (brief)

```
phone ──> http://<LAN-IP>:3081 (gateway proxy, 0.0.0.0)
              │  gate decision (x-dshm-real-ip / x-dshm-forwarded-host trusted from loopback only)
              │  unapproved device → 302 gate page; approved device → forwarded
              ▼
         127.0.0.1:3080 main server (Host rewritten to 127.0.0.1 to pass the /api trust fence)
              │  injects boot.js (PC panel / phone gate / mode popup / badge / QR)
              ▼
         state persisted to $DSH_HOME/dsh-mobile/state.json
```

Key mechanisms:

- `webServer.tapIndex` injects `/dsh-mobile/api/boot.js` into every GUI page (PC panel, phone gate, mode popup, QR code) and prepends a `crypto.randomUUID` polyfill into `<head>` (phones reach the GUI over `http://<IP>`, a non-secure context where several product UIs depend on that API and would crash without it);
- `webServer.register` serves the `/dsh-mobile/api/*` endpoints and the `/dsh-mobile/gate.html` gate page;
- `subprocess` spawns the node gateway proxy process, forwarding HTTP and WebSocket (including the 101 upgrade handshake);
- Device approval, policy, and mode selections are persisted via `fs`.

## FAQ

**Q: The phone can't open `http://<IP>:3081`?**
Check: phone and PC on the same LAN; the gateway is running (visible in the panel); Windows firewall allows the port (Windows Security → Firewall → allow node.exe private-network inbound).

**Q: The plugin is gone after a DSH restart?**
The dynamic build is process-scoped and must be redeployed as described under Installation; device and policy data remain in `$DSH_HOME/dsh-mobile/state.json`.

**Q: Some phone pages are blank / throw errors?**
Force-refresh the page (to pull the latest boot.js). Most remaining issues come from the non-secure context missing `crypto.randomUUID` — the plugin ships a polyfill; if it still occurs, report the "boot version" shown at the bottom of the PC panel to the author.

**Q: Can WAN connect directly?**
Yes, but using a VPN (Tailscale / ZeroTier) is strongly recommended; enable "Block direct WAN" in the PC panel to force VPN-only access.

**Q: The phone can't connect after changing the gateway port?**
After saving the policy, **restart the gateway** (stop then start) and make sure the firewall allows the new port.

## Documentation

Full development and usage documentation lives on the docs site: "DSH Guide → Chapter 17 Mobile Access Plugin" — [https://docs.tongai.vip/docs/dsh/zhinandaodu.html](https://docs.tongai.vip/docs/dsh/zhinandaodu.html) (17 chapters: installation, PC panel, phone flows, network-detection algorithms, gateway proxy, API reference, persistence, mobile UI adaptations, and more).

## Third-party plugin adaptation

[dsh-balance-plugin](https://github.com/Francis-Xavier-code/dsh-balance-plugin) (DeepSeek balance monitoring and usage statistics: balance monitoring · official top-up entry · Miyu-style usage stats · third-party plugin management) renders its overlay inline in the input bar, which causes mobile issues such as truncated overlays, overlays covered by the sidebar/topbar, and overflowing detail tables — this plugin ships a complete adaptation suite (overlay stacking/position fixes, render-level verification, iOS overlay migration, horizontal table scrolling). No extra configuration needed after installation. See section 8.4 of the docs.

## License

MIT
