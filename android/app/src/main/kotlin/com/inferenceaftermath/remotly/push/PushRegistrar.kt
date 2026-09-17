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
            FirebaseMessaging.getInstance().token.addOnSuccessListener { token -> if (!token.isNullOrEmpty()) session.onPushToken(token) }
        }
    }
}
