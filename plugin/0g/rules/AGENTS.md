# 0G Mobile Phone Tools (`0g_mobile` MCP Server)

You have access to the `0g_mobile` MCP server, which bridges your agent session directly to the user's paired phone PWA in real time. Every turn's `tools/list` queries the live 0G daemon (`http://127.0.0.1:8790/api/mobile-tools`), so any custom tool authored by the user on their phone is immediately available to call without restarting the session.

## Built-in Phone Tools

- `phone_notify_card`: Render a rich notification card and optional chime on the paired phone (`title`, `body`, `level`: `info` | `success` | `warning` | `urgent`, `chime`). Use this when a long task finishes, hits an important milestone, or needs user awareness while the laptop is in a backpack.
- `phone_ask_input`: Prompt the user on their phone for a short text reply or quick button choice (`prompt`, `choices`, `placeholder`, `default`) and await their response (up to 20s timeout).
- `phone_read_clipboard`: Request the current clipboard text from the paired phone PWA (`reason`).
- `phone_capture_photo`: Request a camera snapshot or file upload from the user's phone (`prompt`, `accept`, `cameraFacing`).
- `phone_get_location`: Request the phone's current browser Geolocation coordinates (`reason`, `highAccuracy`).
- `phone_speak_tts`: Speak a short status message aloud on the phone via Web Speech API (`text`, `rate`, `pitch`).

## User-Authored Phone Tools

- Users can create custom tools directly inside the 0G Phone PWA (**Tools** tab -> Mobile Tool Authoring Studio) backed by either `phone_js` (executed in the phone PWA) or `host_command` (evaluated by `RulesEngine` before execution on Windows).
- Treat user-authored phone tools as first-class capabilities alongside the built-in `phone_*` tools.
- Never attempt to bypass `RulesEngine` Tier-3 protections or ask `phone_*` tools to transmit secrets (API keys, `.env` values, `bridge.token`).
