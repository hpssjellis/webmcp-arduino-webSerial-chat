/*
 * DeviceChat ESP32S3 Bridge
 * For: Seeed XIAO ESP32S3 (Sense) / XIAO ML Kit
 * 
 * Dependencies (install via Arduino Library Manager):
 *   - ArduinoJson  by Benoit Blanchon  (v7.x)
 *   - U8g2         by olikraus          (v2.x)
 * 
 * Communication: Newline-delimited JSON over USB Serial (115200 baud)
 * 
 * Supported commands from WebSerial bridge:
 *   {"cmd":"display", "text":"Hello!", "line":1}        — Show text on OLED
 *   {"cmd":"clear_display"}                             — Clear OLED
 *   {"cmd":"scroll_text", "text":"Long message here"}   — Scroll text across display
 *   {"cmd":"led", "r":255, "g":0, "b":0}               — (if NeoPixel fitted)
 *   {"cmd":"ping", "ts":1234567890}                     — Ping/pong test
 *   {"cmd":"get_status"}                                — Returns device status
 *   {"cmd":"set_brightness", "value":128}               — Set OLED brightness 0-255
 * 
 * Device replies (sent back to bridge as JSON):
 *   {"status":"ok", "cmd":"display", "uptime":1234}
 *   {"status":"pong", "ts":..., "latency_ms":12}
 *   {"status":"info", "uptime":..., "free_heap":..., "chip":"ESP32S3"}
 */

#include <Arduino.h>
#include <ArduinoJson.h>
#include <U8g2lib.h>

// ────────────────────────────────────────────
//  OLED Setup — XIAO ML Kit uses SSD1306 128x64 via I2C
//  Adjust constructor if your wiring differs
// ────────────────────────────────────────────
U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, /* reset=*/ U8X8_PIN_NONE);

// ────────────────────────────────────────────
//  State
// ────────────────────────────────────────────
#define SERIAL_BAUD   115200
#define JSON_BUF_SIZE 512
#define DISPLAY_LINES 5        // max text lines on OLED
#define SCROLL_DELAY_MS 60

String serialBuffer = "";
bool displayReady = false;

// Display text lines (up to DISPLAY_LINES)
struct DisplayLine {
  String text;
  bool active;
};
DisplayLine displayLines[DISPLAY_LINES];
int lineCount = 0;

// Scroll state
struct ScrollState {
  bool active;
  String text;
  int xPos;
  unsigned long lastUpdate;
} scroll;

unsigned long startTime = 0;

// ────────────────────────────────────────────
//  Setup
// ────────────────────────────────────────────
void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(500);

  startTime = millis();

  // Init OLED
  u8g2.begin();
  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_6x10_tf);
  displayReady = true;

  // Boot screen
  showBootScreen();
  delay(1200);

  // Show ready state
  clearAllLines();
  setDisplayLine(0, "DeviceChat Ready");
  setDisplayLine(1, "Waiting for");
  setDisplayLine(2, "WebSerial...");
  renderDisplay();

  // Send handshake
  sendJson("{\"status\":\"ready\",\"cmd\":\"hello\",\"device\":\"XIAO-ESP32S3\",\"chip\":\"ESP32S3\",\"oled\":\"SSD1306-128x64\"}");
}

// ────────────────────────────────────────────
//  Loop
// ────────────────────────────────────────────
void loop() {
  // Read serial (newline-delimited JSON)
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      serialBuffer.trim();
      if (serialBuffer.length() > 0) {
        processMessage(serialBuffer);
        serialBuffer = "";
      }
    } else {
      serialBuffer += c;
      if (serialBuffer.length() > 1024) serialBuffer = ""; // overflow protection
    }
  }

  // Handle scroll animation
  if (scroll.active) {
    unsigned long now = millis();
    if (now - scroll.lastUpdate >= SCROLL_DELAY_MS) {
      scroll.lastUpdate = now;
      scroll.xPos -= 2;
      // Calculate text pixel width (approx 6px per char with 6x10 font)
      int textWidth = scroll.text.length() * 6;
      if (scroll.xPos < -textWidth) scroll.xPos = 128; // wrap
      renderScrollDisplay();
    }
  }
}

// ────────────────────────────────────────────
//  Process incoming JSON
// ────────────────────────────────────────────
void processMessage(const String& raw) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, raw);

  if (err) {
    // Not valid JSON — ignore silently
    return;
  }

  // The bridge wraps commands in an envelope: { type, from, fromId, ts, payload }
  // Extract payload if present, otherwise treat root as command
  JsonObject cmdObj;
  if (doc.containsKey("payload")) {
    cmdObj = doc["payload"].as<JsonObject>();
  } else if (doc.containsKey("cmd")) {
    cmdObj = doc.as<JsonObject>();
  } else {
    return; // Unknown format
  }

  String cmd = cmdObj["cmd"] | "";
  String from = doc["from"] | "unknown";
  unsigned long ts = doc["ts"] | 0;

  // ── DISPLAY command ──────────────────────────────────────
  if (cmd == "display") {
    String text = cmdObj["text"] | "";
    int line = cmdObj["line"] | 0;
    if (line < 0 || line >= DISPLAY_LINES) line = 0;

    // Stop scroll if running
    scroll.active = false;

    // If "text" contains newlines, split across lines
    if (text.indexOf('\n') >= 0) {
      clearAllLines();
      int start = 0, lineIdx = 0;
      for (int i = 0; i <= (int)text.length() && lineIdx < DISPLAY_LINES; i++) {
        if (i == (int)text.length() || text[i] == '\n') {
          setDisplayLine(lineIdx++, text.substring(start, i));
          start = i + 1;
        }
      }
    } else {
      // Single line — insert at specified line, shift others down
      setDisplayLine(line, text);
    }
    renderDisplay();
    replyOk(cmd);
  }

  // ── CLEAR DISPLAY ────────────────────────────────────────
  else if (cmd == "clear_display" || cmd == "clear") {
    scroll.active = false;
    clearAllLines();
    renderDisplay();
    replyOk(cmd);
  }

  // ── SCROLL TEXT ──────────────────────────────────────────
  else if (cmd == "scroll_text") {
    String text = cmdObj["text"] | "";
    clearAllLines();
    scroll.active = true;
    scroll.text = text;
    scroll.xPos = 128;
    scroll.lastUpdate = millis();
    replyOk(cmd);
  }

  // ── PING ─────────────────────────────────────────────────
  else if (cmd == "ping") {
    unsigned long now = millis();
    unsigned long latency = (ts > 0) ? (now - (ts % 1000000)) : 0; // rough estimate

    JsonDocument reply;
    reply["status"] = "pong";
    reply["cmd"] = "ping";
    reply["ts"] = ts;
    reply["uptime"] = (now - startTime) / 1000;
    reply["free_heap"] = ESP.getFreeHeap();

    String out;
    serializeJson(reply, out);
    sendJson(out);

    // Flash on display
    setDisplayLine(0, "PONG from: " + from);
    setDisplayLine(1, "Heap: " + String(ESP.getFreeHeap()));
    renderDisplay();
  }

  // ── GET STATUS ───────────────────────────────────────────
  else if (cmd == "get_status") {
    unsigned long uptime = (millis() - startTime) / 1000;
    JsonDocument reply;
    reply["status"] = "info";
    reply["device"] = "XIAO-ESP32S3";
    reply["chip"] = ESP.getChipModel();
    reply["uptime"] = uptime;
    reply["free_heap"] = ESP.getFreeHeap();
    reply["cpu_freq_mhz"] = ESP.getCpuFreqMHz();
    reply["flash_size"] = ESP.getFlashChipSize();
    reply["sdk"] = ESP.getSdkVersion();

    String out;
    serializeJson(reply, out);
    sendJson(out);

    // Display status
    scroll.active = false;
    clearAllLines();
    setDisplayLine(0, "STATUS");
    setDisplayLine(1, "Up: " + String(uptime) + "s");
    setDisplayLine(2, "Heap: " + String(ESP.getFreeHeap()));
    setDisplayLine(3, "CPU: " + String(ESP.getCpuFreqMHz()) + "MHz");
    renderDisplay();
  }

  // ── SET BRIGHTNESS ───────────────────────────────────────
  else if (cmd == "set_brightness") {
    int val = cmdObj["value"] | 128;
    val = constrain(val, 0, 255);
    u8g2.setContrast(val);
    replyOk(cmd);
  }

  // ── SHOW JSON (display raw payload) ─────────────────────
  else if (cmd == "show_json") {
    scroll.active = false;
    clearAllLines();
    String raw2;
    serializeJson(cmdObj, raw2);
    // Split into 20-char chunks across display lines
    for (int i = 0; i < DISPLAY_LINES && (i * 20) < (int)raw2.length(); i++) {
      setDisplayLine(i, raw2.substring(i * 20, min((int)raw2.length(), (i + 1) * 20)));
    }
    renderDisplay();
    replyOk(cmd);
  }

  // ── UNKNOWN ──────────────────────────────────────────────
  else if (cmd.length() > 0) {
    // Show unknown command on display
    setDisplayLine(0, "CMD: " + cmd);
    setDisplayLine(1, "From: " + from);
    renderDisplay();

    JsonDocument reply;
    reply["status"] = "unknown_cmd";
    reply["cmd"] = cmd;
    String out;
    serializeJson(reply, out);
    sendJson(out);
  }
}

// ────────────────────────────────────────────
//  Display helpers
// ────────────────────────────────────────────
void setDisplayLine(int idx, const String& text) {
  if (idx < 0 || idx >= DISPLAY_LINES) return;
  displayLines[idx].text = text;
  displayLines[idx].active = true;
  if (idx >= lineCount) lineCount = idx + 1;
}

void clearAllLines() {
  lineCount = 0;
  for (int i = 0; i < DISPLAY_LINES; i++) {
    displayLines[i].text = "";
    displayLines[i].active = false;
  }
}

void renderDisplay() {
  if (!displayReady) return;
  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_6x10_tf);

  // Header bar
  u8g2.drawBox(0, 0, 128, 12);
  u8g2.setDrawColor(0);
  u8g2.setCursor(2, 10);
  u8g2.print("DeviceChat");
  u8g2.setDrawColor(1);
  // Uptime in header
  unsigned long upSec = (millis() - startTime) / 1000;
  String upStr = String(upSec) + "s";
  u8g2.setCursor(128 - (upStr.length() * 6) - 2, 10);
  u8g2.print(upStr);

  // Divider
  u8g2.drawHLine(0, 13, 128);

  // Text lines (starting at y=24, 10px apart)
  for (int i = 0; i < lineCount && i < DISPLAY_LINES; i++) {
    if (displayLines[i].active && displayLines[i].text.length() > 0) {
      u8g2.setCursor(2, 24 + (i * 10));
      // Truncate to 21 chars to fit 128px width
      String t = displayLines[i].text;
      if (t.length() > 21) t = t.substring(0, 20) + ">";
      u8g2.print(t);
    }
  }

  u8g2.sendBuffer();
}

void renderScrollDisplay() {
  if (!displayReady) return;
  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_6x10_tf);

  // Header
  u8g2.drawBox(0, 0, 128, 12);
  u8g2.setDrawColor(0);
  u8g2.setCursor(2, 10);
  u8g2.print("DeviceChat");
  u8g2.setDrawColor(1);
  u8g2.drawHLine(0, 13, 128);

  // Scrolling text at y=38 (vertically centered)
  u8g2.setFont(u8g2_font_8x13_tf);
  u8g2.setCursor(scroll.xPos, 42);
  u8g2.print(scroll.text);

  u8g2.sendBuffer();
}

void showBootScreen() {
  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_7x13B_tf);
  u8g2.setCursor(10, 22);
  u8g2.print("DeviceChat");
  u8g2.setFont(u8g2_font_6x10_tf);
  u8g2.setCursor(16, 36);
  u8g2.print("ESP32S3 Bridge");
  u8g2.drawRFrame(4, 4, 120, 44, 4);
  u8g2.setCursor(2, 56);
  u8g2.print("WebSerial Ready");
  u8g2.sendBuffer();
}

// ────────────────────────────────────────────
//  Serial output helpers
// ────────────────────────────────────────────
void sendJson(const String& json) {
  Serial.println(json);
}

void replyOk(const String& cmd) {
  JsonDocument reply;
  reply["status"] = "ok";
  reply["cmd"] = cmd;
  reply["uptime"] = (millis() - startTime) / 1000;
  String out;
  serializeJson(reply, out);
  sendJson(out);
}
