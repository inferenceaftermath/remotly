package com.inferenceaftermath.remotly

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.inferenceaftermath.remotly.push.Notifications
import com.inferenceaftermath.remotly.ui.FlowApp
import com.inferenceaftermath.remotly.ui.FlowTheme

class MainActivity : ComponentActivity() {
    private val session get() = FlowApplication.of(this).session

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        handleIntent(intent)
        setContent {
            FlowTheme {
                FlowApp(session)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    /** Notification tap deep-links to a pane. */
    private fun handleIntent(intent: Intent?) {
        intent?.getStringExtra(Notifications.EXTRA_PANE)?.let { pane ->
            session.requestPane(pane)
            intent.removeExtra(Notifications.EXTRA_PANE)
        }
    }

    override fun onStart() {
        super.onStart()
        session.setActive(true)
    }

    override fun onStop() {
        session.setActive(false)
        super.onStop()
    }
}
