# Layra Android Control Companion

This module is the optional native Android control surface for the same Layra runtime. It does **not** create another agent. It exposes Android accessibility actions over a loopback HTTP bridge so the TypeScript `HybridAgent` can operate the device when the user has explicitly enabled the Android capability.

## Requirements

- Android 11 / API 30 or newer
- User-enabled Layra Accessibility Service
- Termux (or another local Layra host) running Layra

## Build

Open `android/layra-bridge` in Android Studio and build the debug APK. The project uses only Android platform APIs; there are no third-party runtime dependencies.

## First-time setup

1. Install the APK.
2. Open Layra Android Bridge.
3. Copy the bridge token shown by the app.
4. Enable **Layra Control Service** in Android Accessibility settings.
5. In the Layra/Termux environment set:

```sh
export LAYRA_ALLOW_ANDROID_CONTROL=true
export LAYRA_ANDROID_BRIDGE_URL=http://127.0.0.1:8765
export LAYRA_ANDROID_BRIDGE_TOKEN='the-token-shown-by-the-app'
```

The bridge binds only to `127.0.0.1`. Mutating endpoints require the pairing token.

## Capabilities

The bridge supports:

- accessibility tree inspection
- text/id/content-description based node selection
- tap/click
- text entry using Android accessibility actions
- coordinate swipes using accessibility gestures
- back/home global actions
- package/activity launching
- device screenshots using `AccessibilityService.takeScreenshot()`
- health/status reporting

The native service is intentionally narrow: it exposes Android control primitives, while planning, policy, verification, memory, learning and tool selection remain in Layra's single `HybridAgent` runtime.
