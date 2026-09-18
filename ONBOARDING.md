# Onboarding — running Remotly for yourself

Remotly is personal infrastructure: **your** herdr host runs the bridge, **your** phones pair with it, and only devices
on **your** Tailscale tailnet can reach it. There is no shared server, so nobody joins an existing bridge; you set up
your own in about 30 minutes.

## 1. Get the apps

The Remotly apps for iPhone and Android are in internal testing (TestFlight and Play internal testing); request an
invite on [remotly.dev](https://remotly.dev). You can also build them from source with your own Apple developer team and
Firebase project: `ios/README.md`, `android/README.md`, and `docs/DELIVERY.md` for a delivery lane of your own.

To explore before setting up a host, tap **Try demo** on the pairing screen. Local sample sessions demonstrate the
terminal and approval controls without a login or network connection to a bridge; **Exit demo** returns to pairing.
See `docs/DEMO.md` for a walkthrough.

## 2. Push credentials — none needed

Notifications go through the app owner's push relay (`relay/README.md`): your bridge posts each notice to
`relay.remotly.dev` and the relay, which holds the apps' APNs key and Firebase service account, forwards it to Apple or
Google. Nothing to copy. A host that has credentials of its own (you built the apps yourself) puts them under
`~/.config/remotly/secrets/` at mode `0600` with `push.apns.*` / `push.fcm.*` set in `config.json`, and sends directly
(`bridge/README.md` "Configuration").

## 3. Prepare your Linux host

1. **herdr ≥ 0.8.0** running as you: `curl -fsSL https://herdr.dev/install.sh | sh`, then `herdr`. Optional:
   `resume_agents_on_restore` in `~/.config/herdr/config.toml`, so a host reboot brings the agents back too.
2. **Tailscale** on the host, logged in: `curl -fsSL https://tailscale.com/install.sh | sh`, `sudo tailscale up`. In the
   admin console → DNS, enable **MagicDNS** and **HTTPS Certificates** (iPhones refuse the self-signed fallback
   certificate). Step 3 checks all of this and waits for you when something is missing, so you can also start there.
3. Install and set up:
   ```sh
   curl -fsSL https://remotly.dev/install.sh | sh
   ```
   This puts the bridge under `~/.local/share/remotly` (with its own Node 24 when the system has none), a
   `remotly-bridge` command in `~/.local/bin`, and runs `remotly-bridge setup`: it checks herdr and Tailscale (a failing
   check prints its fix and the setup continues by itself once you have applied it — e.g. `sudo tailscale set
   --operator=$USER` when Tailscale refuses certificate requests), requests the certificate, installs the
   `remotly-bridge` user service so it survives logout and reboot, waits for it to come up, and prints one pairing QR.
   Re-run the same line later to upgrade; `remotly-bridge doctor` prints a fix for every failing check. A host without
   Tailscale (Android phones on the same LAN only): `curl -fsSL https://remotly.dev/install.sh | sh -s -- --lan`.
   `~/.config/remotly/config.json` is written with defaults and needs no edits (every key in `bridge/README.md`).
   Photos sent from the phones' composers land under `~/.local/share/remotly/uploads/<date>/` (`uploads.dir`; day folders
   older than `uploads.keep_days` = 14 are pruned, single files capped at `uploads.max_mb` = 20 MiB); the agent reads them
   by the path the app puts into the message.
   From a checkout instead (development; this path needs Node 24 and npm on the host — the installer brings its own
   Node, the checkout does not):
   `git clone https://github.com/inferenceaftermath/remotly && cd remotly/bridge && npm ci --omit=dev && node src/main.ts setup`
   — that path has no `remotly-bridge` launcher, so every `remotly-bridge <command>` below is `node src/main.ts <command>`
   from `bridge/`.

## 4. Pair your phones

1. Install **Tailscale** on the phone, log into the same tailnet, turn it on, and let it start by itself so that a
   notification action works while the app is closed: iOS → Tailscale app → Settings → **VPN On Demand**; Android →
   system Settings → Network → VPN → Tailscale → **Always-on VPN**. Phones allow one VPN at a time.
2. Scan the QR that `setup` printed from Remotly → Pair, on each phone: that one code works for all your phones for
   10 minutes. Later, `remotly-bridge pair` prints a fresh single-use code.
3. Allow notifications when the app asks. Then `remotly-bridge push-test <device_id>` (ids from
   `remotly-bridge devices list`) should show a banner on the phone.

Pairing fails? Same tailnet on both ends, `remotly-bridge status` shows `tls: tailscale`, and five wrong codes lock
that phone out for 15 minutes.

LAN mode (`setup --lan`, Android only): skip step 1, put the phone on the same network as the host, and scan the QR;
it carries the self-signed certificate's fingerprint, which the app pins, and a LAN address of the host. Pairing fails
there? `remotly-bridge status` should show `tls: selfsigned`, and the host's firewall must let port 7460 in.

## 5. Daily use

Open the app: tabs and panes of your herdr session appear live; type into the composer, use the
key row, and approve Claude Code / Codex / pi prompts from the notification. The terminal uses
your phone's text size by default; A− / A+ in the title bar step it by one point (remembered),
and Settings has the same control plus a reset. Swipe up on the screen to read scrollback (keep
swiping for older output, swipe past the bottom to return to live). Programs that draw their own
screen (Claude Code, vim, tmux, less) keep no scrollback in herdr; the bridge notices when one has
the pane and the default "Automatic" swipe mode then sends swipes to it as mouse-wheel steps, going
back to the phone's scrollback when it exits. The desktop's screen is usually taller than the phone's,
so the phone shows a window over it that follows the last row with content; a swipe moves that window
first and, once it is at the top or bottom edge, goes to the program. The pane menu can pin a pane to one behaviour
(scrollback, mouse wheel, arrow keys) and remembers the choice. Long-press a word to
select it, keep holding and move to extend, drag either end to adjust, then Copy from the menu
that appears (Select All is there too); the pane menu still has "Copy screen". The + button on
the pane list opens a new terminal on the desktop, optionally running a command (quick picks for
claude, codex and pi), and takes you straight to it. Long-press a terminal in the list (or use the pane menu) → Close terminal ends its shell on the
desktop; typing `exit` in a shell does the same, and either way the app returns to the list.

Notifications do more than approve. An approval shows the dialog itself (tool, command or file,
the agent's one-line summary, its question and choices) with Approve / Deny / Deny with feedback, the
last one typed straight into the notification. Every prompt you send from the phone also asks the
bridge for one "finished" alert when that agent's turn ends (Settings → "Tell me when it's done";
any pane can be armed from its menu, a bell marks armed panes in the list); reply to that alert
without opening the app and the reply becomes the next prompt. By default Approve, Deny with feedback
and Reply need the phone unlocked (Settings → "Require unlock to approve"); Deny stays on the lock
screen. While an agent works, iOS shows a Live Activity (Lock Screen and Dynamic Island) and Android a
silent ongoing notification with a running timer, switching to "Waiting for approval" with
Approve / Deny when it blocks and disappearing when the turn ends (switch off in Settings).
Runbook for the bridge: `docs/OPERATIONS.md`. Wire protocol: `shared/protocol/remotly-protocol.md`.

## Developing

`CONTRIBUTING.md` (build and test each part, the rules), `docs/BACKLOG.md` (open work), `CHANGELOG.md` (releases),
`docs/DELIVERY.md` (how builds reach the phones). Android needs `JAVA_HOME` pointing at a JDK 17; iOS needs Xcode 26 and
xcodegen.
