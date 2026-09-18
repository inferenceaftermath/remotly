package com.inferenceaftermath.remotly.core.demo

import com.inferenceaftermath.remotly.core.connection.*
import com.inferenceaftermath.remotly.core.protocol.ClientInfo
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import okhttp3.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.Test
import java.net.InetAddress
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.*

class ConnectionLifetimeTest {
    @Test fun `entering demo cancels approve and reply waiting for welcome`() = runBlocking {
        for (approve in listOf(true, false)) {
            val peer = Peer()
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
            val lifetime = ConnectionLifetime()
            val http = OkHttpClient()
            val connection = FlowConnection(peer.host, ClientInfo("android", "test", "test"),
                FlowConnection.MODE_ACTION, scope, http, lifetime = lifetime)
            try {
                connection.start()
                val action = async {
                    connection.state.first { it is ConnectionState.Connected || !lifetime.isActive }
                    runCatching {
                        if (approve) connection.approve("test-pane", "test-pane@1", "approve")
                        else connection.prompt("test-pane", "sample reply", false)
                    }
                }
                val socket = withTimeout(5_000) { peer.hello.await() }
                lifetime.cancel() // The same synchronous invalidation used by Session.enterDemo().
                socket.send(WELCOME) // A delayed host answer must not revive this action.
                assertIs<FlowException>(withTimeout(5_000) { action.await() }.exceptionOrNull())
                withTimeout(5_000) { peer.closed.await() }
                assertEquals(listOf("hello"), peer.messages.map { it.substringAfter("\"t\":\"").substringBefore('"') })
                connection.start()
                assertFalse(connection.isConnected, "A cancelled lifetime must stay cancelled after demo exit")
            } finally {
                connection.stop(); scope.cancel(); peer.close()
                http.dispatcher.executorService.shutdown(); http.connectionPool.evictAll()
            }
        }
    }

    @Test fun `fresh real connection can send after leaving demo`() = runBlocking {
        val peer = Peer()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val http = OkHttpClient()
        val cancelled = ConnectionLifetime().also { it.cancel() }
        val fresh = ConnectionLifetime()
        val connection = FlowConnection(peer.host, ClientInfo("android", "test", "test"),
            FlowConnection.MODE_ACTION, scope, http, lifetime = fresh)
        try {
            connection.start()
            withTimeout(5_000) { peer.hello.await() }.send(WELCOME)
            withTimeout(5_000) { connection.state.first { it is ConnectionState.Connected } }
            connection.prompt("test-pane", "sample reply", false)
            assertTrue(peer.messages.any { it.contains("\"t\":\"prompt\"") })
            assertFalse(cancelled.isActive)
            assertTrue(fresh.isActive)
        } finally {
            connection.stop(); scope.cancel(); peer.close()
            http.dispatcher.executorService.shutdown(); http.connectionPool.evictAll()
        }
    }

    private class Peer : AutoCloseable {
        val hello = CompletableDeferred<WebSocket>()
        val closed = CompletableDeferred<Unit>()
        val messages = CopyOnWriteArrayList<String>()
        private val server = MockWebServer()
        val host: HostConfig
        init {
            server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    messages += text
                    if (text.contains("\"t\":\"hello\"")) hello.complete(webSocket)
                    else {
                        val id = Regex("\"id\":\"([^\"]+)\"").find(text)?.groupValues?.get(1) ?: return
                        webSocket.send("{\"t\":\"ok\",\"id\":\"$id\"}")
                    }
                }
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { closed.complete(Unit) }
            }))
            server.start(InetAddress.getLoopbackAddress(), 0)
            host = HostConfig(server.url("/").toString().replace("http://", "ws://").trimEnd('/'), "test-token")
        }
        override fun close() { server.close() }
    }

    companion object {
        private const val WELCOME = "{\"t\":\"welcome\",\"protocol\":1,\"host\":{\"name\":\"Test\",\"flow_version\":\"test\"},\"device\":{\"id\":\"test\",\"name\":\"Test\"},\"notify_done\":[]}"
    }
}
