// Pair with a bridge (shared/design/DESIGN.md §4.8): scan the QR from `remotly-bridge pair`, or type URL + code
// (+ fingerprint for a self-signed certificate).
import FlowKit
import SwiftUI
import UIKit

// Explicit @MainActor: helper methods (handleScan/pairManually/pair) call the main-actor AppModel and
// must be isolated even on SDKs where `View` itself is not yet @MainActor (iOS 17 SDK).
@MainActor
struct PairingView: View {
    @Environment(AppModel.self) private var model
    @State private var mode = Mode.scan
    @State private var urlText = ""
    @State private var codeText = ""
    @State private var fingerprintText = ""
    @State private var hostNameText = ""
    @State private var showFingerprint = false
    @State private var isPairing = false
    @State private var errorText: String?
    @State private var lastScanned: String?

    private enum Mode: Hashable { case scan, manual }

    private var canPairManually: Bool {
        !isPairing && !urlText.trimmingCharacters(in: .whitespaces).isEmpty && !codeText.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                SegmentedControl(selection: $mode, options: [(Mode.scan, "Scan QR"), (Mode.manual, "Enter code")])
                    .padding(.horizontal, 16)
                    .padding(.top, 14)
                if mode == .scan {
                    scanner
                } else {
                    manualForm
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Theme.bg)
            .toastHost()
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bg, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("Pair with a host")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.fg)
                }
            }
            .overlay {
                if isPairing {
                    VStack(spacing: 12) {
                        ProgressView().tint(Theme.fg2)
                        Text("Pairing…").font(.system(size: 15)).foregroundStyle(Theme.fg)
                    }
                    .padding(24)
                    .card(radius: 14)
                }
            }
            .onChange(of: mode) { _, _ in errorText = nil }
        }
        .tint(Theme.interactive)
    }

    // MARK: Scan QR

    private var scanner: some View {
        VStack(spacing: 14) {
            QRScannerView { code in handleScan(code) }
                .aspectRatio(4 / 3, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 18))
                .overlay(CornerBrackets().stroke(Theme.accent, style: StrokeStyle(lineWidth: 3, lineCap: .round)))
                .padding(.horizontal, 16)
                .padding(.top, 18)
            Text("Point the camera at the code on your host's screen.")
                .font(.system(size: 15))
                .foregroundStyle(Theme.fg2)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            Text("$ remotly-bridge pair")
                .font(Theme.mono(12.5))
                .foregroundStyle(Theme.fg3)
            Spacer(minLength: 0)
        }
    }

    // MARK: Enter code

    private var manualForm: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                SheetField(placeholder: "Host URL (e.g. 100.101.102.103:7460)", text: $urlText, keyboard: .URL)
                SheetField(placeholder: "Pairing code (8 characters)", text: $codeText, mono: true, capitals: true)
                SheetField(placeholder: "Host name (optional)", text: $hostNameText)
                Button {
                    withAnimation(.easeOut(duration: 0.15)) { showFingerprint.toggle() }
                } label: {
                    HStack {
                        Text("Self-signed certificate")
                            .font(.system(size: 15))
                            .foregroundStyle(Theme.fg2)
                        Spacer()
                        Image(systemName: showFingerprint ? "chevron.down" : "chevron.right")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Theme.fg2)
                    }
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(showFingerprint ? [.isSelected] : [])
                if showFingerprint {
                    SheetField(placeholder: "Certificate fingerprint (base64url SHA-256)", text: $fingerprintText, mono: true)
                    Text("Leave empty when the bridge uses a Tailscale certificate.")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.fg3)
                }
                Button("Pair") { pairManually() }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(!canPairManually)
                    .padding(.top, 8)
                if let errorText {
                    Text(errorText)
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.blocked)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(16)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    // MARK: Actions

    private func handleScan(_ code: String) {
        guard !isPairing, code != lastScanned else { return }
        lastScanned = code
        guard let payload = QRPayload(string: code) else {
            model.showNotice("Not a Remotly pairing code")
            return
        }
        model.showNotice("pairing with \(payload.hostName)…")
        pair(payload)
    }

    /// Same checks and words as Android before anything is sent.
    private func pairManually() {
        guard let origin = QRPayload.normalizeOrigin(urlText) else {
            errorText = "Enter the host as host:port"
            return
        }
        let code = QRPayload.normalizeCode(codeText)
        guard QRPayload.isValidCode(code) else {
            errorText = "The code is 8 characters from A–Z and 2–9 (no I, O, 0, 1)"
            return
        }
        let fp = fingerprintText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard fp.isEmpty || QRPayload.isValidFingerprint(fp) else {
            errorText = "The fingerprint is 43 base64url characters"
            return
        }
        let payload = QRPayload(origin: origin, fingerprint: fp.isEmpty ? nil : fp, code: code,
                                hostName: hostNameText.isEmpty ? (origin.host() ?? "host") : hostNameText)
        errorText = nil
        pair(payload)
    }

    private func pair(_ payload: QRPayload) {
        isPairing = true
        Task {
            do {
                try await model.pair(with: payload)
                // Approval alerts need notification permission; ask now, while the user is in the flow,
                // instead of relying on the Settings screen being discovered.
                _ = await model.requestNotifications()
            } catch {
                let text = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                if mode == .scan {
                    model.showNotice(text)
                    lastScanned = nil // the same code may be scanned again after the failure
                } else {
                    errorText = text
                }
            }
            isPairing = false
        }
    }
}

/// The viewfinder's four corner brackets (§4.8): 26 pt long, 12 pt inset, 6 pt outer radius; stroked by the caller.
struct CornerBrackets: Shape {
    var length: CGFloat = 26
    var inset: CGFloat = 12
    var radius: CGFloat = 6

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let r = rect.insetBy(dx: inset, dy: inset)
        // top-left
        p.move(to: CGPoint(x: r.minX, y: r.minY + length))
        p.addLine(to: CGPoint(x: r.minX, y: r.minY + radius))
        p.addQuadCurve(to: CGPoint(x: r.minX + radius, y: r.minY), control: CGPoint(x: r.minX, y: r.minY))
        p.addLine(to: CGPoint(x: r.minX + length, y: r.minY))
        // top-right
        p.move(to: CGPoint(x: r.maxX - length, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX - radius, y: r.minY))
        p.addQuadCurve(to: CGPoint(x: r.maxX, y: r.minY + radius), control: CGPoint(x: r.maxX, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.minY + length))
        // bottom-right
        p.move(to: CGPoint(x: r.maxX, y: r.maxY - length))
        p.addLine(to: CGPoint(x: r.maxX, y: r.maxY - radius))
        p.addQuadCurve(to: CGPoint(x: r.maxX - radius, y: r.maxY), control: CGPoint(x: r.maxX, y: r.maxY))
        p.addLine(to: CGPoint(x: r.maxX - length, y: r.maxY))
        // bottom-left
        p.move(to: CGPoint(x: r.minX + length, y: r.maxY))
        p.addLine(to: CGPoint(x: r.minX + radius, y: r.maxY))
        p.addQuadCurve(to: CGPoint(x: r.minX, y: r.maxY - radius), control: CGPoint(x: r.minX, y: r.maxY))
        p.addLine(to: CGPoint(x: r.minX, y: r.maxY - length))
        return p
    }
}
