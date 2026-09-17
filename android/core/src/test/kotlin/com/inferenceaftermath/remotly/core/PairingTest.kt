package com.inferenceaftermath.remotly.core

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import com.inferenceaftermath.remotly.core.pairing.FlowTls
import com.inferenceaftermath.remotly.core.pairing.QrPayload
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class PairingTest {

    @Test
    fun `parses the QR payload with fingerprint`() {
        val p = QrPayload.parse("remotly://pair?u=wss%3A%2F%2F100.101.102.103%3A7460&fp=lrzsBiZJdvN0YHeazyjFp8_oo8Cq4RqP_O4FwL3fCMY&c=AB23CDEF&n=herdr-linux")
        assertNotNull(p)
        assertEquals("wss://100.101.102.103:7460", p.url)
        assertEquals("lrzsBiZJdvN0YHeazyjFp8_oo8Cq4RqP_O4FwL3fCMY", p.fingerprint)
        assertEquals("AB23CDEF", p.code)
        assertEquals("herdr-linux", p.hostName)
    }

    @Test
    fun `fingerprint is optional (publicly trusted cert) and values may be unencoded`() {
        val p = QrPayload.parse("remotly://pair?u=wss://host.tailnet-example.ts.net:7460&c=hjkm-npqr&n=example%20host")
        assertNotNull(p)
        assertNull(p.fingerprint)
        assertEquals("HJKMNPQR", p.code, "code is normalised")
        assertEquals("example host", p.hostName)
        assertEquals("https://host.tailnet-example.ts.net:7460", QrPayload.httpsOrigin(p.url))
    }

    @Test
    fun `rejects wrong scheme, bad code, cleartext and paths`() {
        assertNull(QrPayload.parse("https://example.com/pair?u=wss://h:1&c=AB23CDEF"))
        assertNull(QrPayload.parse("remotly://pair?u=ws://h:1&c=AB23CDEF"), "cleartext origin")
        assertNull(QrPayload.parse("remotly://pair?u=wss://h:1/ws&c=AB23CDEF"), "origin must have no path")
        assertNull(QrPayload.parse("remotly://pair?u=wss://h:1&c=AB23CDE"), "7 chars")
        assertNull(QrPayload.parse("remotly://pair?u=wss://h:1&c=AB01CDEF"), "0 and 1 are not in the alphabet")
        assertNull(QrPayload.parse("remotly://pair?c=AB23CDEF"), "missing u")
        assertNull(QrPayload.parse("remotly://pair?u=wss://h:1&c=AB23CDEF&fp=short"), "bad fingerprint")
        assertEquals("wss://h", QrPayload.normalizeOrigin("wss://h/"))
    }

    @Test
    fun `fingerprint is unpadded base64url of SHA-256 over the DER`() {
        assertEquals(ISRG_FP, FlowTls.fingerprintOf(isrgRootX1()))
        assertEquals(43, ISRG_FP.length)
    }

    @Test
    fun `pinned trust manager accepts exactly the pinned leaf`() {
        val cert = isrgRootX1()
        FlowTls.PinnedTrustManager(ISRG_FP).checkServerTrusted(arrayOf(cert), "RSA")
        assertThrows<CertificateException> { FlowTls.PinnedTrustManager("AAAA" + ISRG_FP.drop(4)).checkServerTrusted(arrayOf(cert), "RSA") }
        assertThrows<CertificateException> { FlowTls.PinnedTrustManager(ISRG_FP).checkServerTrusted(emptyArray(), "RSA") }
    }

    private fun isrgRootX1(): X509Certificate =
        CertificateFactory.getInstance("X.509").generateCertificate(ISRG_PEM.byteInputStream()) as X509Certificate

    companion object {
        // Public ISRG Root X1 certificate (Let's Encrypt), also used by bridge/test/fixtures.
        const val ISRG_FP = "lrzsBiZJdvN0YHeazyjFp8_oo8Cq4RqP_O4FwL3fCMY"
        val ISRG_PEM = """
            -----BEGIN CERTIFICATE-----
            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
            -----END CERTIFICATE-----
        """.trimIndent()
    }
}
