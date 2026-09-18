package com.inferenceaftermath.remotly.core.connection

/** Shared by real-host connections for one app mode. Cancellation is permanent: a later mode gets a new lifetime. */
class ConnectionLifetime {
    private val lock = Any()
    private var active = true
    private val handlers = mutableMapOf<Any, () -> Unit>()

    val isActive: Boolean get() = synchronized(lock) { active }

    /** Serializes handing bytes to the transport with cancellation; never suspend inside [block]. */
    internal fun whileActive(block: () -> Unit): Boolean = synchronized(lock) {
        if (!active) false else { block(); true }
    }

    internal fun onCancel(key: Any, block: () -> Unit) {
        val cancelled = synchronized(lock) {
            if (active) handlers[key] = block
            !active
        }
        if (cancelled) block()
    }

    internal fun remove(key: Any) { synchronized(lock) { handlers.remove(key) } }

    fun cancel() {
        val callbacks = synchronized(lock) {
            if (!active) return
            active = false
            handlers.values.toList().also { handlers.clear() }
        }
        // Stop callbacks take each connection's lock; never call them while holding this lock.
        callbacks.forEach { it() }
    }
}
