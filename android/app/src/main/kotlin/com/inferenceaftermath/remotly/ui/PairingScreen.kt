// Pair (DESIGN.md §4.8): scan the `remotly://pair?…` QR from `remotly-bridge pair` (camera) or type URL / code
// / fingerprint. A valid scan pairs at once.
package com.inferenceaftermath.remotly.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.inferenceaftermath.remotly.core.pairing.PairException
import com.inferenceaftermath.remotly.core.pairing.QrPayload
import com.inferenceaftermath.remotly.session.Session
import kotlinx.coroutines.launch

@Composable
fun PairingScreen(session: Session) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var hasCamera by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { hasCamera = it }
    // Approval alerts need POST_NOTIFICATIONS (Android 13+); ask right after pairing succeeds, when the
    // user is in the flow, instead of relying on the Settings screen being discovered.
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var url by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    var hostName by rememberSaveable { mutableStateOf("") }
    var fingerprint by rememberSaveable { mutableStateOf("") }
    var showFingerprint by rememberSaveable { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var lastForeignAt by remember { mutableLongStateOf(0L) }

    fun pair(p: QrPayload) {
        if (busy) return
        busy = true
        error = null
        session.notify("pairing with ${p.hostName?.takeIf { it.isNotBlank() } ?: p.url.removePrefix("wss://")}…")
        scope.launch {
            try {
                session.pair(p)
                if (Build.VERSION.SDK_INT >= 33 &&
                    ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                ) {
                    notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
            } catch (e: Exception) {
                val message = if (e is PairException) e.message ?: "Pairing failed" else "Pairing failed: ${e.message ?: e.javaClass.simpleName}"
                error = message
                if (tab == 0) session.notify(message)
            } finally {
                busy = false
            }
        }
    }

    Scaffold(
        containerColor = Tokens.bg,
        topBar = {
            Box(Modifier.fillMaxWidth().background(Tokens.bg).statusBarsPadding().height(52.dp), contentAlignment = Alignment.Center) {
                Text("Pair with a host", style = Type.navTitle)
            }
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
                Spacer(Modifier.height(14.dp))
                PrimaryButton("Try demo", enabled = !busy, onClick = { session.enterDemo() })
                Spacer(Modifier.height(6.dp))
                Text("Explore local sample sessions. Nothing is sent to a host.", style = Type.hint)
                Spacer(Modifier.height(20.dp))
                Segmented(listOf("Scan QR", "Enter code"), tab) { tab = it; error = null }
                Spacer(Modifier.height(16.dp))
                if (tab == 0) {
                    Box(Modifier.fillMaxWidth().aspectRatio(4f / 3f).clip(RoundedCornerShape(18.dp)).background(Tokens.panel)) {
                        if (hasCamera) {
                            if (!busy) {
                                QrScanner(Modifier.fillMaxSize()) { text ->
                                    val parsed = QrPayload.parse(text)
                                    if (parsed != null) {
                                        pair(parsed)
                                    } else {
                                        val now = System.currentTimeMillis()
                                        if (now - lastForeignAt > 2400) {
                                            lastForeignAt = now
                                            session.notify("Not a Remotly pairing code")
                                        }
                                    }
                                }
                            }
                        } else {
                            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text("The camera is needed to scan the code.", style = Type.hint, textAlign = TextAlign.Center)
                                LinkText("Allow camera") { cameraPermission.launch(Manifest.permission.CAMERA) }
                            }
                        }
                        Canvas(Modifier.fillMaxSize()) { viewfinderCorners() }
                    }
                    Spacer(Modifier.height(16.dp))
                    Text("Point the camera at the code on your host's screen.", style = Type.hint, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
                    Spacer(Modifier.height(6.dp))
                    Text("$ remotly-bridge pair", style = Type.monoSmall, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        FlowField(
                            url, { url = it }, placeholder = "Host URL (e.g. 100.101.102.103:7460)",
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                        )
                        FlowField(
                            code, { code = it.uppercase() }, placeholder = "Pairing code (8 characters)", mono = true,
                            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false),
                        )
                        FlowField(hostName, { hostName = it }, placeholder = "Host name (optional)", keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, autoCorrectEnabled = false))
                        Row(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable { showFingerprint = !showFingerprint }.padding(horizontal = 4.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("Self-signed certificate", style = Type.body, color = Tokens.fg2, modifier = Modifier.weight(1f))
                            Icon(
                                if (showFingerprint) Icons.Default.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
                                contentDescription = if (showFingerprint) "Hide" else "Show", tint = Tokens.fg2, modifier = Modifier.size(22.dp),
                            )
                        }
                        if (showFingerprint) {
                            FlowField(
                                fingerprint, { fingerprint = it.trim() }, placeholder = "Certificate fingerprint (base64url SHA-256)", mono = true,
                                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                            )
                            Text("Leave empty when the bridge uses a Tailscale certificate.", style = Type.small.copy(fontSize = 13.sp), color = Tokens.fg3)
                        }
                        Spacer(Modifier.height(4.dp))
                        PrimaryButton(
                            "Pair",
                            enabled = !busy && url.isNotBlank() && code.isNotBlank(),
                            onClick = {
                                val raw = url.trim()
                                val origin = QrPayload.normalizeOrigin(if (raw.contains("://")) raw else "wss://$raw")
                                val c = QrPayload.normalizeCode(code)
                                when {
                                    origin == null -> error = "Enter the host as host:port"
                                    !QrPayload.isValidCode(c) -> error = "The code is 8 characters from A–Z and 2–9 (no I, O, 0, 1)"
                                    fingerprint.isNotEmpty() && !QrPayload.isValidFingerprint(fingerprint) -> error = "The fingerprint is 43 base64url characters"
                                    else -> pair(QrPayload(origin, fingerprint.ifEmpty { null }, c, hostName.trim().ifEmpty { null }))
                                }
                            },
                        )
                        error?.let { Text(it, style = Type.small, color = Tokens.blocked) }
                    }
                }
                Spacer(Modifier.height(24.dp))
            }
            if (busy) {
                Box(Modifier.fillMaxSize().background(Color(0x990B0C0E)), contentAlignment = Alignment.Center) {
                    PanelCard(radius = 14.dp) {
                        Row(Modifier.padding(horizontal = 20.dp, vertical = 16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            CircularProgressIndicator(color = Tokens.interactive, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                            Text("Pairing…", style = Type.body)
                        }
                    }
                }
            }
            ToastHost(session)
        }
    }
}

/** Four `accent` corner brackets: 26 long, 3 thick, 12 in from the edge, rounded at the outer corner. */
private fun DrawScope.viewfinderCorners() {
    val inset = 12.dp.toPx()
    val len = 26.dp.toPx()
    val r = 6.dp.toPx()
    val stroke = Stroke(width = 3.dp.toPx(), cap = StrokeCap.Round)
    fun corner(cx: Float, cy: Float, sx: Float, sy: Float) {
        val path = Path().apply {
            moveTo(cx, cy + sy * len)
            lineTo(cx, cy + sy * r)
            quadraticTo(cx, cy, cx + sx * r, cy)
            lineTo(cx + sx * len, cy)
        }
        drawPath(path, Tokens.accent, style = stroke)
    }
    corner(inset, inset, 1f, 1f)
    corner(size.width - inset, inset, -1f, 1f)
    corner(inset, size.height - inset, 1f, -1f)
    corner(size.width - inset, size.height - inset, -1f, -1f)
}
