package io.layra.bridge

import android.content.Context
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors

class BridgeServer(private val context: Context, private val port: Int) {
    private var serverSocket: ServerSocket? = null
    private val executor = Executors.newCachedThreadPool()
    private val service: LayraAccessibilityService get() = context as LayraAccessibilityService

    fun start() {
        if (serverSocket != null) return
        serverSocket = ServerSocket(port, 32, InetAddress.getByName("127.0.0.1"))
        executor.execute {
            while (serverSocket != null) {
                try {
                    val socket = serverSocket?.accept() ?: break
                    executor.execute { handle(socket) }
                } catch (_: Exception) {
                    if (serverSocket != null) continue
                }
            }
        }
    }

    fun stop() {
        try { serverSocket?.close() } catch (_: Exception) {}
        serverSocket = null
        executor.shutdownNow()
    }

    private fun handle(socket: Socket) {
        socket.use { client ->
            client.soTimeout = 15000
            val reader = BufferedReader(InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8))
            val requestLine = reader.readLine() ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2) return respond(client.outputStream, 400, jsonError("Invalid request"))
            val method = parts[0]
            val path = parts[1].substringBefore('?')
            val headers = mutableMapOf<String, String>()
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isEmpty()) break
                val index = line.indexOf(':')
                if (index > 0) headers[line.substring(0, index).trim().lowercase()] = line.substring(index + 1).trim()
            }
            val contentLength = (headers["content-length"] ?: "0").toIntOrNull()?.coerceIn(0, 1_000_000) ?: 0
            val body = if (contentLength > 0) CharArray(contentLength).also { reader.read(it, 0, contentLength) }.concatToString() else ""

            if (path != "/health" && !authorized(headers)) return respond(client.outputStream, 401, jsonError("Pairing token required"))
            try {
                val result = when {
                    method == "GET" && path == "/health" -> service.health()
                    method == "GET" && path == "/tree" -> JSONObject().put("nodes", service.tree())
                    method == "GET" && path == "/screenshot" -> service.screenshot()
                    method == "POST" && path == "/tap" -> service.tap(JSONObject(body).optJSONObject("selector") ?: JSONObject())
                    method == "POST" && path == "/type" -> {
                        val value = JSONObject(body)
                        service.type(value.optJSONObject("selector") ?: JSONObject(), value.optString("text", ""))
                    }
                    method == "POST" && path == "/swipe" -> {
                        val value = JSONObject(body)
                        service.swipe(value.optDouble("startX").toFloat(), value.optDouble("startY").toFloat(), value.optDouble("endX").toFloat(), value.optDouble("endY").toFloat(), value.optLong("durationMs", 400))
                    }
                    method == "POST" && path == "/back" -> service.global("back")
                    method == "POST" && path == "/home" -> service.global("home")
                    method == "POST" && path == "/recents" -> service.global("recents")
                    method == "POST" && path == "/notifications" -> service.global("notifications")
                    method == "POST" && path == "/launch" -> {
                        val value = JSONObject(body)
                        service.launch(value.optString("packageName", ""), value.optString("activity", "").takeIf { it.isNotBlank() })
                    }
                    else -> throw HttpError(404, "Unknown endpoint")
                }
                respond(client.outputStream, 200, success(result))
            } catch (error: HttpError) {
                respond(client.outputStream, error.code, jsonError(error.message ?: "Request failed"))
            } catch (error: Throwable) {
                respond(client.outputStream, 400, jsonError(error.message ?: "Android bridge request failed"))
            }
        }
    }

    private fun authorized(headers: Map<String, String>): Boolean {
        val expected = LayraAccessibilityService.currentToken
        if (expected.isBlank()) return false
        val supplied = headers["x-layra-bridge-token"] ?: headers["authorization"]?.removePrefix("Bearer ") ?: ""
        return supplied == expected
    }

    private fun success(result: JSONObject): JSONObject = JSONObject().put("success", true).put("result", result)
    private fun jsonError(message: String): JSONObject = JSONObject().put("success", false).put("error", message)

    private fun respond(output: OutputStream, status: Int, payload: JSONObject) {
        val body = payload.toString().toByteArray(StandardCharsets.UTF_8)
        val reason = when (status) { 200 -> "OK"; 400 -> "Bad Request"; 401 -> "Unauthorized"; 404 -> "Not Found"; else -> "Error" }
        val headers = "HTTP/1.1 $status $reason\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n"
        output.write(headers.toByteArray(StandardCharsets.UTF_8))
        output.write(body)
        output.flush()
    }

    private class HttpError(val code: Int, override val message: String) : RuntimeException(message)
}
