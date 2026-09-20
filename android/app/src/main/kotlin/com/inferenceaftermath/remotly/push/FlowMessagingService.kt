package com.inferenceaftermath.remotly.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.inferenceaftermath.remotly.FlowApplication
import com.inferenceaftermath.remotly.core.push.PushPayload

/** Never invoked unless Firebase is configured (google-services.json) and the bridge holds our token. */
class FlowMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(message: RemoteMessage) {
        val payload = PushPayload.parse(message.data) ?: return
        val session = FlowApplication.of(this).session
        when {
            payload.isApproval -> {
                // The bridge already suppresses push for the pane we report via `viewing`; this is belt and braces.
                if (session.isViewing(payload.pane) || session.isPromptStale(payload.promptId)) return
                Notifications.showApproval(this, payload)
            }
            payload.isDone -> {
                session.onDoneDelivered(payload.pane)
                if (session.isViewing(payload.pane)) return
                Notifications.showDone(this, payload)
            }
            payload.isStatus -> {
                if (!session.liveStatus.value) return
                Notifications.showStatus(this, payload)
            }
        }
    }

    // Deprecated since firebase-messaging 25.1: the Firebase installation id (`FirebaseMessaging.register()`, `onRegistered`)
    // replaces the registration token. Kept until the bridge, the relay and the protocol address a phone by installation id
    // (docs/BACKLOG.md); tokens keep working meanwhile.
    @Suppress("OVERRIDE_DEPRECATION")
    override fun onNewToken(token: String) {
        FlowApplication.of(this).session.onPushToken(token)
    }
}
