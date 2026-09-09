package io.layra.bridge

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

class LayraAccessibilityService : AccessibilityService() {
    private val executor = Executors.newCachedThreadPool()
    private var server: BridgeServer? = null
    private var latestRoot: AccessibilityNodeInfo? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        currentToken = getSharedPreferences("layra", MODE_PRIVATE).getString("token", "") ?: ""
        server = BridgeServer(this, 8765).also { it.start() }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        event?.source?.let { latestRoot = it }
    }

    override fun onInterrupt() = Unit

    override fun onDestroy() {
        server?.stop()
        server = null
        latestRoot = null
        executor.shutdownNow()
        super.onDestroy()
    }

    fun health(): JSONObject = JSONObject().apply {
        put("service", "LayraAccessibilityService")
        put("enabled", true)
        put("package", packageName)
        put("bridgePort", 8765)
        put("apiLevel", android.os.Build.VERSION.SDK_INT)
    }

    fun tree(): JSONArray {
        val root = rootInActiveWindow ?: latestRoot
        return JSONArray().also { if (root != null) appendNode(root, it, 0, 2500) }
    }

    private fun appendNode(node: AccessibilityNodeInfo, output: JSONArray, depth: Int, budget: Int): Int {
        if (depth > 20 || output.length() >= budget) return 0
        val bounds = Rect(); node.getBoundsInScreen(bounds)
        val obj = JSONObject().apply {
            put("className", node.className?.toString() ?: "")
            put("text", node.text?.toString() ?: "")
            put("contentDescription", node.contentDescription?.toString() ?: "")
            put("viewId", node.viewIdResourceName ?: "")
            put("clickable", node.isClickable)
            put("editable", node.isEditable)
            put("enabled", node.isEnabled)
            put("focused", node.isFocused)
            put("visible", node.isVisibleToUser)
            put("bounds", JSONObject().apply { put("left", bounds.left); put("top", bounds.top); put("right", bounds.right); put("bottom", bounds.bottom) })
        }
        output.put(obj)
        var used = 1
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            used += appendNode(child, output, depth + 1, budget - used)
            child.recycle()
            if (output.length() >= budget) break
        }
        return used
    }

    fun tap(selector: JSONObject): JSONObject {
        val node = findNode(selector) ?: throw IllegalArgumentException("Android UI node not found")
        if (node.isClickable && node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return JSONObject().put("clicked", true)
        val bounds = Rect(); node.getBoundsInScreen(bounds)
        if (bounds.isEmpty) throw IllegalStateException("Matched Android UI node has no screen bounds")
        val path = Path().apply { moveTo(bounds.centerX().toFloat(), bounds.centerY().toFloat()) }
        val gesture = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, 80)).build()
        var completed = false
        val latch = java.util.concurrent.CountDownLatch(1)
        dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) { completed = true; latch.countDown() }
            override fun onCancelled(gestureDescription: GestureDescription?) { latch.countDown() }
        }, null)
        latch.await(2, java.util.concurrent.TimeUnit.SECONDS)
        return JSONObject().put("clicked", completed).put("x", bounds.centerX()).put("y", bounds.centerY())
    }

    fun type(selector: JSONObject, text: String): JSONObject {
        val node = findNode(selector) ?: throw IllegalArgumentException("Android editable node not found")
        if (!node.isEditable && node.className?.toString() !in setOf("android.widget.EditText", "android.widget.AutoCompleteTextView")) throw IllegalArgumentException("Matched node is not editable")
        val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text.take(10000)) }
        if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) throw IllegalStateException("Android rejected text input")
        return JSONObject().put("typed", true)
    }

    fun swipe(startX: Float, startY: Float, endX: Float, endY: Float, durationMs: Long): JSONObject {
        val path = Path().apply { moveTo(startX, startY); lineTo(endX, endY) }
        val gesture = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, durationMs.coerceIn(50, 10000))).build()
        val latch = java.util.concurrent.CountDownLatch(1)
        var completed = false
        dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) { completed = true; latch.countDown() }
            override fun onCancelled(gestureDescription: GestureDescription?) { latch.countDown() }
        }, null)
        latch.await(12, java.util.concurrent.TimeUnit.SECONDS)
        return JSONObject().put("swiped", completed)
    }

    fun screenshot(timeoutMs: Long = 5000): JSONObject {
        if (android.os.Build.VERSION.SDK_INT < 30) throw UnsupportedOperationException("Android screenshots require API 30+")
        val latch = java.util.concurrent.CountDownLatch(1)
        var result: JSONObject? = null
        var failure: Throwable? = null
        takeScreenshot(android.view.Display.DEFAULT_DISPLAY, executor, object : TakeScreenshotCallback {
            override fun onSuccess(screenshot: ScreenshotResult) {
                try {
                    val bitmap = android.graphics.Bitmap.wrapHardwareBuffer(screenshot.hardwareBuffer, screenshot.colorSpace)
                    if (bitmap == null) throw IllegalStateException("Unable to map screenshot buffer")
                    val cropped = bitmap.copy(android.graphics.Bitmap.Config.ARGB_8888, false)
                    bitmap.recycle()
                    screenshot.hardwareBuffer.close()
                    val bytes = ByteArrayOutputStream().use { out -> cropped.compress(android.graphics.Bitmap.CompressFormat.JPEG, 80, out); out.toByteArray() }
                    cropped.recycle()
                    result = JSONObject().apply { put("format", "jpeg"); put("dataBase64", Base64.encodeToString(bytes, Base64.NO_WRAP)); put("bytes", bytes.size) }
                } catch (error: Throwable) { failure = error }
                latch.countDown()
            }
            override fun onFailure(errorCode: Int) { failure = IllegalStateException("Android screenshot failed with code $errorCode"); latch.countDown() }
        })
        if (!latch.await(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)) throw IllegalStateException("Android screenshot timed out")
        failure?.let { throw it }
        return result ?: throw IllegalStateException("Android screenshot returned no result")
    }

    fun launch(packageName: String, activity: String?): JSONObject {
        val intent = if (activity.isNullOrBlank()) packageManager.getLaunchIntentForPackage(packageName) else android.content.Intent().apply {
            component = android.content.ComponentName(packageName, if (activity.startsWith(".")) packageName + activity else activity)
            addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        if (intent == null) throw IllegalArgumentException("No launchable activity for package $packageName")
        startActivity(intent)
        return JSONObject().put("launched", true).put("packageName", packageName)
    }

    fun global(action: String): JSONObject {
        val code = when (action) {
            "back" -> GLOBAL_ACTION_BACK
            "home" -> GLOBAL_ACTION_HOME
            "recents" -> GLOBAL_ACTION_RECENTS
            "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
            else -> throw IllegalArgumentException("Unsupported global action: $action")
        }
        if (!performGlobalAction(code)) throw IllegalStateException("Android rejected global action: $action")
        return JSONObject().put("action", action).put("success", true)
    }

    private fun findNode(selector: JSONObject): AccessibilityNodeInfo? {
        val root = rootInActiveWindow ?: latestRoot ?: return null
        val byText = selector.optString("text", "").takeIf { it.isNotBlank() }
        val byDesc = selector.optString("contentDescription", "").takeIf { it.isNotBlank() }
        val byId = selector.optString("viewId", "").takeIf { it.isNotBlank() }
        val byClass = selector.optString("className", "").takeIf { it.isNotBlank() }
        fun matches(node: AccessibilityNodeInfo): Boolean {
            if (byText != null && node.text?.toString() != byText) return false
            if (byDesc != null && node.contentDescription?.toString() != byDesc) return false
            if (byId != null && node.viewIdResourceName != byId) return false
            if (byClass != null && node.className?.toString() != byClass) return false
            return true
        }
        fun walk(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
            if (matches(node)) return AccessibilityNodeInfo.obtain(node)
            for (i in 0 until node.childCount) {
                val child = node.getChild(i) ?: continue
                val found = walk(child)
                child.recycle()
                if (found != null) return found
            }
            return null
        }
        return walk(root)
    }

    companion object {
        @Volatile var currentToken: String = ""
    }
}
