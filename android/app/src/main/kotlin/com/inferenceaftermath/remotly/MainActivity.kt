package com.inferenceaftermath.remotly

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.lifecycleScope
import com.inferenceaftermath.remotly.push.Notifications
import com.inferenceaftermath.remotly.ui.FlowApp
import com.inferenceaftermath.remotly.ui.FlowTheme
import com.inferenceaftermath.remotly.ui.ThemeChoice
import com.inferenceaftermath.remotly.ui.Tokens
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val session get() = FlowApplication.of(this).session

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        handleIntent(intent)
        // The stored theme (DESIGN.md §1): the tokens every screen draws from, the platform theme that UI the window
        // creates later (the floating Copy / Paste toolbar) takes its light or dark look from, and status and navigation
        // bar icons that read on its background. setTheme re-applies the style over the current one, so it works after
        // onCreate too; views already made keep their colours, which Compose draws from the tokens anyway.
        lifecycleScope.launch {
            session.theme.collect { key ->
                val choice = ThemeChoice.of(key)
                Tokens.use(choice)
                setTheme(if (choice.palette.isLight) R.style.Theme_Remotly_Light else R.style.Theme_Remotly)
                val bars = if (choice.palette.isLight) SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT) else SystemBarStyle.dark(Color.TRANSPARENT)
                enableEdgeToEdge(statusBarStyle = bars, navigationBarStyle = bars)
            }
        }
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
