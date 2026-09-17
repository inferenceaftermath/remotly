// Key row (→ `keys`) and the composer (→ `prompt`, or `text` in raw mode). DESIGN.md §4.6 and §4.7.
package com.inferenceaftermath.remotly.ui

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Caps in the fixed order of DESIGN.md §4.6: label → herdr key name (protocol §5). */
private val CAPS: List<Pair<String, String>> = listOf(
    "Esc" to "esc", "Tab" to "tab", "Ctrl" to "ctrl", "↑" to "up", "↓" to "down", "←" to "left", "→" to "right", "⏎" to "enter",
    "Home" to "home", "End" to "end", "PgUp" to "pageup", "PgDn" to "pagedown", "⇧Tab" to "shift+tab", "Del" to "delete", "⌫" to "backspace", "^C" to "ctrl+c",
)
private val ARROWS = setOf("up", "down", "left", "right")
private val CTRL_LETTERS = listOf("C", "D", "Z", "L", "A", "E", "U", "K", "R", "W", "X", "B", "N", "P", "F", "G", "O", "[", "\\")

/**
 * Eight caps fill the width; the strip scrolls for the rest. Ctrl is sticky for one key: armed, `Esc Tab Ctrl ↑ ↓ ← →`
 * stay in place (the arrows now send `ctrl+<arrow>`) and the caps from ⏎ onward become the Ctrl letters (each sends
 * `ctrl+<x>` and disarms). Same order as iOS.
 */
@Composable
fun KeyRow(ctrl: Boolean, onCtrl: (Boolean) -> Unit, onKeys: (List<String>) -> Unit) {
    fun send(name: String) {
        val modified = ctrl && name in ARROWS
        onKeys(listOf(if (modified) "ctrl+$name" else name))
        if (modified) onCtrl(false)
    }
    BoxWithConstraints(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        val capWidth = (maxWidth - 20.dp - 6.dp * 7) / 8
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (!ctrl) {
                for ((label, name) in CAPS) {
                    if (name == "ctrl") KeyCap("Ctrl", capWidth, armed = false) { onCtrl(true) }
                    else KeyCap(label, capWidth, armed = false) { send(name) }
                }
            } else {
                KeyCap("Esc", capWidth, armed = false) { send("esc") }
                KeyCap("Tab", capWidth, armed = false) { send("tab") }
                KeyCap("Ctrl", capWidth, armed = true) { onCtrl(false) }
                for ((label, name) in CAPS) if (name in ARROWS) KeyCap(label, capWidth, armed = false) { send(name) }
                for (letter in CTRL_LETTERS) {
                    KeyCap(letter, capWidth, armed = false) {
                        onKeys(listOf("ctrl+${letter.lowercase()}"))
                        onCtrl(false)
                    }
                }
            }
        }
    }
}

@Composable
private fun KeyCap(label: String, width: androidx.compose.ui.unit.Dp, armed: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(8.dp)
    val fill by animateColorAsState(if (armed) Tokens.accentWash else Tokens.panel2, tween(150), label = "capFill")
    val border by animateColorAsState(if (armed) Tokens.accent else Tokens.line, tween(150), label = "capBorder")
    val text by animateColorAsState(if (armed) Tokens.accent else Tokens.titleFg, tween(150), label = "capText")
    Box(
        Modifier.width(width).height(34.dp).clip(shape).background(fill).border(1.dp, border, shape).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        // Mono 15; a single glyph (arrows, ⏎, ⌫, the Ctrl letters) 18 (§4.6). The cap keeps its 34 dp height.
        FittedCapLabel(label, if (label.length == 1) 18.sp else 15.sp, text, width)
    }
}

/** The cap's label, shrunk in steps (to 75 %) while it overflows the cap — iOS's `minimumScaleFactor`; starts over when the cap's width changes. */
@Composable
private fun FittedCapLabel(label: String, size: TextUnit, color: Color, capWidth: androidx.compose.ui.unit.Dp) {
    val floor = size.value * 0.75f
    var fontSize by remember(label, size, capWidth) { mutableStateOf(size) }
    Text(
        label, style = Type.keyCap.copy(fontSize = fontSize), color = color, maxLines = 1, softWrap = false,
        onTextLayout = { if (it.didOverflowWidth && fontSize.value > floor) fontSize = maxOf(fontSize.value * 0.9f, floor).sp },
    )
}

/**
 * Prompt mode sends the whole text as one `prompt` (agent.prompt; herdr appends Enter). Raw mode sends
 * `text` verbatim. With Ctrl armed (either mode) the first character typed goes out as `ctrl+<char>`.
 */
@Composable
fun Composer(rawMode: Boolean, ctrl: Boolean, upload: (suspend (ByteArray) -> String)?, onSend: (text: String, raw: Boolean) -> Unit) {
    var text by rememberSaveable { mutableStateOf("") }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // Photos waiting in the composer; their host paths go out with the next message (protocol §2 "Uploads").
    val attachments = remember { mutableStateListOf<Attachment>() }
    var attachMenu by remember { mutableStateOf(false) }
    var cameraUri by rememberSaveable { mutableStateOf<Uri?>(null) }

    fun startUpload(a: Attachment) {
        val up = upload ?: return
        a.state = Attachment.State.Uploading
        scope.launch {
            try {
                a.state = Attachment.State.Uploaded(up(a.jpeg))
            } catch (e: Exception) {
                a.state = Attachment.State.Failed(e.message ?: e.javaClass.simpleName)
            }
        }
    }
    fun addUris(uris: List<Uri>) {
        scope.launch {
            for (uri in uris) {
                val a = withContext(Dispatchers.Default) { ImagePrep.prepare(context, uri) } ?: continue
                attachments += a
                startUpload(a)
            }
        }
    }
    val pickPhotos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(4)) { uris -> addUris(uris) }
    val takePhoto = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val uri = cameraUri
        cameraUri = null
        if (ok && uri != null) addUris(listOf(uri))
    }
    fun launchCamera() {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", ImagePrep.cameraFile(context))
        cameraUri = uri
        takePhoto.launch(uri)
    }
    // The manifest declares CAMERA for the QR scanner, so the system camera intent needs it granted first.
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (granted) launchCamera() }

    // Text or photos (or both) go out together; Send waits until every photo is stored on the host.
    val paths = attachments.mapNotNull { it.path }
    val canSend = (text.isNotEmpty() || paths.isNotEmpty()) && attachments.all { it.path != null }
    fun send() {
        if (!canSend) return
        val body = (listOf(text).filter { it.isNotEmpty() } + paths).joinToString(" ")
        if (body.isEmpty()) return
        onSend(body, rawMode)
        text = ""
        attachments.clear()
    }
    val shape = RoundedCornerShape(16.dp)
    Column(Modifier.fillMaxWidth().background(Tokens.bg).padding(horizontal = 10.dp, vertical = 8.dp)) {
        Column(Modifier.fillMaxWidth().clip(shape).background(Tokens.panel2).border(1.dp, Tokens.line, shape).padding(horizontal = 10.dp, vertical = 8.dp)) {
            if (attachments.isNotEmpty()) {
                AttachmentChips(attachments, onRemove = { attachments.remove(it) }, onRetry = { startUpload(it) })
                Spacer(Modifier.height(6.dp))
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
                Box(Modifier.padding(bottom = 2.dp)) {
                    RoundButton(24.dp, Tokens.line, enabled = upload != null && attachments.size < 8, onClick = { attachMenu = true }) {
                        Text("+", color = Tokens.titleFg, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                    }
                    DropdownMenu(
                        expanded = attachMenu, onDismissRequest = { attachMenu = false },
                        shape = RoundedCornerShape(12.dp), containerColor = Tokens.panel2, border = BorderStroke(1.dp, Tokens.line),
                    ) {
                        if (context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
                            DropdownMenuItem(text = { Text("Take photo", style = Type.body) }, onClick = {
                                attachMenu = false
                                if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) launchCamera()
                                else cameraPermission.launch(Manifest.permission.CAMERA)
                            })
                        }
                        DropdownMenuItem(text = { Text("Choose photos", style = Type.body) }, onClick = {
                            attachMenu = false
                            pickPhotos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                        })
                    }
                }
                val placeholder = when {
                    ctrl -> "Ctrl + one key…"
                    rawMode -> "Type raw text…"
                    else -> "Message the agent…"
                }
                BasicTextField(
                    value = text,
                    onValueChange = { new ->
                        // Ctrl armed: the one character just typed goes out at once (PaneScreen turns it into `ctrl+<key>` and
                        // disarms); the draft is left as it was. Same on iOS.
                        val typed = if (ctrl && new.length > text.length && new.startsWith(text)) new.substring(text.length) else null
                        if (typed != null && typed.codePointCount(0, typed.length) == 1) onSend(typed, rawMode) else text = new
                    },
                    modifier = Modifier.weight(1f).padding(horizontal = 10.dp, vertical = 3.dp),
                    textStyle = Type.composer,
                    cursorBrush = SolidColor(Tokens.interactive),
                    maxLines = 6,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = !rawMode,
                        imeAction = if (rawMode) ImeAction.Send else ImeAction.Default,
                    ),
                    keyboardActions = KeyboardActions(onSend = { send() }),
                    decorationBox = { inner ->
                        Box {
                            if (text.isEmpty()) Text(placeholder, style = Type.composer, color = Tokens.fg3, maxLines = 1)
                            inner()
                        }
                    },
                )
                RoundButton(28.dp, Tokens.interactive, enabled = canSend, onClick = { send() }) {
                    Text("↑", color = Tokens.onInteractive, fontSize = 17.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}
