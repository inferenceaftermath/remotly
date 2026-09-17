// POST /upload (protocol §2): a photo from the phone becomes a file on the host that the program in a pane
// reads by path. Same origin, TLS trust and device token as the WebSocket.
package com.inferenceaftermath.remotly.core.connection

import com.inferenceaftermath.remotly.core.pairing.FlowTls
import com.inferenceaftermath.remotly.core.pairing.QrPayload
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** @property path absolute path of the stored file on the host. */
@Serializable
data class UploadResult(val path: String, val bytes: Long = 0)

@Serializable
private data class UploadErrorBody(val error: String = "")

class UploadException(val code: String, val httpStatus: Int) : Exception(describe(code, httpStatus)) {
    companion object {
        fun describe(code: String, status: Int): String = when (code) {
            "auth" -> "The bridge no longer accepts this device; pair again"
            "forbidden" -> "This device is not on the host's tailnet"
            "too_large" -> "The photo is too large for the bridge"
            "unsupported_type" -> "The bridge accepts JPEG and PNG only"
            "network" -> "Could not reach the host"
            else -> "Upload failed (HTTP $status)"
        }
    }
}

class UploadClient(
    private val host: HostConfig,
    private val clientFor: (String?) -> OkHttpClient = { fp ->
        FlowTls.client(fp, OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).writeTimeout(60, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS))
    },
) {
    private val json = Json { ignoreUnknownKeys = true }

    suspend fun upload(bytes: ByteArray, contentType: String = "image/jpeg"): UploadResult = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(QrPayload.httpsOrigin(host.url) + "/upload")
            .header("Authorization", "Bearer ${host.token}")
            .post(bytes.toRequestBody(contentType.toMediaType()))
            .build()
        val response = try {
            clientFor(host.fingerprint).newCall(request).execute()
        } catch (e: IOException) {
            throw UploadException("network", 0).initCause(e)
        }
        response.use { r ->
            val text = r.body?.string() ?: ""
            if (r.code == 200) {
                try {
                    json.decodeFromString(UploadResult.serializer(), text)
                } catch (e: Exception) {
                    throw UploadException("bad_response", r.code)
                }
            } else {
                val code = try { json.decodeFromString(UploadErrorBody.serializer(), text).error } catch (e: Exception) { "" }
                throw UploadException(code.ifEmpty { "http_${r.code}" }, r.code)
            }
        }
    }
}
