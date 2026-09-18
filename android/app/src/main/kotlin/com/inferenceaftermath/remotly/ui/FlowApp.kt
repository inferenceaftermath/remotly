// Screen switching (no navigation library): Pairing until a host is stored, then Panes / Pane / Settings.
package com.inferenceaftermath.remotly.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.key
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.inferenceaftermath.remotly.push.Notifications
import com.inferenceaftermath.remotly.session.HostState
import com.inferenceaftermath.remotly.session.Session

@Composable
fun FlowApp(session: Session) {
    val hostState by session.hostState.collectAsStateWithLifecycle()
    val demo by session.isDemo.collectAsStateWithLifecycle()
    key(demo) {
        var paneId by rememberSaveable { mutableStateOf<String?>(null) }
        var showSettings by rememberSaveable { mutableStateOf(false) }
        val requested by session.requestedPane.collectAsStateWithLifecycle()
        LaunchedEffect(requested) {
            if (requested != null) {
                paneId = session.consumeRequestedPane()
                showSettings = false
            }
        }
        NotificationPermissionRequest(enabled = !demo && hostState is HostState.Paired)

        Column(Modifier.fillMaxSize().background(Tokens.bg)) {
            if (demo) DemoBanner(onExit = session::exitDemo)
            Box(Modifier.weight(1f).then(if (demo) Modifier.consumeWindowInsets(WindowInsets.statusBars) else Modifier)) {
                when (val hs = if (demo) HostState.Paired(session.demoHost) else hostState) {
                    HostState.Loading -> Box(Modifier.fillMaxSize().background(Tokens.bg))
                    HostState.None -> PairingScreen(session)
                    is HostState.Paired -> {
                        val pane = paneId
                        when {
                            showSettings -> {
                                BackHandler { showSettings = false }
                                SettingsScreen(session, hs.host, onBack = { showSettings = false })
                            }
                            pane != null -> {
                                BackHandler { paneId = null }
                                PaneScreen(session, pane, onBack = { paneId = null })
                            }
                            else -> PanesScreen(session, hs.host, onOpenPane = { paneId = it }, onSettings = { showSettings = true })
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DemoBanner(onExit: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 16.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text("Demo mode · Sample data", style = Type.body, color = Tokens.accent)
            Text("Local simulation · no host connected", style = Type.small, color = Tokens.fg2)
        }
        LinkText("Exit demo", onClick = onExit)
    }
}

/** Android 13+: ask once on first launch after pairing; Settings has an Enable button. */
@Composable
private fun NotificationPermissionRequest(enabled: Boolean) {
    if (Build.VERSION.SDK_INT < 33 || !enabled) return
    val context = LocalContext.current
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(Unit) {
        if (!Notifications.hasPermission(context)) launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
}
