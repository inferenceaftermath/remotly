package com.inferenceaftermath.remotly.push

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.inferenceaftermath.remotly.session.Session

/** Fetches the FCM token and hands it to the session (`push.register`); a no-op without Firebase config. */
object PushRegistrar {
    fun isConfigured(context: Context): Boolean = FirebaseApp.getApps(context).isNotEmpty()

    fun registerCurrentToken(context: Context, session: Session) {
        if (!isConfigured(context)) return
        runCatching {
            // Deprecated since firebase-messaging 25.1 in favour of the installation id (see FlowMessagingService.onNewToken).
            @Suppress("DEPRECATION")
            val token = FirebaseMessaging.getInstance().token
            token.addOnSuccessListener { t -> if (!t.isNullOrEmpty()) session.onPushToken(t) }
        }
    }
}
