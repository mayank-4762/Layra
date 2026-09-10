package io.layra.bridge

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import java.security.SecureRandom

class MainActivity : android.app.Activity() {
    private lateinit var tokenView: TextView
    private val prefs by lazy { getSharedPreferences("layra", Context.MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(40, 50, 40, 40)
        }
        val title = TextView(this).apply {
            text = "Layra Android Bridge"
            textSize = 26f
            setTextColor(Color.BLACK)
            gravity = Gravity.CENTER
        }
        val info = TextView(this).apply {
            text = "Enable the accessibility service, then configure this token in the Layra Termux environment. The bridge listens only on localhost."
            textSize = 16f
            setPadding(0, 30, 0, 20)
        }
        tokenView = TextView(this).apply {
            textSize = 14f
            setTextIsSelectable(true)
            setBackgroundColor(0xFFEFEFEF.toInt())
            setPadding(20, 20, 20, 20)
        }
        val accessibility = Button(this).apply {
            text = "Open Accessibility Settings"
            setOnClickListener { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        }
        val regenerate = Button(this).apply {
            text = "Regenerate Pairing Token"
            setOnClickListener { generateToken(); updateUi() }
        }
        val status = TextView(this).apply { id = 1001; textSize = 15f; setPadding(0, 20, 0, 0) }
        val match = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        val button = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = 20 }

        root.addView(title, match)
        root.addView(info, match)
        root.addView(tokenView, match)
        root.addView(accessibility, button)
        root.addView(regenerate, match)
        root.addView(status, match)
        setContentView(root)
        if (prefs.getString("token", null).isNullOrBlank()) generateToken()
        updateUi()
    }

    override fun onResume() {
        super.onResume()
        if (::tokenView.isInitialized) updateUi()
    }

    private fun generateToken() {
        val bytes = ByteArray(24)
        SecureRandom().nextBytes(bytes)
        val token = bytes.joinToString("") { "%02x".format(it) }
        prefs.edit().putString("token", token).apply()
        LayraAccessibilityService.currentToken = token
    }

    private fun updateUi() {
        val token = prefs.getString("token", "") ?: ""
        LayraAccessibilityService.currentToken = token
        tokenView.text = "Pairing token:\n$token"
        val manager = getSystemService(Context.ACCESSIBILITY_SERVICE) as android.view.accessibility.AccessibilityManager
        val enabled = manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK).any {
            it.resolveInfo.serviceInfo.packageName == packageName && it.resolveInfo.serviceInfo.name == LayraAccessibilityService::class.java.name
        }
        val statusView = findViewById<TextView>(1001)
        statusView.text = if (enabled) "Status: Accessibility service enabled\nBridge: 127.0.0.1:8765" else "Status: Accessibility service disabled"
    }
}
