# OBS Web Deck — LAN edition

A self-hosted Stream Deck-style controller for **OBS Studio**, served from the OBS PC
itself over your local network. Open it on a phone, tablet or second laptop and drive
scenes, transitions, streaming and recording from anywhere on your Wi-Fi.

This is a rework of the deck that runs at `remote.krezna.web.id`, which lives behind
HTTPS. That works, but it fights the browser the whole way. This edition removes the
fight.

Two public deployments exist and both are Git-connected to this repository, so they
redeploy on every push to `main`:

| URL | Host | Works as a controller? |
|---|---|---|
| https://remote.krezna.web.id | Vercel, proxied by Cloudflare | no — HTTPS blocks `ws://` |
| https://obs-deck.vercel.app | Vercel | no — HTTPS blocks `ws://` |
| https://krezna06.github.io/obs-deck/ | GitHub Pages | no — HTTPS blocks `ws://` |

They render the interface correctly and **cannot connect to OBS**, for the reason
above. Use the LAN deployment for anything real. `node tools/check-live.mjs` re-checks
all of them and prints the verdict.

---

## Why not just use the HTTPS version?

OBS Studio's WebSocket server speaks **plain `ws://`** — it has no TLS. Every browser
forbids an HTTPS page from opening a plain `ws://` socket to anything other than
`localhost`, so an HTTPS-hosted deck can never talk to OBS on another device. The
original script works around this with a tunnel and a lot of explanatory warnings.

Serving the deck over **plain HTTP on the LAN** makes `ws://` legal, so a phone can
connect straight to the OBS PC. No tunnel, no certificate, no mixed-content blocking.

| | HTTPS + tunnel | This edition (HTTP on LAN) |
|---|---|---|
| Reachable from a phone on Wi-Fi | yes, via tunnel | yes, directly |
| Needs a tunnel / domain / cert | yes | no |
| Exposed to the internet | yes | **no** |
| Works with OBS's plain `ws://` | only through a tunnel | natively |

The trade-off: this edition is **LAN-only**. It is not reachable from outside your
network, and that is deliberate — it means nothing about your stream setup is exposed
to the internet.

---

## Fixed: the authentication bug

The original script computes the obs-websocket password challenge with **hex** digests:

```js
[...new Uint8Array(await crypto.subtle.digest("SHA-256", ...))]
  .map(x => x.toString(16).padStart(2, "0")).join("")   // hex — not what OBS expects
```

The obs-websocket protocol requires **base64**:

```
secret         = base64(sha256(password + salt))
authentication = base64(sha256(secret + challenge))
```

Hex and base64 produce different strings from the same hash, so a password-protected
OBS server would reject the login. This edition uses base64 and is verified against the
published protocol. See [`docs/generated/protocol.md` (Authentication)](https://raw.githubusercontent.com/DINKIN/obs-websocket/refs/heads/master/docs/generated/protocol.md)
and the [obs-websocket protocol reference](https://github.com/hyperwebmedia/obs-websocket/blob/master/PROTOCOL.md).

If you run OBS **without** a password, both versions connect fine — which is why the
bug is easy to miss.

---

## Quick start

Requirements: [Docker Desktop](https://www.docker.com/products/docker-desktop/) on the
PC that runs OBS.

```powershell
cd remote-deck
powershell -ExecutionPolicy Bypass -File .\start-deck.ps1
```

The script starts the container, prints the exact URLs to open, and tells you whether
OBS WebSocket is listening.

Then, **in OBS**:

1. `Tools → WebSocket Server Settings`
2. Tick **Enable WebSocket Server**
3. Set a **password**
4. Make sure the server is reachable from other devices — if there is a bind-address
   option, leave it on **all interfaces / `0.0.0.0`** rather than `127.0.0.1`
5. Click **Apply**

Open the deck at the address the script printed:

- **on the OBS PC:** `http://localhost:8080`
- **on your phone:** `http://<obs-pc-ip>:8080`

The deck prefills the OBS address from whichever host served the page, so
`http://192.168.1.23:8080` automatically targets `ws://192.168.1.23:4455`. Type the
same password and press **Connect**.

To stop it:

```powershell
powershell -ExecutionPolicy Bypass -File .\stop-deck.ps1
```

### Other options

```powershell
# different host port
powershell -ExecutionPolicy Bypass -File .\start-deck.ps1 -Port 9000

# also create the Windows Firewall rule (run from an Administrator PowerShell)
powershell -ExecutionPolicy Bypass -File .\start-deck.ps1 -OpenFirewall
```

No Docker? Serve the folder with anything static and open it over HTTP:

```powershell
python -m http.server 8080
```

The deck is one self-contained file at the repository root. You can also just
double-click `index.html`. It then only reaches OBS on that same PC (a `file://` page is not a
network page), which is fine for testing on the OBS machine itself.

---

## If it doesn't connect

The deck reports what it can see, but these are the usual causes, in order:

1. **Nothing listening on 4455.** In OBS, enable `Tools → WebSocket Server Settings`.
   `start-deck.ps1` checks this for you and says so.
2. **Wrong password.** OBS refuses the login with op 9 and the deck says
   *"OBS rejected the password"*. Copy it from the OBS dialog.
3. **Windows Firewall blocking TCP 4455.** This is the most common one for phones.
   Re-run `start-deck.ps1 -OpenFirewall` from an Administrator PowerShell, or allow
   `obs64.exe` on private networks when Windows prompts.
4. **OBS bound to loopback only.** If OBS WebSocket is configured to listen on
   `127.0.0.1`, only the OBS PC itself can connect. Switch it to all interfaces.
5. **Different network / guest Wi-Fi.** Phones on a guest SSID often cannot reach LAN
   hosts. Use the same network, and turn off any VPN on the phone.
6. **Wrong address.** Use the OBS PC's LAN IP, not `127.0.0.1`. The
   **↺ Use this server's IP** button restores the auto-detected address.

Still stuck? Press **🔍 Find OBS on this network** — it sweeps the subnet this page was
served from and drops the address it finds into the URL field.

---

## Security

Be aware of what you are turning on:

- **Anyone on your network who loads the deck and knows the OBS password gets full
  control of OBS** — they can go live, stop your stream, or switch scenes.
- The deck stores the OBS password in the browser's `localStorage` **only if you tick
  "Remember URL & password on this device"**. Untick it on shared devices.
- Nothing here is reachable from the internet: no tunnel, no port forwarding. Keep it
  that way. Do not expose OBS's port 4455 to the internet — obs-websocket is not built
  to face hostile networks.
- To require a password just to **load** the deck, uncomment the `basic_auth` block in
  [`Caddyfile`](Caddyfile). Generate the hash with:

  ```powershell
  docker compose exec caddy caddy hash-password --plaintext 'your-password'
  ```

- Caddy binds `http://:8080`, i.e. every interface, which is what makes phones work.
  Change it to `http://127.0.0.1:8080` in [`Caddyfile`](Caddyfile) if you want the deck
  reachable from the OBS PC only.

---

## Files

| Path | Purpose |
|---|---|
| `index.html` | The whole deck — UI, styles and logic in one file, served at the repository root |
| `prototype.html` | The original `obs-deck` revision, preserved unmodified for reference |
| `.nojekyll` | Makes GitHub Pages publish files verbatim instead of Jekyll-processing them |
| `Caddyfile` | Static host on port 8080, LAN-wide, no directory listing |
| `docker-compose.yml` | Caddy container, this repository mounted read-only |
| `start-deck.ps1` / `stop-deck.ps1` | Windows launchers; detect Docker, LAN IP, OBS port |
| `tools/verify.ps1` | Runs the whole verification suite |
| `tools/check-live.mjs` | Hashes each public deployment and says whether it can reach OBS |
| `tools/compare-live.mjs` | Compares the live site against the repository revisions, byte for byte |
| `tools/test-deck.mjs` | Drives the deck's real script through a full OBS session |
| `tools/mock-obs.mjs` + `tools/raw-ws.mjs` | A fake obs-websocket v5 server, zero dependencies |
| `tools/ws_selftest.py` | Independent stdlib-only RFC6455 client |
| `tools/dom-shim.mjs` | Small DOM used to run the deck under Node |

---

## Provenance and license

MIT licensed — see [`LICENSE`](LICENSE).

This deck is a rework of the single-file OBS Web Deck originally published in
**[krezna06/obs-deck](https://github.com/krezna06/obs-deck)** (the revision served at
`remote.krezna.web.id`). That original is preserved here byte-for-byte as
[`prototype.html`](prototype.html) so the lineage is inspectable — it is
**not** the maintained file.

The hex-versus-base64 bug described above is present in that original, which is what
this rework fixes.

OBS Remote and the tablet interface this family of tools grew out of come from
**[t2t2/obs-tablet-remote](https://github.com/t2t2/obs-tablet-remote)**
(MIT, © 2015 t2t2). That upstream copyright notice is retained in
[`LICENSE`](LICENSE).

The Vue application in `krezna06/remote-obs` is a separate project and is untouched by
this repository.

---

## Features kept from the original

Scene preview via `GetSourceScreenshot`, studio-mode `TAKE` with transition and
duration, stream/record/pause/refresh/studio deck buttons with per-button icon, colour
and label customisation (saved in `localStorage`), a scene list, and a selectable deck
column count.

## Added

- Auto-detects the OBS address from the host that served the page.
- **🔍 Find OBS on this network** — sweeps the subnet and fills in the address, with
  live progress and early exit.
- **↺ Use this server's IP** to undo a wrong manual address.
- A **LIVE** indicator showing the actual program scene, kept separate from the
  preview so an external scene change in OBS is visible instead of silently
  retargeting your preview.
- Opt-in credential remembering, with a one-click way to clear it.
- Base64 authentication (the bug fix above).
- Mobile-first layout: 2 columns on a phone, 3 on a tablet, no horizontal scroll.
- The `eventSubscriptions` mask, so OBS actually sends scene-change events.

---

## Verifying it works

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\verify.ps1
```

Two independent checks:

1. **`tools/test-deck.mjs`** loads `index.html`, extracts the deck's real inline
   `<script>`, runs it against a small DOM, and drives a complete session against a
   fake OBS server — handshake, base64 auth, scene list, scene switch, action buttons,
   error reporting and events. 47 assertions.
2. **`tools/ws_selftest.py`** is a from-scratch RFC6455 client that shares no code with
   the deck and talks to `tools/mock-obs.mjs` over a real socket, proving the handshake,
   frame encoding, multi-request flow, the 16-bit length frame, and that a wrong
   password is refused. 14 checks.

Neither one needs OBS installed.
