// Photos attached to the composer: taken with the camera or picked from the photo picker, downscaled on the
// phone, uploaded to the bridge at once, and appended to the next message as file paths the program in the
// pane reads (protocol §2 "Uploads"). Works the same for Claude Code, Codex and pi.
package com.inferenceaftermath.remotly.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** One photo in the composer; [path] is set once the bridge has stored it. */
class Attachment(val thumbnail: Bitmap, val jpeg: ByteArray) {
    sealed interface State {
        data object Uploading : State
        data class Uploaded(val path: String) : State
        data class Failed(val message: String) : State
    }

    var state: State by mutableStateOf(State.Uploading)
    val path: String? get() = (state as? State.Uploaded)?.path
}

object ImagePrep {
    /** Long-edge cap: about what the models see anyway, and a few hundred KB instead of several MB. */
    const val MAX_EDGE = 1568
    const val QUALITY = 85
    const val THUMB_EDGE = 112

    /** Decode [uri] near MAX_EDGE (orientation applied on API 28+), re-encode as JPEG, drop metadata. */
    fun prepare(context: Context, uri: Uri): Attachment? = decode(context, uri)?.let { prepare(it) }

    fun prepare(bitmap: Bitmap): Attachment {
        val scaled = fit(bitmap, MAX_EDGE)
        val out = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, QUALITY, out)
        return Attachment(square(scaled, THUMB_EDGE), out.toByteArray())
    }

    /** A private file for the camera app to write into (handed over through the FileProvider). */
    fun cameraFile(context: Context): File {
        val dir = File(context.cacheDir, "camera").apply { mkdirs() }
        return File(dir, "capture-${System.currentTimeMillis()}.jpg")
    }

    private fun decode(context: Context, uri: Uri): Bitmap? = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.contentResolver, uri)) { decoder, info, _ ->
                val longest = max(info.size.width, info.size.height)
                if (longest > MAX_EDGE) decoder.setTargetSampleSize(max(1, longest / MAX_EDGE))
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                decoder.isMutableRequired = false
            }
        } else {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
            val longest = max(bounds.outWidth, bounds.outHeight)
            val opts = BitmapFactory.Options().apply { inSampleSize = max(1, longest / MAX_EDGE) }
            context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) }
        }
    } catch (e: Exception) {
        null
    }

    private fun fit(b: Bitmap, maxEdge: Int): Bitmap {
        val longest = max(b.width, b.height)
        if (longest <= maxEdge) return b
        val f = maxEdge.toFloat() / longest
        return Bitmap.createScaledBitmap(b, (b.width * f).roundToInt().coerceAtLeast(1), (b.height * f).roundToInt().coerceAtLeast(1), true)
    }

    /** Centre-cropped square for the chip. */
    private fun square(b: Bitmap, edge: Int): Bitmap {
        val side = min(b.width, b.height)
        val cropped = Bitmap.createBitmap(b, (b.width - side) / 2, (b.height - side) / 2, side, side)
        return Bitmap.createScaledBitmap(cropped, edge, edge, true)
    }
}

/** Thumbnails above the composer: a spinner while uploading, a red retry face after a failure, ✕ to drop. */
@Composable
fun AttachmentChips(attachments: List<Attachment>, onRemove: (Attachment) -> Unit, onRetry: (Attachment) -> Unit) {
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 10.dp, vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        for (a in attachments) {
            Box(Modifier.size(64.dp)) {
                Box(
                    Modifier.size(56.dp).align(Alignment.BottomStart).clip(RoundedCornerShape(8.dp))
                        .clickable(enabled = a.state is Attachment.State.Failed) { onRetry(a) },
                ) {
                    Image(a.thumbnail.asImageBitmap(), contentDescription = "Photo", contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                    when (val s = a.state) {
                        Attachment.State.Uploading -> Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.35f)), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(Modifier.size(22.dp), color = Color.White, strokeWidth = 2.dp)
                        }
                        is Attachment.State.Failed -> Box(Modifier.fillMaxSize().background(Color.Red.copy(alpha = 0.45f)), contentAlignment = Alignment.Center) {
                            Icon(Icons.Default.Refresh, contentDescription = "Upload failed: ${s.message}. Tap to retry", tint = Color.White)
                        }
                        is Attachment.State.Uploaded -> Unit
                    }
                }
                Icon(
                    Icons.Default.Close, contentDescription = "Remove photo", tint = Color.White,
                    modifier = Modifier.align(Alignment.TopEnd).size(20.dp).clip(RoundedCornerShape(10.dp))
                        .background(Color.Black.copy(alpha = 0.65f)).clickable { onRemove(a) }.padding(2.dp),
                )
            }
        }
    }
}
