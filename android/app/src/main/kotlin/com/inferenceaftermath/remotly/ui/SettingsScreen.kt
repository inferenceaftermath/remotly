// Settings (DESIGN.md §4.9): Host · Notifications · Terminal · About, then "Forget this host".
package com.inferenceaftermath.remotly.ui

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.inferenceaftermath.remotly.core.connection.ConnectionState
import com.inferenceaftermath.remotly.core.connection.HostConfig
import com.inferenceaftermath.remotly.core.protocol.PROTOCOL_VERSION
import com.inferenceaftermath.remotly.push.Notifications
import com.inferenceaftermath.remotly.push.PushRegistrar
import com.inferenceaftermath.remotly.session.Session
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(session: Session, host: HostConfig, onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val demo by session.isDemo.collectAsStateWithLifecycle()
    val connState by session.connState.collectAsStateWithLifecycle()
    val fitToDevice by session.fitToDevice.collectAsStateWithLifecycle()
    val zoomOnDesktop by session.zoomOnDesktop.collectAsStateWithLifecycle()
    val notifyOnPrompt by session.notifyOnPrompt.collectAsStateWithLifecycle()
    val requireUnlock by session.requireUnlock.collectAsStateWithLifecycle()
    val liveStatus by session.liveStatus.collectAsStateWithLifecycle()
    val pushToken by session.store.pushToken.collectAsStateWithLifecycle(initialValue = null)
    val welcome = (connState as? ConnectionState.Connected)?.welcome
    var notificationsAllowed by remember { mutableStateOf(Notifications.hasPermission(context)) }
    fun openSystemNotificationSettings() {
        context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        notificationsAllowed = granted
        if (!granted) openSystemNotificationSettings() // the system no longer prompts once it was denied twice
    }
    var confirmForget by remember { mutableStateOf(false) }
    val certificate = host.fingerprint?.let { "Self-signed · pinned $it" } ?: "From your tailnet"

    Scaffold(
        containerColor = Tokens.bg,
        topBar = {
            Row(
                Modifier.fillMaxWidth().background(Tokens.bg).statusBarsPadding().heightIn(min = 52.dp).padding(start = 2.dp, end = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, contentDescription = "Back", tint = Tokens.interactive, modifier = Modifier.size(30.dp))
                }
                Text("Settings", style = Type.navTitle)
            }
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                val inset = Modifier.padding(horizontal = 16.dp)
                SectionLabel("Host", inset)
                SettingRow("Name", host.hostName.ifEmpty { "—" })
                if (!demo) {
                    SettingRow("Bridge", host.url, mono = true)
                    SettingRow("Certificate", certificate, mono = host.fingerprint != null, onClick = {
                        context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("certificate", certificate))
                        session.notify("copied")
                    })
                }
                SettingRow("This device", session.clientInfo.device_name)

                SectionLabel("Notifications", inset)
                if (demo) SettingRow("Unavailable in demo", "Notifications and photo uploads require a paired host.")
                else {
                    SettingRow(
                        "Permission",
                        if (notificationsAllowed) "Allowed" else "Not allowed",
                        trailing = {
                            if (!notificationsAllowed) {
                                if (Build.VERSION.SDK_INT >= 33) LinkText("Enable") { permission.launch(Manifest.permission.POST_NOTIFICATIONS) }
                                else LinkText("Open system settings") { openSystemNotificationSettings() }
                            }
                        },
                    )
                    SettingRow(
                        "Tell me when it's done by default",
                        "Every prompt sent from this phone asks for one notification when the agent finishes its turn.",
                        trailing = { FlowSwitch(notifyOnPrompt) { session.setNotifyOnPrompt(it) } },
                    )
                    SettingRow(
                        "Require unlock to approve",
                        "Approve, Deny with feedback and Reply from a notification work only once the phone is unlocked.",
                        trailing = { FlowSwitch(requireUnlock) { session.setRequireUnlock(it) } },
                    )
                    SettingRow(
                        "Show working agents",
                        "Each working agent stays visible outside the app with a running timer.",
                        trailing = { FlowSwitch(liveStatus) { session.setLiveStatus(it) } },
                    )
                }
                SectionLabel("Terminal", inset)
                SettingRow(
                    "Fit pane to this phone",
                    "While you view a pane, its width on the desktop follows this screen's columns.",
                    trailing = { FlowSwitch(fitToDevice) { session.setFitToDevice(it) } },
                )
                SettingRow(
                    "Zoom on desktop while viewing",
                    "The pane fills its desktop tab while you view it; the split comes back when you leave.",
                    trailing = { FlowSwitch(zoomOnDesktop) { session.setZoomOnDesktop(it) } },
                )

                SectionLabel("About", inset)
                SettingRow("App", "${session.clientInfo.app_version} · protocol $PROTOCOL_VERSION")
                SettingRow("Bridge", welcome?.let { "${it.host.flow_version ?: "—"} · herdr ${it.host.herdr_version ?: "—"}" } ?: "not connected")
                SettingRow(
                    "Push",
                    (if (demo) "Unavailable in demo" else (if (pushToken != null) "registered" else "not issued") + " · " + (if (PushRegistrar.isConfigured(context)) "Firebase configured" else "Firebase not configured")),
                )
                SettingRow("Terminal font", "JetBrains Mono · OFL 1.1")

                Spacer(Modifier.height(16.dp))
                Hairline(inset)
                if (demo) SettingRow("Exit demo", onClick = { session.exitDemo(); onBack() })
                else {
                    SettingRow("Try demo", "Local sample sessions. Your saved host is preserved.", onClick = { session.enterDemo(); onBack() })
                    SettingRow("Forget this host", titleColor = Tokens.blocked, onClick = { confirmForget = true })
                }
                Spacer(Modifier.height(24.dp))
            }
            ToastHost(session)
        }
    }

    if (confirmForget) {
        AlertDialog(
            onDismissRequest = { confirmForget = false },
            containerColor = Tokens.panel,
            titleContentColor = Tokens.fg,
            textContentColor = Tokens.fg2,
            shape = RoundedCornerShape(16.dp),
            title = { Text("Forget ${host.hostName.ifEmpty { "this host" }}?", style = Type.navTitle) },
            text = { Text("The device token is deleted and push registration removed. Pair again with a new code from remotly-bridge pair.", style = Type.description) },
            confirmButton = {
                TextButton(onClick = {
                    confirmForget = false
                    scope.launch {
                        session.unpair()
                        onBack()
                    }
                }) { Text("Forget", color = Tokens.blocked, fontWeight = FontWeight.SemiBold) }
            },
            dismissButton = { TextButton(onClick = { confirmForget = false }) { Text("Cancel", color = Tokens.fg2) } },
        )
    }
}
