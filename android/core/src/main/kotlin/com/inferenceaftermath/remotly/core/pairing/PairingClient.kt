// POST /pair (protocol §2): exchanges the one-time code for a device token.
package com.inferenceaftermath.remotly.core.pairing

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

@Serializable
data class PairDevice(val name: String, val platform: String, val app_version: String)

@Serializable
data class PairRequest(val code: String, val device: PairDevice)

@Serializable
data class PairResult(val token: String, val device_id: String, val host_name: String = "")

@Serializable
private data class PairErrorBody(val error: String = "", val retry_after_ms: Long? = null)

class PairException(val code: String, val httpStatus: Int, val retryAfterMs: Long? = null) :
    Exception(describe(code, retryAfterMs)) {
    companion object {
        fun describe(code: String, retryAfterMs: Long?): String = when (code) {
            "bad_code" -> "Wrong or expired pairing code"
            "forbidden" -> "This device is not on the host's tailnet"
            "locked_out" -> "Too many attempts; try again in ${((retryAfterMs ?: 0) / 60000).coerceAtLeast(1)} min"
            "bad_request" -> "The bridge rejected the request"
            "network" -> "Could not reach the host"
            else -> "Pairing failed ($code)"
        }
    }
}

class PairingClient(private val clientFor: (String?) -> OkHttpClient = { fp ->
    FlowTls.client(fp, OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS))
}) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    /** @param origin `wss://host:port` from the QR; the REST call goes to the same listener over https. */
    suspend fun pair(origin: String, code: String, fingerprint: String?, device: PairDevice): PairResult =
        withContext(Dispatchers.IO) {
            val body = json.encodeToString(PairRequest.serializer(), PairRequest(QrPayload.normalizeCode(code), device))
            val request = Request.Builder()
                .url(QrPayload.httpsOrigin(origin) + "/pair")
                .post(body.toRequestBody("application/json".toMediaType()))
                .build()
            val response = try {
                clientFor(fingerprint).newCall(request).execute()
            } catch (e: IOException) {
                throw PairException("network", 0).initCause(e)
            }
            response.use { r ->
                val text = r.body?.string() ?: ""
                if (r.code == 200) {
                    try {
                        json.decodeFromString(PairResult.serializer(), text)
                    } catch (e: Exception) {
                        throw PairException("bad_response", r.code)
                    }
                } else {
                    val err = try { json.decodeFromString(PairErrorBody.serializer(), text) } catch (e: Exception) { PairErrorBody() }
                    throw PairException(err.error.ifEmpty { "http_${r.code}" }, r.code, err.retry_after_ms)
                }
            }
        }
}
