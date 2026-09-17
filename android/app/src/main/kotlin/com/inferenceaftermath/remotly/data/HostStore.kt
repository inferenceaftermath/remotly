// Paired host, token and settings in app-private DataStore (Preferences). EncryptedSharedPreferences is
// deprecated; app-private storage on a device with a lock screen is the documented trade-off (README).
package com.inferenceaftermath.remotly.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import com.inferenceaftermath.remotly.core.connection.HostConfig

private val Context.flowDataStore: DataStore<Preferences> by preferencesDataStore(name = "flow")

class HostStore(context: Context) {
    private val ds = context.applicationContext.flowDataStore

    val host: Flow<HostConfig?> = ds.data.map { p ->
        val url = p[URL]
        val token = p[TOKEN]
        if (url == null || token == null) null
        else HostConfig(url, token, p[FINGERPRINT], p[HOST_NAME] ?: "", p[DEVICE_ID] ?: "")
    }

    /** 0 = fit the pane width automatically; otherwise a multiplier of the 14 sp base size. */
    val fontScale: Flow<Float> = ds.data.map { it[FONT_SCALE] ?: 0f }
    /** Resize the viewed pane's PTY on the desktop to this device's grid (default on). */
    val fitToDevice: Flow<Boolean> = ds.data.map { it[FIT_TO_DEVICE] ?: true }
    /** Zoom the viewed pane on the desktop while it is open here; the split comes back when you leave (default on). */
    val zoomOnDesktop: Flow<Boolean> = ds.data.map { it[ZOOM_ON_DESKTOP] ?: true }
    val lastPane: Flow<String?> = ds.data.map { it[LAST_PANE] }
    /** Per pane id, how a vertical swipe behaves (a `ScrollMode` wire name); panes not listed use the default. */
    val scrollModes: Flow<Map<String, String>> = ds.data.map { decodeModes(it[SCROLL_MODES]) }
    val pushToken: Flow<String?> = ds.data.map { it[PUSH_TOKEN] }
    /** Arm "tell me when it's done" for every prompt sent from this phone (default on). */
    val notifyOnPrompt: Flow<Boolean> = ds.data.map { it[NOTIFY_ON_PROMPT] ?: true }
    /** Approve / reply from a notification only on an unlocked phone (default on). */
    val requireUnlock: Flow<Boolean> = ds.data.map { it[REQUIRE_UNLOCK] ?: true }
    /** Ongoing "working" notification per agent, fed by `status` pushes (default on). */
    val liveStatus: Flow<Boolean> = ds.data.map { it[LIVE_STATUS] ?: true }

    suspend fun save(host: HostConfig) {
        ds.edit { p ->
            p[URL] = host.url
            p[TOKEN] = host.token
            val fp = host.fingerprint
            if (fp != null) p[FINGERPRINT] = fp else p.remove(FINGERPRINT)
            p[HOST_NAME] = host.hostName
            p[DEVICE_ID] = host.deviceId
            p.remove(LAST_PANE)
        }
    }

    suspend fun clear() {
        ds.edit { p ->
            val keep = listOf(FONT_SCALE, FIT_TO_DEVICE, ZOOM_ON_DESKTOP, NOTIFY_ON_PROMPT, REQUIRE_UNLOCK, LIVE_STATUS).mapNotNull { k -> p[k]?.let { k to it } }
            p.clear()
            for ((k, v) in keep) @Suppress("UNCHECKED_CAST") p.set(k as Preferences.Key<Any>, v)
        }
    }

    suspend fun setNotifyOnPrompt(on: Boolean) = ds.edit { it[NOTIFY_ON_PROMPT] = on }
    suspend fun setRequireUnlock(on: Boolean) = ds.edit { it[REQUIRE_UNLOCK] = on }
    suspend fun setLiveStatus(on: Boolean) = ds.edit { it[LIVE_STATUS] = on }

    suspend fun setFontScale(scale: Float) = ds.edit { it[FONT_SCALE] = scale }
    suspend fun setFitToDevice(on: Boolean) = ds.edit { it[FIT_TO_DEVICE] = on }
    suspend fun setZoomOnDesktop(on: Boolean) = ds.edit { it[ZOOM_ON_DESKTOP] = on }

    suspend fun setLastPane(pane: String?) = ds.edit { if (pane == null) it.remove(LAST_PANE) else it[LAST_PANE] = pane }

    suspend fun setScrollMode(pane: String, mode: String) = ds.edit { p ->
        p[SCROLL_MODES] = encodeModes(decodeModes(p[SCROLL_MODES]) + (pane to mode))
    }

    // One "pane\tmode" per line; pane ids (`w3:p1`) contain neither tabs nor newlines.
    private fun decodeModes(s: String?): Map<String, String> =
        s?.lineSequence()?.mapNotNull { l -> l.split('\t').takeIf { it.size == 2 }?.let { it[0] to it[1] } }?.toMap() ?: emptyMap()

    private fun encodeModes(m: Map<String, String>) = m.entries.joinToString("\n") { "${it.key}\t${it.value}" }

    suspend fun setPushToken(token: String?) = ds.edit { if (token == null) it.remove(PUSH_TOKEN) else it[PUSH_TOKEN] = token }

    private companion object {
        val URL = stringPreferencesKey("host_url")
        val TOKEN = stringPreferencesKey("token")
        val FINGERPRINT = stringPreferencesKey("fingerprint")
        val HOST_NAME = stringPreferencesKey("host_name")
        val DEVICE_ID = stringPreferencesKey("device_id")
        val FONT_SCALE = floatPreferencesKey("font_scale")
        val FIT_TO_DEVICE = booleanPreferencesKey("fit_to_device")
        val ZOOM_ON_DESKTOP = booleanPreferencesKey("zoom_on_desktop")
        val LAST_PANE = stringPreferencesKey("last_pane")
        val SCROLL_MODES = stringPreferencesKey("scroll_modes")
        val PUSH_TOKEN = stringPreferencesKey("push_token")
        val NOTIFY_ON_PROMPT = booleanPreferencesKey("notify_on_prompt")
        val REQUIRE_UNLOCK = booleanPreferencesKey("require_unlock")
        val LIVE_STATUS = booleanPreferencesKey("live_status")
    }
}
