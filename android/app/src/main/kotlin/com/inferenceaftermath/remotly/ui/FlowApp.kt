// Screen switching (no navigation library): Pairing until a host is stored, then Panes / Pane / Settings.
package com.inferenceaftermath.remotly.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
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
    var paneId by rememberSaveable { mutableStateOf<String?>(null) }
    var showSettings by rememberSaveable { mutableStateOf(false) }
    val requested by session.requestedPane.collectAsStateWithLifecycle()
    LaunchedEffect(requested) {
        if (requested != null) {
            paneId = session.consumeRequestedPane()
            showSettings = false
        }
    }
    NotificationPermissionRequest(enabled = hostState is HostState.Paired)

    when (val hs = hostState) {
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
