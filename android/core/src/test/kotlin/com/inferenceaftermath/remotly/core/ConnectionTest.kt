package com.inferenceaftermath.remotly.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import com.inferenceaftermath.remotly.core.connection.ConnectionState
import com.inferenceaftermath.remotly.core.connection.FlowConnection
import com.inferenceaftermath.remotly.core.connection.HostConfig
import com.inferenceaftermath.remotly.core.protocol.ClientInfo
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Exercises inbound dispatch without a socket (the socket path is covered on-device). */
class ConnectionTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val conn = FlowConnection(HostConfig("wss://h:1", "tok", null), ClientInfo("android", "t", "d"), scope = scope)

    @AfterEach
    fun tearDown() = scope.cancel()

    @Test
    fun `welcome sets state, snapshot and resets style ids`() {
        conn.styles.merge(mapOf("1" to com.inferenceaftermath.remotly.core.protocol.Style("p1")))
        conn.handle("""{"t":"welcome","protocol":1,"host":{"name":"h","flow_version":"0.1.0"},"device":{"id":"d","name":"n"},"snapshot":{"workspaces":[],"tabs":[],"panes":[{"id":"p1","tab_id":"t","workspace_id":"w","title":"x","agent":null,"display_agent":null,"agent_status":"unknown","state_label":null,"cwd":null,"focused":true}],"focused_pane_id":"p1"}}""")
        val st = assertIs<ConnectionState.Connected>(conn.state.value)
        assertEquals("h", st.welcome.host.name)
        assertEquals("p1", conn.snapshot.value!!.focused_pane_id)
        assertEquals(0, conn.styles.size)
        assertTrue(conn.isConnected)
    }

    @Test
    fun `pane status merges into snapshot and herdr state is tracked`() = runTest {
        conn.handle("""{"t":"snapshot","workspaces":[],"tabs":[],"panes":[{"id":"p1","tab_id":"t","workspace_id":"w","title":"x","agent":"claude","display_agent":"Claude","agent_status":"working","state_label":null,"cwd":null,"focused":false}],"focused_pane_id":null}""")
        conn.handle("""{"t":"pane.status","pane":"p1","agent_status":"blocked","agent":"claude","display_agent":"Claude","title":"x","state_label":"Waiting","prompt_id":"p1@9"}""")
        assertEquals("p1@9", conn.snapshot.value!!.pane("p1")!!.prompt_id)
        conn.handle("""{"t":"herdr","state":"down"}""")
        assertFalse(conn.herdrUp.value)
        conn.handle("""{"t":"herdr","state":"up"}""")
        assertTrue(conn.herdrUp.value)
    }

    @Test
    fun `frames for a pane that is not watched are ignored but styles are cached`() {
        conn.handle("""{"t":"frame","pane":"other","rev":1,"cols":4,"rows":1,"full":true,"lines":[{"y":0,"runs":[{"c":0,"w":2,"s":3,"t":"hi"}]}],"styles":{"3":{"fg":"p2","bg":"d","a":1}}}""")
        assertNull(conn.grid.value)
        assertEquals("p2", conn.styles[3].fg)
    }

    @Test
    fun `approval results are emitted`() = runTest {
        val first = async(start = CoroutineStart.UNDISPATCHED) { conn.approvals.first() }
        conn.handle("""{"t":"approval.result","pane":"p1","prompt_id":"p1@9","outcome":"stale"}""")
        assertEquals("stale", first.await().outcome)
    }

    @Test
    fun `error auth without id marks the connection unpaired`() {
        conn.handle("""{"t":"error","code":"auth","message":"invalid token"}""")
        val st = assertIs<ConnectionState.Unpaired>(conn.state.value)
        assertEquals("invalid token", st.reason)
    }

    @Test
    fun `requests fail fast when not connected`() = runTest {
        val e = runCatching { conn.watch("p1") }.exceptionOrNull()
        assertNotNull(e)
        assertEquals("disconnected", (e as com.inferenceaftermath.remotly.core.connection.FlowException).code)
        assertEquals("p1", conn.watchedPane, "the pane is remembered for the reconnect re-watch")
    }
}
