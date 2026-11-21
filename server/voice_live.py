"""Gemini 3.8 Live API real-time bidirectional voice bridge for Zero-G Antigravity Remote Control."""

from __future__ import annotations

import asyncio
import base64
import os
import time
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

try:
    from google import genai
    from google.genai import types

    _HAS_GOOGLE_GENAI = True
except Exception:
    genai = None  # type: ignore[assignment]
    types = None  # type: ignore[assignment]
    _HAS_GOOGLE_GENAI = False

DEFAULT_LIVE_MODEL = "gemini-3.8-live"
SAMPLE_RATE_IN = 16000
SAMPLE_RATE_OUT = 24000


def _get_api_key() -> str:
    """Resolve GEMINI_API_KEY or GOOGLE_API_KEY from environment without exposing it."""
    return (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or "").strip()


def _get_live_model() -> str:
    """Resolve the Gemini Live model ID (defaults strictly to gemini-3.8-live)."""
    return (os.environ.get("ZEROG_LIVE_MODEL") or DEFAULT_LIVE_MODEL).strip() or DEFAULT_LIVE_MODEL


def get_voice_capabilities() -> dict[str, Any]:
    """Return voice capabilities metadata without exposing any API keys."""
    has_key = bool(_get_api_key())
    has_pkg = bool(_HAS_GOOGLE_GENAI and genai is not None and types is not None)
    return {
        "geminiLiveAvailable": bool(has_key and has_pkg),
        "model": _get_live_model(),
        "sampleRateIn": SAMPLE_RATE_IN,
        "sampleRateOut": SAMPLE_RATE_OUT,
        "fallback": "web_speech",
    }


def _build_live_connect_config(voice_name: str = "Puck") -> Any:
    """Build LiveConnectConfig for gemini-3.8-live.

    CRITICAL: Never pass thinking_config / thinking_level, proactivity, or
    enable_affective_dialog to gemini-3.8-live.
    """
    if types is None:
        return None

    fn_declarations = [
        types.FunctionDeclaration(
            name="send_prompt_to_antigravity",
            description=(
                "Send a coding prompt, instruction, or follow-up message to the active "
                "Antigravity IDE agent conversation on the laptop."
            ),
            parameters_json_schema={
                "type": "object",
                "properties": {
                    "message": {
                        "type": "string",
                        "description": "The instruction or message to send to Antigravity.",
                    }
                },
                "required": ["message"],
            },
            behavior="NON_BLOCKING",
        ),
        types.FunctionDeclaration(
            name="get_latest_agent_progress",
            description=(
                "Fetch the latest status, recent messages, and pending permission approval "
                "count for the active Antigravity conversation."
            ),
            parameters_json_schema={
                "type": "object",
                "properties": {},
            },
            behavior="NON_BLOCKING",
        ),
        types.FunctionDeclaration(
            name="respond_to_permission",
            description=(
                "Approve or deny the oldest pending tool permission request waiting on the phone "
                "(pass 'approve' or 'deny')."
            ),
            parameters_json_schema={
                "type": "object",
                "properties": {
                    "decision": {
                        "type": "string",
                        "description": "Decision for the pending permission request: 'approve' or 'deny'.",
                        "enum": ["approve", "deny", "allow"],
                    }
                },
                "required": ["decision"],
            },
            behavior="NON_BLOCKING",
        ),
    ]

    system_instruction = (
        "You are Zero-G Voice, the real-time spoken interface for the user's Antigravity Desktop IDE. "
        "Keep spoken replies concise, natural, and direct. Use send_prompt_to_antigravity whenever the "
        "user dictates a task or coding instruction for the agent, get_latest_agent_progress when they "
        "ask what the agent is doing, and respond_to_permission when they say approve/allow or deny/reject "
        "a pending tool approval."
    )

    return types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice_name or "Puck")
            )
        ),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        system_instruction=system_instruction,
        tools=[types.Tool(function_declarations=fn_declarations)],
    )


class VoiceLiveBridge:
    """Bridges browser WebSocket audio/commands to Gemini 3.8 Live API or Web Speech fallback."""

    async def handle_voice_websocket(
        self,
        websocket: WebSocket,
        state: Any,
        conversation_id: str | None = None,
        voice_name: str = "Puck",
    ) -> None:
        """Accept and manage a /ws/voice bidirectional voice session."""
        if getattr(websocket, "application_state", None) != WebSocketState.CONNECTED:
            try:
                await websocket.accept()
            except RuntimeError:
                pass

        active_conv_id: str | None = (conversation_id or "").strip() or None

        async def _send_ws(payload: dict[str, Any]) -> None:
            try:
                await websocket.send_json(payload)
            except Exception:
                pass

        async def send_prompt_to_antigravity(message: str) -> dict[str, Any]:
            nonlocal active_conv_id
            if getattr(state, "host_locked", False):
                return {"ok": False, "error": "Host is PANIC locked"}
            clean_msg = (message or "").strip()
            if not clean_msg:
                return {"ok": False, "error": "Message is required"}

            try:
                if active_conv_id:
                    res = await state.agy_bridge.send_conversation_message(
                        active_conv_id,
                        clean_msg,
                        db=getattr(state, "db", None),
                    )
                else:
                    res = await state.agy_bridge.start_new_conversation(
                        prompt=clean_msg,
                        db=getattr(state, "db", None),
                    )
                    new_cid = str(res.get("conversationId") or "").strip()
                    if new_cid:
                        active_conv_id = new_cid
                        await _send_ws(
                            {
                                "type": "voice.conversation_bound",
                                "conversationId": active_conv_id,
                            }
                        )
                return {
                    "ok": bool(res.get("ok", True)),
                    "conversationId": active_conv_id,
                    "deliveredVia": res.get("deliveredVia", "agentapi"),
                }
            except Exception as exc:
                return {"ok": False, "error": str(exc)}

        async def get_latest_agent_progress() -> dict[str, Any]:
            db = getattr(state, "db", None)
            pending_list = db.list_approvals(status="pending") if db is not None else []
            pending_summaries = [
                {
                    "id": a.id,
                    "toolName": a.toolName,
                    "commandPreview": a.commandPreview,
                    "riskTier": a.riskTier,
                }
                for a in pending_list[:5]
            ]

            if not active_conv_id:
                return {
                    "ok": True,
                    "conversationId": None,
                    "status": "unbound",
                    "pendingApprovals": len(pending_list),
                    "pendingApprovalItems": pending_summaries,
                    "latestMessages": [],
                }

            status_str = "idle"
            latest_messages: list[dict[str, Any]] = []
            try:
                detail = state.agy_bridge.get_conversation_detail(active_conv_id, limit=6)
                conv_info = detail.get("conversation") or {}
                status_str = str(conv_info.get("status") or "idle")
                for m in (detail.get("messages") or [])[-6:]:
                    latest_messages.append(
                        {
                            "role": m.get("role", "assistant"),
                            "content": str(m.get("content") or "")[:360],
                        }
                    )
            except FileNotFoundError:
                if db is not None:
                    sess = db.get_session(active_conv_id)
                    if sess is not None:
                        status_str = sess.status
                    steps = db.get_timeline(active_conv_id, limit=6)
                    for st in steps[-6:]:
                        latest_messages.append(
                            {
                                "role": st.role,
                                "content": str(st.content or "")[:360],
                            }
                        )
            except Exception as exc:
                return {
                    "ok": False,
                    "conversationId": active_conv_id,
                    "status": "error",
                    "pendingApprovals": len(pending_list),
                    "latestMessages": [],
                    "error": str(exc),
                }

            return {
                "ok": True,
                "conversationId": active_conv_id,
                "status": status_str,
                "pendingApprovals": len(pending_list),
                "pendingApprovalItems": pending_summaries,
                "latestMessages": latest_messages,
            }

        async def respond_to_permission(decision: str) -> dict[str, Any]:
            if getattr(state, "host_locked", False):
                return {"ok": False, "error": "Host is PANIC locked"}

            raw = (decision or "").strip().lower()
            if raw in ("allow", "approve", "approved", "yes", "ok", "proceed"):
                mapped = "approved"
            elif raw in ("deny", "denied", "reject", "no", "block", "cancel"):
                mapped = "denied"
            else:
                return {
                    "ok": False,
                    "error": f"Unrecognized decision '{decision}'. Expected 'approve' or 'deny'.",
                }

            db = getattr(state, "db", None)
            if db is None:
                return {"ok": False, "error": "Database unavailable"}

            pending = db.list_approvals(status="pending")
            if not pending:
                return {
                    "ok": False,
                    "error": "No pending permission requests found",
                    "pendingApprovals": 0,
                }

            pending.sort(key=lambda a: float(getattr(a, "createdAt", 0.0)))
            appr = pending[0]
            appr.status = mapped  # type: ignore[assignment]
            appr.resolvedAt = time.time()
            appr.resolvedBy = "voice_live"
            db.upsert_approval(appr)
            db.emit_event(
                "approval.resolved",
                appr.model_dump(),
                session_id=appr.sessionId,
                provider=appr.provider,
            )
            db.append_audit(
                actor="voice_live",
                action=f"approval_{mapped}",
                details={"approvalId": appr.id, "decision": mapped},
            )

            events_map = getattr(state, "pending_approval_events", None)
            if isinstance(events_map, dict):
                ev = events_map.get(appr.id)
                if ev is not None:
                    ev.set()

            await _send_ws(
                {
                    "type": "voice.permission_decided",
                    "approvalId": appr.id,
                    "decision": mapped,
                    "status": mapped,
                }
            )
            return {
                "ok": True,
                "approvalId": appr.id,
                "decision": mapped,
                "status": mapped,
                "toolName": appr.toolName,
            }

        async def _run_fallback_loop(reason: str) -> None:
            nonlocal active_conv_id
            await _send_ws(
                {
                    "type": "voice.mode",
                    "mode": "fallback_web_speech",
                    "reason": reason,
                    "conversationId": active_conv_id,
                }
            )
            try:
                while True:
                    msg = await websocket.receive_json()
                    if not isinstance(msg, dict):
                        continue
                    mtype = str(msg.get("type") or "").strip()

                    if mtype == "bind_conversation":
                        active_conv_id = str(msg.get("conversationId") or "").strip() or None
                        await _send_ws(
                            {
                                "type": "voice.conversation_bound",
                                "conversationId": active_conv_id,
                            }
                        )
                    elif mtype == "decide_permission":
                        dec = str(msg.get("decision") or "").strip()
                        res = await respond_to_permission(dec)
                        await _send_ws(
                            {
                                "type": "voice.tool_result",
                                "tool": "respond_to_permission",
                                "result": res,
                            }
                        )
                    elif mtype in ("get_progress", "status"):
                        res = await get_latest_agent_progress()
                        await _send_ws(
                            {
                                "type": "voice.tool_result",
                                "tool": "get_latest_agent_progress",
                                "result": res,
                            }
                        )
                    elif mtype in ("text_command", "text"):
                        text_val = str(msg.get("text") or msg.get("message") or "").strip()
                        if not text_val:
                            continue
                        await _send_ws(
                            {
                                "type": "voice.transcript",
                                "role": "user",
                                "text": text_val,
                                "final": True,
                            }
                        )
                        res = await send_prompt_to_antigravity(text_val)
                        await _send_ws(
                            {
                                "type": "voice.tool_result",
                                "tool": "send_prompt_to_antigravity",
                                "result": res,
                            }
                        )
                        reply_text = (
                            f"Sent instruction to Antigravity ({res.get('conversationId')})."
                            if res.get("ok")
                            else f"Unable to send instruction: {res.get('error')}"
                        )
                        await _send_ws(
                            {
                                "type": "voice.assistant_text",
                                "text": reply_text,
                            }
                        )
                    elif mtype == "ping":
                        await _send_ws({"type": "voice.pong", "ts": time.time()})
            except WebSocketDisconnect:
                return
            except Exception:
                return

        caps = get_voice_capabilities()
        if not caps["geminiLiveAvailable"]:
            await _run_fallback_loop(
                "GEMINI_API_KEY or google-genai not configured; using Web Speech fallback."
            )
            return

        api_key = _get_api_key()
        model_id = caps["model"]
        config = _build_live_connect_config(voice_name=voice_name)

        try:
            client = genai.Client(api_key=api_key)
            async with client.aio.live.connect(model=model_id, config=config) as session:
                await _send_ws(
                    {
                        "type": "voice.ready",
                        "mode": "gemini_live",
                        "model": model_id,
                        "conversationId": active_conv_id,
                    }
                )

                async def _client_to_gemini() -> None:
                    nonlocal active_conv_id
                    while True:
                        msg = await websocket.receive_json()
                        if not isinstance(msg, dict):
                            continue
                        mtype = str(msg.get("type") or "").strip()

                        if mtype == "audio":
                            b64_data = str(msg.get("data") or "").strip()
                            if not b64_data:
                                continue
                            pcm_bytes = base64.b64decode(b64_data)
                            await session.send_realtime_input(
                                audio=types.Blob(
                                    data=pcm_bytes,
                                    mime_type=f"audio/pcm;rate={SAMPLE_RATE_IN}",
                                )
                            )
                        elif mtype == "audio_stream_end":
                            await session.send_realtime_input(audio_stream_end=True)
                        elif mtype in ("text", "text_command"):
                            text_val = str(msg.get("text") or msg.get("message") or "").strip()
                            if text_val:
                                await session.send_realtime_input(text=text_val)
                        elif mtype == "decide_permission":
                            dec = str(msg.get("decision") or "").strip()
                            res = await respond_to_permission(dec)
                            await _send_ws(
                                {
                                    "type": "voice.tool_result",
                                    "tool": "respond_to_permission",
                                    "result": res,
                                }
                            )
                        elif mtype == "bind_conversation":
                            active_conv_id = str(msg.get("conversationId") or "").strip() or None
                            await _send_ws(
                                {
                                    "type": "voice.conversation_bound",
                                    "conversationId": active_conv_id,
                                }
                            )
                        elif mtype == "ping":
                            await _send_ws({"type": "voice.pong", "ts": time.time()})

                async def _gemini_to_client() -> None:
                    while True:
                        received_any = False
                        async for response in session.receive():
                            received_any = True
                            sc = getattr(response, "server_content", None)
                            if sc is not None:
                                if getattr(sc, "interrupted", False):
                                    await _send_ws({"type": "voice.interrupted"})

                                in_tr = getattr(sc, "input_transcription", None)
                                if in_tr is not None and getattr(in_tr, "text", None):
                                    await _send_ws(
                                        {
                                            "type": "voice.transcript",
                                            "role": "user",
                                            "text": str(in_tr.text),
                                            "final": bool(getattr(in_tr, "finished", False)),
                                        }
                                    )

                                out_tr = getattr(sc, "output_transcription", None)
                                if out_tr is not None and getattr(out_tr, "text", None):
                                    await _send_ws(
                                        {
                                            "type": "voice.transcript",
                                            "role": "assistant",
                                            "text": str(out_tr.text),
                                            "final": bool(getattr(out_tr, "finished", False)),
                                        }
                                    )

                                model_turn = getattr(sc, "model_turn", None)
                                parts = getattr(model_turn, "parts", None) if model_turn is not None else None
                                if parts:
                                    for part in parts:
                                        inline_data = getattr(part, "inline_data", None)
                                        if inline_data is not None and getattr(inline_data, "data", None):
                                            raw_bytes = inline_data.data
                                            b64_out = (
                                                base64.b64encode(raw_bytes).decode("ascii")
                                                if isinstance(raw_bytes, (bytes, bytearray))
                                                else str(raw_bytes)
                                            )
                                            await _send_ws(
                                                {
                                                    "type": "voice.audio",
                                                    "data": b64_out,
                                                    "sampleRate": SAMPLE_RATE_OUT,
                                                }
                                            )
                                        if getattr(part, "text", None):
                                            await _send_ws(
                                                {
                                                    "type": "voice.assistant_text",
                                                    "text": str(part.text),
                                                }
                                            )

                                if getattr(sc, "turn_complete", False):
                                    await _send_ws({"type": "voice.turn_complete"})

                            tc = getattr(response, "tool_call", None)
                            fcalls = getattr(tc, "function_calls", None) if tc is not None else None
                            if fcalls:
                                fn_responses: list[Any] = []
                                for fc in fcalls:
                                    fn_name = str(getattr(fc, "name", "") or "")
                                    fn_id = getattr(fc, "id", None)
                                    fn_args = getattr(fc, "args", None) or {}
                                    if fn_name == "send_prompt_to_antigravity":
                                        res = await send_prompt_to_antigravity(
                                            str(fn_args.get("message") or "")
                                        )
                                    elif fn_name == "get_latest_agent_progress":
                                        res = await get_latest_agent_progress()
                                    elif fn_name == "respond_to_permission":
                                        res = await respond_to_permission(
                                            str(fn_args.get("decision") or "")
                                        )
                                    else:
                                        res = {"ok": False, "error": f"Unknown tool: {fn_name}"}

                                    await _send_ws(
                                        {
                                            "type": "voice.tool_result",
                                            "tool": fn_name,
                                            "result": res,
                                        }
                                    )
                                    fn_responses.append(
                                        types.FunctionResponse(
                                            id=fn_id,
                                            name=fn_name,
                                            response={**res, "scheduling": "WHEN_IDLE"},
                                        )
                                    )
                                if fn_responses:
                                    await session.send_tool_response(function_responses=fn_responses)

                        if not received_any:
                            break

                t_in = asyncio.create_task(_client_to_gemini())
                t_out = asyncio.create_task(_gemini_to_client())
                try:
                    done, pending = await asyncio.wait(
                        {t_in, t_out},
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    for p in pending:
                        p.cancel()
                    for d in done:
                        try:
                            d.result()
                        except (WebSocketDisconnect, asyncio.CancelledError):
                            pass
                        except Exception:
                            pass
                finally:
                    for task in (t_in, t_out):
                        if not task.done():
                            task.cancel()
        except WebSocketDisconnect:
            return
        except Exception as exc:
            await _run_fallback_loop(f"Gemini Live session unavailable ({exc}); switched to Web Speech fallback.")
