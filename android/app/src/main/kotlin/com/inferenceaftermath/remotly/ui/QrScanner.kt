// CameraX preview + ImageAnalysis feeding ZXing (QR only). Fully offline; no Play services model download.
package com.inferenceaftermath.remotly.ui

import android.os.Handler
import android.os.Looper
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.NotFoundException
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.util.concurrent.Executors

@Composable
fun QrScanner(modifier: Modifier = Modifier, onResult: (String) -> Unit) {
    val lifecycleOwner = LocalLifecycleOwner.current
    val executor = remember { Executors.newSingleThreadExecutor() }
    DisposableEffect(Unit) { onDispose { executor.shutdown() } }
    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            PreviewView(ctx).apply {
                scaleType = PreviewView.ScaleType.FILL_CENTER
                implementationMode = PreviewView.ImplementationMode.COMPATIBLE
                val future = ProcessCameraProvider.getInstance(ctx)
                future.addListener({
                    val provider = future.get()
                    val preview = Preview.Builder().build().also { it.surfaceProvider = surfaceProvider }
                    val analysis = ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888)
                        .build()
                    analysis.setAnalyzer(executor, QrAnalyzer(onResult))
                    runCatching {
                        provider.unbindAll()
                        provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                    }
                }, ContextCompat.getMainExecutor(ctx))
            }
        },
    )
}

private class QrAnalyzer(private val onResult: (String) -> Unit) : ImageAnalysis.Analyzer {
    private val reader = MultiFormatReader().apply {
        setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.TRY_HARDER to true))
    }
    private val main = Handler(Looper.getMainLooper())
    private var lastText = ""
    private var lastAt = 0L

    override fun analyze(image: ImageProxy) {
        try {
            val plane = image.planes[0]
            val w = image.width
            val h = image.height
            val luma = ByteArray(w * h)
            val buffer = plane.buffer
            if (plane.rowStride == w) {
                buffer.get(luma, 0, minOf(luma.size, buffer.remaining()))
            } else {
                for (row in 0 until h) {
                    buffer.position(row * plane.rowStride)
                    buffer.get(luma, row * w, minOf(w, buffer.remaining()))
                }
            }
            val source = PlanarYUVLuminanceSource(luma, w, h, 0, 0, w, h, false)
            val result = reader.decodeWithState(BinaryBitmap(HybridBinarizer(source)))
            val now = System.currentTimeMillis()
            if (result.text != lastText || now - lastAt > 2000) {
                lastText = result.text
                lastAt = now
                main.post { onResult(result.text) }
            }
        } catch (e: NotFoundException) {
            // no code in this frame
        } catch (e: Exception) {
            // malformed frame; skip
        } finally {
            reader.reset()
            image.close()
        }
    }
}
