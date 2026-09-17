// `remotly://pair?u=wss://host:port&fp=<base64url sha256>&c=<code>&n=<host name>` (protocol §3).
package com.inferenceaftermath.remotly.core.pairing

import java.net.URI
import java.net.URLDecoder

data class QrPayload(val url: String, val fingerprint: String?, val code: String, val hostName: String?) {

    companion object {
        const val CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        private const val PREFIX = "remotly://pair?"

        fun parse(text: String): QrPayload? {
            val s = text.trim()
            if (!s.startsWith(PREFIX)) return null
            val q = parseQuery(s.substring(PREFIX.length))
            val url = normalizeOrigin(q["u"] ?: return null) ?: return null
            val code = normalizeCode(q["c"] ?: return null)
            if (!isValidCode(code)) return null
            val fp = q["fp"]?.trim()?.takeIf { it.isNotEmpty() }
            if (fp != null && !isValidFingerprint(fp)) return null
            return QrPayload(url, fp, code, q["n"]?.trim()?.takeIf { it.isNotEmpty() })
        }

        private fun parseQuery(query: String): Map<String, String> = query.split('&')
            .filter { it.isNotEmpty() }
            .associate { part ->
                val eq = part.indexOf('=')
                val k = if (eq < 0) part else part.substring(0, eq)
                val v = if (eq < 0) "" else part.substring(eq + 1)
                URLDecoder.decode(k, "UTF-8") to URLDecoder.decode(v, "UTF-8")
            }

        /** Upper-cases and strips spaces/dashes, as the bridge does before comparing. */
        fun normalizeCode(raw: String): String = raw.uppercase().replace(Regex("[\\s\\-]"), "")

        fun isValidCode(code: String) = code.length == 8 && code.all { it in CODE_ALPHABET }

        /** Unpadded base64url of 32 bytes is always 43 characters. */
        fun isValidFingerprint(fp: String) = fp.length == 43 && fp.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '_' }

        /** Accepts `wss://host[:port][/]`; returns `wss://host[:port]` or null when not a TLS WebSocket origin. */
        fun normalizeOrigin(raw: String): String? {
            val uri = try { URI(raw.trim()) } catch (e: Exception) { return null }
            if (uri.scheme?.lowercase() != "wss" || uri.host.isNullOrEmpty()) return null
            if (!uri.rawPath.isNullOrEmpty() && uri.rawPath != "/") return null
            val port = if (uri.port > 0) ":${uri.port}" else ""
            val host = if (uri.host.contains(':') && !uri.host.startsWith("[")) "[${uri.host}]" else uri.host
            return "wss://$host$port"
        }

        /** REST base for the same listener: `wss://h:p` → `https://h:p`. */
        fun httpsOrigin(wssOrigin: String): String = "https://" + wssOrigin.removePrefix("wss://").trimEnd('/')
    }
}
