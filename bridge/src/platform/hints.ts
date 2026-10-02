// What the user is told to do about Tailscale, per host platform. On Linux tailscaled is a system service and the CLI
// drives it (`sudo tailscale up`); on macOS the Tailscale app is the daemon, the user logs in from its menu bar icon,
// and there is no `--operator` (certificates are issued to the app's logged-in user).

export const TAILSCALE_INSTALL = 'curl -fsSL https://tailscale.com/install.sh | sh';
export const TAILSCALE_INSTALL_MAC = 'https://tailscale.com/download/mac';

export interface TailscaleHints {
  /** Fix lines for "Tailscale is not installed". */
  install: string[];
  /** Fix lines for "tailscaled is not running". */
  daemon: string[];
  /** The fix line for "not logged in" / "not Running". */
  up: string;
  /** Fix lines for "Running, but no Self.UserID". */
  identity: string[];
  /** The fix for `tailscale cert` answering "access denied" to this user. */
  certDenied: (user: string) => string;
  /** One line: install, then log in (doctor). */
  installThenUp: string;
  /** What `serve` says when Tailscale stays installed-but-down and it exits for the service manager to retry. */
  notUp: string;
}

const linux: TailscaleHints = {
  install: [`install it:  ${TAILSCALE_INSTALL}`, 'then log in:  sudo tailscale up'],
  daemon: ['sudo systemctl enable --now tailscaled', 'then:  sudo tailscale up'],
  up: 'sudo tailscale up     (prints a login link; open it on any device)',
  identity: ['sudo tailscale up     (log in again)', 'then:  tailscale status --json | grep -m1 UserID'],
  certDenied: (user) => `sudo tailscale set --operator=${user}`,
  installThenUp: `${TAILSCALE_INSTALL}   then: sudo tailscale up`,
  notUp: 'Fix:  sudo systemctl enable --now tailscaled && sudo tailscale up   — or, for a LAN-only host:  remotly-bridge setup --lan. Exiting so systemd retries.',
};

const darwin: TailscaleHints = {
  install: [`install it:  ${TAILSCALE_INSTALL_MAC}   (or:  brew install --cask tailscale)`, 'then log in from the Tailscale menu bar icon'],
  daemon: ['open the Tailscale app (tailscaled runs inside it) and connect'],
  up: 'open the Tailscale app and log in (its menu bar icon)',
  identity: ['log out and in again in the Tailscale app', 'then:  tailscale status --json | grep -m1 UserID'],
  certDenied: () => 'log in to the Tailscale app as the user who runs the bridge (macOS has no --operator; certificates are issued to the app\'s user)',
  installThenUp: `install Tailscale from ${TAILSCALE_INSTALL_MAC}, then log in from its menu bar icon`,
  notUp: 'Fix:  open the Tailscale app and log in   — or, for a LAN-only host:  remotly-bridge setup --lan. Exiting so launchd retries.',
};

export function tailscaleHints(platform: string): TailscaleHints {
  return platform === 'darwin' ? darwin : linux;
}
