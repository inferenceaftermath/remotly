package com.inferenceaftermath.remotly

import android.app.Application
import com.inferenceaftermath.remotly.data.HostStore
import com.inferenceaftermath.remotly.push.Notifications
import com.inferenceaftermath.remotly.session.Session

class FlowApplication : Application() {
    lateinit var store: HostStore
        private set
    lateinit var session: Session
        private set

    override fun onCreate() {
        super.onCreate()
        store = HostStore(this)
        session = Session(this, store)
        Notifications.ensureChannels(this)
    }

    companion object {
        fun of(context: android.content.Context): FlowApplication = context.applicationContext as FlowApplication
    }
}
