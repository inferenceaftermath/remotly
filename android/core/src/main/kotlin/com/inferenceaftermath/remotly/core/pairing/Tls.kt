// TLS trust: pin exactly the leaf whose base64url(SHA-256(DER)) matches the fingerprint from the QR
// (self-signed mode); otherwise the platform's normal trust store and hostname verification apply.
package com.inferenceaftermath.remotly.core.pairing

import okhttp3.OkHttpClient
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Base64
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

object FlowTls {

    fun fingerprintOf(der: ByteArray): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(der))

    fun fingerprintOf(cert: X509Certificate): String = fingerprintOf(cert.encoded)

    /** OkHttp client for the given host: pinned when `fingerprint` is present, system trust otherwise. */
    fun client(fingerprint: String?, builder: OkHttpClient.Builder = OkHttpClient.Builder()): OkHttpClient {
        if (fingerprint.isNullOrEmpty()) return builder.build()
        val tm = PinnedTrustManager(fingerprint)
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(null, arrayOf(tm), null)
        return builder
            .sslSocketFactory(ctx.socketFactory, tm)
            // The pin identifies the exact certificate, so the name in it is irrelevant (it is an IP anyway).
            .hostnameVerifier { _, _ -> true }
            .build()
    }

    class PinnedTrustManager(private val fingerprint: String) : X509TrustManager {
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            val leaf = chain?.firstOrNull() ?: throw CertificateException("empty certificate chain")
            val actual = fingerprintOf(leaf)
            if (actual != fingerprint) throw CertificateException("certificate fingerprint mismatch: $actual")
        }

        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            throw CertificateException("client certificates are not supported")
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
}
