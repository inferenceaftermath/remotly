// Settings (shared/design/DESIGN.md §4.9): the same sections, rows and words as Android.
import FlowKit
import SwiftUI
import UIKit
import UserNotifications

// @MainActor: the actions read the main-actor AppModel outside `body`.
@MainActor
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @AppStorage("fitPaneToDevice") private var fitToDevice = true
    @AppStorage("zoomOnDesktop") private var zoomOnDesktop = true
    @AppStorage(FlowSettings.notifyOnPromptKey) private var notifyOnPrompt = true
    @AppStorage(FlowSettings.requireUnlockKey) private var requireUnlock = true
    @AppStorage(FlowSettings.liveActivitiesKey) private var liveActivities = true
    @State private var notificationStatus: UNAuthorizationStatus = .notDetermined
    @State private var confirmForget = false

    private var notificationsAllowed: Bool {
        notificationStatus == .authorized || notificationStatus == .provisional || notificationStatus == .ephemeral
    }

    var body: some View {
        VStack(spacing: 0) {
        if model.isDemo { DemoBanner() }
        NavigationStack {
            List {
                if let host = model.displayHost {
                    Section {
                        ValueRow(title: "Name", value: host.name)
                        if !model.isDemo {
                            ValueRow(title: "Bridge", value: host.url.absoluteString, mono: true)
                            Button {
                                UIPasteboard.general.string = host.fingerprint ?? "tailnet"
                                model.showNotice("copied")
                            } label: {
                                ValueRow(title: "Certificate",
                                         value: host.fingerprint.map { "Self-signed · pinned \($0)" } ?? "From your tailnet",
                                         mono: host.fingerprint != nil)
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint("Copies the certificate")
                        }
                        ValueRow(title: "This device", value: model.deviceInfo?.name ?? UIDevice.current.name)
                    } header: {
                        SectionLabel("Host", inset: false)
                    }
                    .listRowBackground(Theme.panel)
                }
                Section {
                    if model.isDemo {
                        Text("Notifications and photo uploads require a paired host.").font(.system(size: 15)).foregroundStyle(Theme.fg2)
                    } else {
                        HStack {
                            Text("Permission").font(.system(size: 15)).foregroundStyle(Theme.fg)
                            Spacer()
                            Text(notificationsAllowed ? "Allowed" : "Not allowed").font(.system(size: 15)).foregroundStyle(Theme.fg2)
                            if notificationStatus == .denied {
                                Button("Open system settings") {
                                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                                }
                                .buttonStyle(QuietButtonStyle(color: Theme.interactive))
                            } else if !notificationsAllowed {
                                Button("Enable") {
                                    Task {
                                        _ = await model.requestNotifications()
                                        notificationStatus = await FlowNotifications.authorizationStatus()
                                    }
                                }
                                .buttonStyle(QuietButtonStyle(color: Theme.interactive))
                            }
                        }
                        ToggleRow(title: "Tell me when it's done by default",
                                  detail: "Every prompt sent from this phone asks for one notification when the agent finishes its turn.",
                                  isOn: $notifyOnPrompt)
                        ToggleRow(title: "Require unlock to approve",
                                  detail: "Approve, Deny with feedback and Reply from a notification work only once the phone is unlocked.",
                                  isOn: $requireUnlock)
                        ToggleRow(title: "Show working agents",
                                  detail: "Each working agent stays visible outside the app with a running timer.",
                                  isOn: $liveActivities)
                    }
                } header: {
                    SectionLabel("Notifications", inset: false)
                }
                .listRowBackground(Theme.panel)
                Section {
                    ToggleRow(title: "Fit pane to this phone",
                              detail: "While you view a pane, its width on the desktop follows this screen's columns.",
                              isOn: $fitToDevice)
                    ToggleRow(title: "Zoom on desktop while viewing",
                              detail: "The pane fills its desktop tab while you view it; the split comes back when you leave.",
                              isOn: $zoomOnDesktop)
                } header: {
                    SectionLabel("Terminal", inset: false)
                }
                .listRowBackground(Theme.panel)
                Section {
                    ValueRow(title: "App", value: "\(AppInfo.version) · protocol \(flowProtocolVersion)")
                    ValueRow(title: "Bridge", value: bridgeVersions)
                    ValueRow(title: "Push", value: model.isDemo ? "Unavailable in demo" : model.pushTokenHex == nil ? "not issued" : "registered · \(PushEnvironmentDetector.current.rawValue)")
                    ValueRow(title: "Terminal font", value: "JetBrains Mono · OFL 1.1")
                } header: {
                    SectionLabel("About", inset: false)
                }
                .listRowBackground(Theme.panel)
                Section {
                    if model.isDemo {
                        Button("Exit demo") { model.exitDemo(); dismiss() }
                    } else {
                        Button("Try demo") { model.enterDemo(); dismiss() }
                        Text("Local sample sessions. Your saved host is preserved.").font(.system(size: 13)).foregroundStyle(Theme.fg2)
                        Button("Forget this host", role: .destructive) { confirmForget = true }
                            .font(.system(size: 15))
                            .foregroundStyle(Theme.blocked)
                    }
                }
                .listRowBackground(Theme.panel)
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .listRowSeparatorTint(Theme.separator)
            .toastHost()
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bg, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("Settings").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.fg)
                }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.fontWeight(.semibold) }
            }
            .confirmationDialog("Forget \(model.host?.name ?? "this host")?", isPresented: $confirmForget, titleVisibility: .visible) {
                Button("Forget", role: .destructive) {
                    model.forgetHost()
                    dismiss()
                }
            } message: {
                Text("The device token is deleted and push registration removed. Pair again with a new code from remotly-bridge pair.")
            }
            .task { notificationStatus = await FlowNotifications.authorizationStatus() }
            .onChange(of: requireUnlock) { _, _ in FlowSettings.applyNotificationCategories() }
            .onChange(of: liveActivities) { _, on in model.setLiveActivities(on) }
        }
        }
        .tint(Theme.interactive)
        .presentationBackground(Theme.bg)
    }

    private var bridgeVersions: String {
        guard let info = model.hostInfo else { return model.connectionState == .connected ? "—" : "not connected" }
        return "\(info.flowVersion ?? "—") · herdr \(info.herdrVersion ?? "—")"
    }
}

/// Title left in `fg`, value right in `fg2` (mono for URLs and fingerprints).
private struct ValueRow: View {
    let title: String
    let value: String
    var mono = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title).font(.system(size: 15)).foregroundStyle(Theme.fg)
            Spacer(minLength: 0)
            Text(value)
                .font(mono ? Theme.mono(13) : .system(size: 15))
                .foregroundStyle(Theme.fg2)
                .multilineTextAlignment(.trailing)
                .lineLimit(2)
                .truncationMode(.middle)
        }
        .contentShape(Rectangle())
    }
}

/// A switch with its one-sentence explanation under the title (the same sentences as Android).
private struct ToggleRow: View {
    let title: String
    var detail: String? = nil
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 15)).foregroundStyle(Theme.fg)
                if let detail {
                    Text(detail).font(.system(size: 13)).foregroundStyle(Theme.fg3)
                }
            }
        }
        .tint(Theme.interactive)
    }
}
