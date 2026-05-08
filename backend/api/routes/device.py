from __future__ import annotations

import asyncio
import io
import json
import os
import re
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Cookie, Depends, Header, Query, Request
from fastapi.responses import JSONResponse, Response
from PIL import Image, ImageDraw, ImageFont, UnidentifiedImageError

from api.shared import (
    DISCOVERY_WINDOW_MINUTES,
    ONLINE_WINDOW_MINUTES,
    _preview_push_queue,
    _preview_push_queue_lock,
    build_claim_url,
    ensure_web_or_device_access,
    logger,
    resolve_refresh_minutes_for_device_state,
)
from core.auth import require_admin, require_device_token, require_user, validate_mac_param
from core.config import DEFAULT_LLM_MODEL, DEFAULT_LLM_PROVIDER, SCREEN_HEIGHT, SCREEN_WIDTH
from core.config_store import (
    consume_claim_token,
    create_claim_token,
    generate_device_token,
    get_active_config,
    get_device_state,
    get_or_create_alert_token,
    is_device_owner,
    set_pending_refresh,
    update_device_state,
    validate_alert_token,
)
from core.content import call_llm
from core.patterns.utils import apply_text_fontmode, load_font
from core.renderer import image_to_bmp_bytes, image_to_png_bytes
from core.schemas import DeviceHeartbeatRequest, OkResponse
from core.stats_store import (
    add_favorite,
    check_habit,
    delete_habit,
    get_content_history,
    get_favorites,
    get_habit_status,
    get_latest_heartbeat,
    get_latest_render_content,
)

router = APIRouter(tags=["device"])

_ALERT_QUEUE_GUARD_SECONDS = 600
_DEFAULT_ALERT_SECONDS = 30
_CAT_ALERT_SECONDS = 60
_device_alerts: dict[str, dict] = {}
_device_alerts_lock = asyncio.Lock()
_LOCAL_BYPASS_HEADER = "X-Inksight-Local-Bypass"
_CAT_ACTIONS = {"think", "wave", "cheer", "comfort", "pounce", "nap"}
_CAT_OUTFITS = {"travel", "science", "food", "fitness", "business", "art", "comfort", "general"}
_CAT_ACTION_LABELS = {
    "think": "THINKING",
    "wave": "WAVING",
    "cheer": "CHEERING",
    "comfort": "COMFORTING",
    "pounce": "POUNCING",
    "nap": "NAP MODE",
}
_CAT_OUTFIT_LABELS = {
    "travel": "TRAVEL CAP",
    "science": "SCHOLAR HAT",
    "food": "CHEF HAT",
    "fitness": "SPORT BAND",
    "business": "SMART TIE",
    "art": "ART BERET",
    "comfort": "COZY SCARF",
    "general": "CLASSIC CAT",
}
_CAT_ACTION_FRAMES = {
    "think": [
        "think_left", "blink", "think_center", "tail_curl",
        "think_right", "blink", "ear_tilt", "tail_flick",
        "think_center", "blink", "think_left", "tail_curl",
    ],
    "wave": [
        "wave_left", "wave_right", "wave_left", "blink",
        "wave_right", "tail_high", "wave_left", "wave_right",
        "blink", "sit", "wave_left", "tail_flick",
    ],
    "cheer": [
        "hop", "paws_up", "hop", "blink",
        "tail_high", "paws_up", "hop", "tail_flick",
        "paws_up", "blink", "hop", "tail_high",
    ],
    "comfort": [
        "sit", "slow_blink", "tail_wrap", "blink",
        "ear_tilt", "slow_blink", "sit", "tail_wrap",
        "blink", "sit", "slow_blink", "tail_wrap",
    ],
    "pounce": [
        "crouch", "tail_flick", "spring", "land",
        "crouch", "spring", "tail_high", "land",
        "crouch", "tail_flick", "spring", "land",
    ],
    "nap": [
        "curl", "sleep", "tail_wrap", "sleep",
        "curl", "sleep", "blink", "sleep",
        "tail_wrap", "sleep", "curl", "sleep",
    ],
}


async def _store_device_alert(
    mac: str,
    sender: str,
    message: str,
    level: str,
    *,
    duration_seconds: int = _DEFAULT_ALERT_SECONDS,
    kind: str = "text",
    cat_action: str = "",
    cat_outfit: str = "",
) -> None:
    now = datetime.now()
    async with _device_alerts_lock:
        _device_alerts[mac] = {
            "sender": sender,
            "message": message,
            "level": level or "info",
            "kind": kind or "text",
            "cat_action": cat_action or "",
            "cat_outfit": cat_outfit or "",
            "duration_seconds": max(5, int(duration_seconds or _DEFAULT_ALERT_SECONDS)),
            "started_at": None,
            "expires_at": now + timedelta(seconds=_ALERT_QUEUE_GUARD_SECONDS),
        }


def _build_screen_answer_prompt(question: str) -> str:
    return (
        "Answer this question for a temporary e-ink screen message.\n"
        "Requirements:\n"
        "1. Answer in natural English only.\n"
        "2. Keep the answer concise and useful.\n"
        "3. Prefer 1 to 3 short sentences.\n"
        "4. Keep it within 120 Chinese characters or 220 English characters.\n"
        "5. Do not use markdown, bullets, or extra explanation.\n"
        "6. Output only the final answer text.\n\n"
        f"Question: {question.strip()}"
    )


def _build_cat_answer_prompt(question: str) -> str:
    return (
        "You are directing a tiny pixel cat on an e-ink display.\n"
        "Read the user's question and respond with valid JSON only.\n"
        'Schema: {"answer":"...", "cat_action":"think|wave|cheer|comfort|pounce|nap", "cat_outfit":"travel|science|food|fitness|business|art|comfort|general"}\n'
        "Rules:\n"
        "1. Write the answer in natural English only.\n"
        "2. Keep answer concise and useful.\n"
        "3. Prefer 1 to 3 short sentences.\n"
        "4. Keep it within 120 Chinese characters or 220 English characters.\n"
        "5. Choose exactly one cat_action that matches the emotional tone of the question.\n"
        "6. Choose exactly one cat_outfit that matches the question domain.\n"
        "7. travel is for trips, routes, cities, flights, hotels, packing and sightseeing.\n"
        "8. science is for science, math, medicine, technology, engineering and research questions.\n"
        "9. food is for recipes, snacks, restaurants, coffee and cooking.\n"
        "10. fitness is for workouts, sports, recovery and health routines.\n"
        "11. business is for work, meetings, planning, resumes and productivity.\n"
        "12. art is for drawing, music, poetry, writing, photography and design.\n"
        "13. comfort is for emotional support, sleep, encouragement and gentle care.\n"
        "14. Output JSON only, no markdown.\n\n"
        f"Question: {question.strip()}"
    )


def _extract_json_payload(text: str) -> dict[str, str]:
    cleaned = str(text or "").strip()
    if cleaned.startswith("```"):
        first_newline = cleaned.find("\n")
        if first_newline != -1:
            cleaned = cleaned[first_newline + 1 :]
        cleaned = cleaned.rsplit("```", 1)[0]
    match = re.search(r"\{[\s\S]*\}", cleaned)
    if match:
        cleaned = match.group(0)
    data = json.loads(cleaned)
    if not isinstance(data, dict):
        raise ValueError("json payload is not an object")
    return data


def _normalize_cat_action(action: str) -> str:
    normalized = str(action or "").strip().lower()
    return normalized if normalized in _CAT_ACTIONS else "think"


def _normalize_cat_outfit(outfit: str) -> str:
    normalized = str(outfit or "").strip().lower()
    return normalized if normalized in _CAT_OUTFITS else "general"


def _infer_cat_action(question: str, answer: str = "") -> str:
    text = f"{question} {answer}".lower()
    if any(token in text for token in ("累", "难过", "焦虑", "压力", "sad", "stress", "anxious", "tired", "upset")):
        return "comfort"
    if any(token in text for token in ("睡", "困", "晚安", "nap", "sleep", "rest")):
        return "nap"
    if any(token in text for token in ("冲", "加油", "庆祝", "太好了", "great", "awesome", "celebrate", "win")):
        return "cheer"
    if any(token in text for token in ("你好", "hi", "hello", "早上好", "晚上好")):
        return "wave"
    if any(token in text for token in ("玩", "有趣", "创意", "灵感", "play", "fun", "creative", "idea")):
        return "pounce"
    return "think"


def _infer_cat_outfit(question: str, answer: str = "") -> str:
    text = f"{question} {answer}".lower()
    if any(
        token in text
        for token in (
            "旅游", "旅行", "攻略", "景点", "行程", "酒店", "机票", "航班", "打包", "citywalk",
            "travel", "trip", "vacation", "flight", "hotel", "itinerary", "packing", "sightseeing",
        )
    ):
        return "travel"
    if any(
        token in text
        for token in (
            "科学", "物理", "化学", "生物", "数学", "宇宙", "黑洞", "实验", "研究", "技术", "编程", "代码",
            "science", "physics", "chemistry", "biology", "math", "black hole", "experiment", "research",
            "technology", "engineering", "algorithm", "coding", "programming",
        )
    ):
        return "science"
    if any(
        token in text
        for token in (
            "吃", "菜谱", "做饭", "食谱", "餐厅", "咖啡", "甜点", "奶茶",
            "food", "recipe", "cook", "cooking", "meal", "restaurant", "coffee", "dessert",
        )
    ):
        return "food"
    if any(
        token in text
        for token in (
            "健身", "锻炼", "跑步", "运动", "训练", "减脂", "增肌", "恢复",
            "fitness", "workout", "exercise", "running", "sport", "training", "recovery",
        )
    ):
        return "fitness"
    if any(
        token in text
        for token in (
            "工作", "会议", "汇报", "计划", "职业", "简历", "效率", "项目", "复盘",
            "work", "meeting", "business", "career", "resume", "productivity", "project", "planning",
        )
    ):
        return "business"
    if any(
        token in text
        for token in (
            "画", "绘画", "音乐", "诗", "小说", "摄影", "设计", "创作", "灵感",
            "art", "draw", "drawing", "music", "poetry", "photo", "photography", "design", "writing", "creative",
        )
    ):
        return "art"
    if any(
        token in text
        for token in (
            "难过", "焦虑", "压力", "失眠", "困", "累", "安慰", "鼓励",
            "sad", "stress", "anxious", "sleep", "tired", "comfort", "encourage", "rest",
        )
    ):
        return "comfort"
    return "general"


async def _get_display_alert(mac: str) -> Optional[dict]:
    now = datetime.now()
    async with _device_alerts_lock:
        existing = _device_alerts.get(mac)
        if not existing:
            return None

        expires_at = existing.get("expires_at")
        if isinstance(expires_at, datetime) and expires_at < now:
            _device_alerts.pop(mac, None)
            return None

        if existing.get("started_at") is None:
            duration_seconds = max(5, int(existing.get("duration_seconds") or _DEFAULT_ALERT_SECONDS))
            existing["started_at"] = now
            existing["expires_at"] = now + timedelta(seconds=duration_seconds)
            expires_at = existing["expires_at"]

        expires_at = existing.get("expires_at")
        if isinstance(expires_at, datetime) and expires_at < now:
            _device_alerts.pop(mac, None)
            return None

        return dict(existing)


def _is_loopback_host(host: str) -> bool:
    normalized = str(host or "").strip().lower()
    if normalized.startswith("::ffff:"):
        normalized = normalized.split("::ffff:", 1)[1]
    return normalized in {"127.0.0.1", "::1", "localhost"}


def _allow_local_bypass(request: Request) -> bool:
    header_value = str(request.headers.get(_LOCAL_BYPASS_HEADER) or "").strip()
    client_host = request.client.host if request.client else ""
    return header_value == "1" and _is_loopback_host(client_host)


@router.post("/device/{mac}/refresh")
async def trigger_refresh(
    mac: str,
    request: Request,
    x_device_token: Optional[str] = Header(default=None),
    ink_session: Optional[str] = Cookie(default=None),
):
    await ensure_web_or_device_access(request, mac, x_device_token, ink_session)
    await set_pending_refresh(mac, True)
    logger.info("[DEVICE] Pending refresh set for %s", mac)
    return {"ok": True, "message": "Refresh queued for next wake-up"}


@router.get("/device/{mac}/state")
async def device_state(
    mac: str,
    request: Request,
    x_device_token: Optional[str] = Header(default=None),
    ink_session: Optional[str] = Cookie(default=None),
):
    access = await ensure_web_or_device_access(request, mac, x_device_token, ink_session)
    if access["mode"] == "device":
        await update_device_state(mac, last_state_poll_at=datetime.now().isoformat())
    state = await get_device_state(mac)
    if not state:
        return JSONResponse({"error": "no device state found"}, status_code=404)

    cfg = await get_active_config(mac, log_load=False)
    refresh_minutes = resolve_refresh_minutes_for_device_state(cfg, state)
    latest_heartbeat = await get_latest_heartbeat(mac)
    last_seen = latest_heartbeat.get("created_at") if latest_heartbeat else None
    is_online = False
    if isinstance(last_seen, str) and last_seen:
        try:
            delta_seconds = (datetime.now() - datetime.fromisoformat(last_seen)).total_seconds()
            is_online = delta_seconds <= (ONLINE_WINDOW_MINUTES * 60)
        except ValueError:
            logger.warning("[DEVICE] Invalid last_seen timestamp for %s: %s", mac, last_seen, exc_info=True)
            is_online = False
    state["last_seen"] = last_seen
    state["is_online"] = is_online
    state["refresh_minutes"] = refresh_minutes

    # Auto-fix legacy ota_url missing /api prefix so devices always get a
    # working proxy URL even if the database was written before the fix.
    ota_url = state.get("ota_url", "")
    if ota_url and "/firmware/download" in ota_url and "/api/firmware/download" not in ota_url:
        state["ota_url"] = ota_url.replace("/firmware/download", "/api/firmware/download")

    explicit_mode = str(state.get("runtime_mode") or "").lower()
    if explicit_mode in ("active", "interval"):
        state["runtime_mode"] = explicit_mode
        return state

    runtime_mode = "interval"
    last_poll = state.get("last_state_poll_at", "")
    if isinstance(last_poll, str) and last_poll:
        try:
            delta = (datetime.now() - datetime.fromisoformat(last_poll)).total_seconds()
            runtime_mode = "active" if delta <= 8 else "interval"
        except ValueError:
            logger.warning("[DEVICE] Invalid last_state_poll_at for %s: %s", mac, last_poll, exc_info=True)
            runtime_mode = "interval"
    state["runtime_mode"] = runtime_mode
    return state


@router.post("/device/{mac}/runtime")
async def set_runtime_mode(
    mac: str,
    body: dict,
    x_device_token: Optional[str] = Header(default=None),
):
    mac = validate_mac_param(mac)
    await require_device_token(mac, x_device_token)
    mode = str(body.get("mode", "")).strip().lower()
    if mode not in ("active", "interval"):
        return JSONResponse({"error": "mode must be active or interval"}, status_code=400)
    await update_device_state(mac, runtime_mode=mode)
    return {"ok": True, "runtime_mode": mode}


@router.post("/device/{mac}/heartbeat", response_model=OkResponse)
async def post_device_heartbeat(
    mac: str,
    body: DeviceHeartbeatRequest,
    x_device_token: Optional[str] = Header(default=None),
):
    from core.stats_store import log_heartbeat

    mac = validate_mac_param(mac)
    await require_device_token(mac, x_device_token)
    await log_heartbeat(mac, body.battery_voltage or 3.3, body.wifi_rssi)
    return OkResponse(ok=True)


@router.post("/device/{mac}/alert-token")
async def provision_device_alert_token(
    mac: str,
    regenerate: bool = Query(default=False, description="Force-regenerate the token"),
    user_id: int = Depends(require_user),
):
    mac = validate_mac_param(mac)
    if not await is_device_owner(mac, user_id):
        return JSONResponse({"error": "owner_required"}, status_code=403)
    token = await get_or_create_alert_token(mac, regenerate=regenerate)
    return {"ok": True, "token": token, "regenerated": regenerate}


@router.post("/device/{mac}/alert")
async def push_device_alert(
    mac: str,
    request: Request,
    x_agent_token: Optional[str] = Header(default=None, alias="X-Agent-Token"),
):
    mac = validate_mac_param(mac)
    token = (x_agent_token or "").strip()
    if not token:
        return JSONResponse({"error": "missing_agent_token"}, status_code=401)
    if not await validate_alert_token(mac, token):
        return JSONResponse({"error": "invalid_agent_token"}, status_code=403)

    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid_json"}, status_code=400)
    if not isinstance(payload, dict):
        return JSONResponse({"error": "invalid_payload"}, status_code=400)

    sender = str(payload.get("sender") or "").strip()
    message = str(payload.get("message") or "").strip()
    level = str(payload.get("level") or "info").strip()
    if not sender or not message:
        return JSONResponse({"error": "sender_and_message_required"}, status_code=400)

    await _store_device_alert(mac, sender, message, level, duration_seconds=_DEFAULT_ALERT_SECONDS)
    logger.info("[ALERT] Stored alert for %s (level=%s, ttl=%ss)", mac, level or "info", _DEFAULT_ALERT_SECONDS)
    return {"ok": True}


@router.post("/device/{mac}/ask")
async def ask_device_question(
    mac: str,
    request: Request,
    x_agent_token: Optional[str] = Header(default=None, alias="X-Agent-Token"),
):
    mac = validate_mac_param(mac)
    if not _allow_local_bypass(request):
        token = (x_agent_token or "").strip()
        if not token:
            return JSONResponse({"error": "missing_agent_token"}, status_code=401)
        if not await validate_alert_token(mac, token):
            return JSONResponse({"error": "invalid_agent_token"}, status_code=403)

    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid_json"}, status_code=400)
    if not isinstance(payload, dict):
        return JSONResponse({"error": "invalid_payload"}, status_code=400)

    question = str(payload.get("question") or "").strip()
    answer_override = str(payload.get("answer") or "").strip()
    companion = str(payload.get("companion") or payload.get("mascot") or "").strip().lower()
    cat_mode = companion != "text"
    sender_default = "PIXEL CAT" if cat_mode else "ASK AI"
    sender = str(payload.get("sender") or sender_default).strip() or sender_default
    level = str(payload.get("level") or "info").strip().lower() or "info"
    if level not in ("info", "critical"):
        level = "info"

    if not question and not answer_override:
        return JSONResponse({"error": "question_or_answer_required"}, status_code=400)

    provider = str(payload.get("provider") or DEFAULT_LLM_PROVIDER).strip() or DEFAULT_LLM_PROVIDER
    model = str(payload.get("model") or DEFAULT_LLM_MODEL).strip() or DEFAULT_LLM_MODEL
    api_key = payload.get("api_key")
    llm_base_url = payload.get("llm_base_url")
    if api_key is not None:
        api_key = str(api_key).strip() or None
    if llm_base_url is not None:
        llm_base_url = str(llm_base_url).strip() or None
    cat_action = _normalize_cat_action(str(payload.get("cat_action") or ""))
    cat_outfit = _normalize_cat_outfit(str(payload.get("cat_outfit") or payload.get("outfit") or ""))

    if answer_override:
        answer = answer_override
        if cat_mode and not cat_action:
            cat_action = _infer_cat_action(question, answer)
        if cat_mode and cat_outfit == "general":
            cat_outfit = _infer_cat_outfit(question, answer)
    else:
        if cat_mode:
            prompt = _build_cat_answer_prompt(question)
            try:
                raw = await call_llm(
                    prompt=prompt,
                    temperature=0.6,
                    max_tokens=180,
                    llm_provider=provider,
                    llm_model=model,
                    api_key=api_key,
                    llm_base_url=llm_base_url,
                )
                parsed = _extract_json_payload(raw)
                answer = str(parsed.get("answer") or "").strip()
                cat_action = _normalize_cat_action(str(parsed.get("cat_action") or cat_action))
                cat_outfit = _normalize_cat_outfit(str(parsed.get("cat_outfit") or cat_outfit))
            except Exception:
                logger.warning("[ASK] Failed to parse cat response for %s, falling back to plain answer", mac, exc_info=True)
                try:
                    answer = await call_llm(
                        prompt=_build_screen_answer_prompt(question),
                        temperature=0.5,
                        max_tokens=120,
                        llm_provider=provider,
                        llm_model=model,
                        api_key=api_key,
                        llm_base_url=llm_base_url,
                    )
                except Exception as exc:
                    logger.warning("[ASK] Failed to generate answer for %s", mac, exc_info=True)
                    return JSONResponse(
                        {"error": "llm_generation_failed", "message": str(exc)},
                        status_code=502,
                    )
                cat_action = _infer_cat_action(question, answer)
                cat_outfit = _infer_cat_outfit(question, answer)
        else:
            prompt = _build_screen_answer_prompt(question)
            try:
                answer = await call_llm(
                    prompt=prompt,
                    temperature=0.5,
                    max_tokens=120,
                    llm_provider=provider,
                    llm_model=model,
                    api_key=api_key,
                    llm_base_url=llm_base_url,
                )
            except Exception as exc:
                logger.warning("[ASK] Failed to generate answer for %s", mac, exc_info=True)
                return JSONResponse(
                    {"error": "llm_generation_failed", "message": str(exc)},
                    status_code=502,
                )

    answer = " ".join(str(answer or "").strip().split())
    if not answer:
        return JSONResponse({"error": "empty_answer"}, status_code=502)

    duration_seconds = _CAT_ALERT_SECONDS if cat_mode else _DEFAULT_ALERT_SECONDS
    await _store_device_alert(
        mac,
        sender,
        answer,
        level,
        duration_seconds=duration_seconds,
        kind="cat" if cat_mode else "text",
        cat_action=cat_action if cat_mode else "",
        cat_outfit=cat_outfit if cat_mode else "",
    )
    logger.info(
        "[ASK] Stored model answer for %s (provider=%s, model=%s, ttl=%ss)",
        mac,
        provider,
        model,
        duration_seconds,
    )
    return {
        "ok": True,
        "question": question,
        "answer": answer,
        "sender": sender,
        "level": level,
        "provider": provider,
        "model": model,
        "companion": "cat" if cat_mode else "text",
        "cat_action": cat_action if cat_mode else "",
        "cat_outfit": cat_outfit if cat_mode else "",
        "display_seconds": duration_seconds,
    }


@router.get("/device/{mac}/check_alert")
async def check_device_alert(
    mac: str,
    x_device_token: Optional[str] = Header(default=None, alias="X-Device-Token"),
):
    mac = validate_mac_param(mac)
    await require_device_token(mac, x_device_token)

    now = datetime.now()
    alert_payload: Optional[dict] = None
    async with _device_alerts_lock:
        existing = _device_alerts.get(mac)
        if existing:
            expires_at = existing.get("expires_at")
            if isinstance(expires_at, datetime) and expires_at < now:
                _device_alerts.pop(mac, None)
            else:
                alert_payload = {
                    "sender": existing.get("sender") or "",
                    "message": existing.get("message") or "",
                    "level": existing.get("level") or "info",
                }
                _device_alerts.pop(mac, None)
    if not alert_payload:
        return {"has_alert": False}
    return {"has_alert": True, "alert": alert_payload}


def _wrap_text_by_pixels(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, max_width: int) -> list[str]:
    lines: list[str] = []
    if not text:
        return lines

    def _text_width(value: str) -> float:
        try:
            return float(draw.textlength(value, font=font))
        except Exception:
            bbox = draw.textbbox((0, 0), value, font=font)
            return float(bbox[2] - bbox[0])

    def _wrap_token(token: str) -> list[str]:
        wrapped: list[str] = []
        cur = ""
        for ch in token:
            test = cur + ch
            if _text_width(test) <= max_width or not cur:
                cur = test
            else:
                wrapped.append(cur)
                cur = ch
        if cur:
            wrapped.append(cur)
        return wrapped

    for paragraph in text.splitlines() or [text]:
        paragraph = paragraph.rstrip()
        if not paragraph:
            lines.append("")
            continue

        if re.search(r"\s", paragraph):
            cur = ""
            for word in paragraph.split():
                candidate = word if not cur else f"{cur} {word}"
                if _text_width(candidate) <= max_width:
                    cur = candidate
                    continue
                if cur:
                    lines.append(cur)
                    cur = ""
                if _text_width(word) <= max_width:
                    cur = word
                else:
                    wrapped_word = _wrap_token(word)
                    lines.extend(wrapped_word[:-1])
                    cur = wrapped_word[-1]
            if cur:
                lines.append(cur)
            continue

        lines.extend(_wrap_token(paragraph))

    return lines


def _measure_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont) -> tuple[int, int]:
    try:
        bbox = draw.textbbox((0, 0), text, font=font)
        return bbox[2] - bbox[0], bbox[3] - bbox[1]
    except Exception:
        width = int(draw.textlength(text, font=font))
        return width, getattr(font, "size", 16)


def _ellipsize_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, max_width: int) -> str:
    if not text:
        return text
    width, _ = _measure_text(draw, text, font)
    if width <= max_width:
        return text
    suffix = "…"
    candidate = text
    while candidate:
        candidate = candidate[:-1]
        trial = candidate + suffix
        trial_width, _ = _measure_text(draw, trial, font)
        if trial_width <= max_width:
            return trial
    return suffix


def _pick_alert_title(sender: str, level: str) -> str:
    if level == "critical":
        return "CRITICAL ALERT"
    normalized = sender.strip().lower()
    if normalized in {"ask ai", "assistant", "deepseek", "openclaw"}:
        return "QUICK ANSWER"
    return "FOCUS ALERT"


def _fit_alert_body(
    draw: ImageDraw.ImageDraw,
    message: str,
    max_width: int,
    max_height: int,
    scale: float,
) -> tuple[ImageFont.ImageFont, list[str], int]:
    max_size = max(15, int(28 * scale))
    min_size = max(11, int(14 * scale))
    sizes = list(range(max_size, min_size - 1, -2))
    if min_size not in sizes:
        sizes.append(min_size)

    last_font = load_font("noto_serif_regular", min_size)
    last_lines = _wrap_text_by_pixels(draw, message, last_font, max_width)
    last_line_height = max(_measure_text(draw, "Ag国", last_font)[1], getattr(last_font, "size", min_size)) + max(3, int(min_size * 0.28))

    for size in sizes:
        font = load_font("noto_serif_regular", size)
        lines = _wrap_text_by_pixels(draw, message, font, max_width)
        sample_h = max(_measure_text(draw, "Ag国", font)[1], getattr(font, "size", size))
        line_height = sample_h + max(4, int(size * 0.28))
        if lines and len(lines) * line_height <= max_height:
            return font, lines, line_height
        last_font, last_lines, last_line_height = font, lines, line_height

    max_lines = max(1, max_height // max(last_line_height, 1))
    trimmed = last_lines[:max_lines] if last_lines else [message]
    if trimmed:
        trimmed[-1] = _ellipsize_text(draw, trimmed[-1], last_font, max_width)
    return last_font, trimmed, last_line_height


def _draw_chip(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    text: str,
    font: ImageFont.ImageFont,
    *,
    fill: int,
    text_fill: int,
) -> None:
    try:
        draw.rounded_rectangle(box, radius=max(3, (box[3] - box[1]) // 2), fill=fill, outline=0, width=1)
    except Exception:
        draw.rectangle(box, fill=fill, outline=0, width=1)
    tw, th = _measure_text(draw, text, font)
    tx = box[0] + max(0, (box[2] - box[0] - tw) // 2)
    ty = box[1] + max(0, (box[3] - box[1] - th) // 2) - 1
    draw.text((tx, ty), text, fill=text_fill, font=font)


def _draw_pixel_cell(
    draw: ImageDraw.ImageDraw,
    ox: int,
    oy: int,
    cell: int,
    x: int,
    y: int,
    *,
    fill: int = 0,
) -> None:
    draw.rectangle(
        (
            ox + x * cell,
            oy + y * cell,
            ox + (x + 1) * cell - 1,
            oy + (y + 1) * cell - 1,
        ),
        fill=fill,
    )


def _draw_pixel_rect(
    draw: ImageDraw.ImageDraw,
    ox: int,
    oy: int,
    cell: int,
    x1: int,
    y1: int,
    x2: int,
    y2: int,
    *,
    fill: int = 0,
) -> None:
    draw.rectangle(
        (
            ox + x1 * cell,
            oy + y1 * cell,
            ox + (x2 + 1) * cell - 1,
            oy + (y2 + 1) * cell - 1,
        ),
        fill=fill,
    )


def _draw_cat_pose(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    pose: str,
    action: str,
) -> None:
    grid = 26
    box_w = box[2] - box[0]
    box_h = box[3] - box[1]
    cell = max(2, min(box_w // grid, box_h // grid))
    sprite_w = grid * cell
    sprite_h = grid * cell
    hop_offset = -cell if pose in {"hop", "spring", "paws_up"} else 0
    ox = box[0] + max(0, (box_w - sprite_w) // 2)
    oy = box[1] + max(0, (box_h - sprite_h) // 2) + hop_offset

    def px(x: int, y: int) -> None:
        _draw_pixel_cell(draw, ox, oy, cell, x, y)

    def rect(x1: int, y1: int, x2: int, y2: int) -> None:
        _draw_pixel_rect(draw, ox, oy, cell, x1, y1, x2, y2)

    def clear_px(x: int, y: int) -> None:
        _draw_pixel_cell(draw, ox, oy, cell, x, y, fill=1)

    def clear_rect(x1: int, y1: int, x2: int, y2: int) -> None:
        _draw_pixel_rect(draw, ox, oy, cell, x1, y1, x2, y2, fill=1)

    def line(points: list[tuple[int, int]]) -> None:
        for x, y in points:
            px(x, y)

    def clear_line(points: list[tuple[int, int]]) -> None:
        for x, y in points:
            clear_px(x, y)

    # Head / ears
    rect(8, 4, 17, 11)
    rect(8, 2, 10, 4)
    rect(15, 2, 17, 4)
    px(9, 1); px(16, 1)
    px(10, 2); px(15, 2)
    line([(11, 3), (12, 3), (13, 3), (14, 3)])
    clear_px(9, 3); clear_px(16, 3)
    clear_px(10, 4); clear_px(15, 4)

    # Body variants
    if pose in {"crouch", "curl", "sleep"}:
        rect(9, 13, 17, 18)
    else:
        rect(9, 12, 16, 19)
    line([(9, 12), (8, 13), (8, 14)])
    line([(16, 12), (17, 13), (17, 14)])

    # Eyes / face
    clear_rect(11, 8, 14, 11)
    clear_px(10, 9); clear_px(15, 9)
    clear_px(12, 12); clear_px(13, 12)
    if pose in {"blink", "slow_blink", "sleep"}:
        clear_rect(10, 7, 11, 7)
        clear_rect(14, 7, 15, 7)
    else:
        clear_rect(10, 6, 11, 7)
        clear_rect(14, 6, 15, 7)
        px(11, 7); px(14, 7)
        if pose == "think_left":
            px(10, 7)
        elif pose == "think_right":
            px(15, 7)
        elif pose == "think_center":
            px(12, 7); px(13, 7)
    px(12, 9); px(13, 9)
    if pose == "comfort":
        px(12, 10); px(13, 10)
        line([(11, 11), (12, 12)])
        line([(14, 11), (13, 12)])
    else:
        px(12, 10); px(13, 10)
        line([(12, 10), (12, 11)])
        line([(13, 10), (13, 11)])
    clear_line([(9, 8), (8, 8), (7, 7)])
    clear_line([(16, 8), (17, 8), (18, 7)])
    clear_line([(9, 9), (8, 9), (7, 10)])
    clear_line([(16, 9), (17, 9), (18, 10)])
    clear_px(11, 9); clear_px(14, 9)

    # Front paws
    if pose in {"wave_left"}:
        rect(5, 11, 6, 15)
        rect(14, 18, 15, 20)
    elif pose in {"wave_right"}:
        rect(19, 11, 20, 15)
        rect(10, 18, 11, 20)
    elif pose in {"paws_up"}:
        rect(5, 10, 6, 15)
        rect(19, 10, 20, 15)
    elif pose in {"spring"}:
        rect(7, 14, 9, 16)
        rect(16, 14, 18, 16)
    else:
        rect(10, 18, 11, 20)
        rect(14, 18, 15, 20)

    # Hind legs
    if pose in {"crouch", "curl", "sleep"}:
        rect(11, 18, 12, 20)
        rect(15, 18, 16, 20)
    elif pose == "land":
        rect(9, 19, 11, 21)
        rect(14, 19, 16, 21)
    else:
        rect(9, 19, 10, 21)
        rect(15, 19, 16, 21)
    px(10, 21); px(11, 21); px(14, 21); px(15, 21)

    # Tail
    tail_points: list[tuple[int, int]] = []
    if pose in {"tail_wrap", "curl", "sleep"}:
        tail_points = [(17, 16), (18, 16), (19, 17), (19, 18), (18, 19), (17, 19), (16, 18), (15, 18)]
    elif pose in {"tail_high", "wave_right"}:
        tail_points = [(17, 14), (18, 13), (19, 12), (20, 10), (20, 8), (19, 7), (18, 6)]
    elif pose in {"tail_flick", "think_right"}:
        tail_points = [(17, 15), (18, 15), (19, 14), (20, 14), (21, 13), (20, 12), (19, 11)]
    elif pose in {"think_left"}:
        tail_points = [(9, 15), (8, 15), (7, 14), (6, 14), (5, 13), (6, 12), (7, 11)]
    else:
        tail_points = [(17, 15), (18, 15), (19, 16), (20, 16), (21, 17), (22, 17)]
    for x, y in tail_points:
        px(x, y)

    # Body details
    line([(11, 12), (12, 13), (13, 13), (14, 13)])
    line([(12, 14), (13, 14)])
    px(12, 15); px(13, 15)
    if pose in {"ear_tilt"}:
        px(8, 3); px(17, 2)
    if pose in {"tail_curl"}:
        px(18, 20); px(19, 20)
    if pose in {"slow_blink", "sleep"}:
        px(12, 8); px(13, 8)
    if pose in {"wave_left", "wave_right", "paws_up"}:
        px(5, 16); px(20, 16)
    if pose == "hop":
        line([(9, 22), (10, 23), (15, 23), (16, 22)])
    else:
        line([(9, 22), (10, 22), (15, 22), (16, 22)])

    # Action marks
    if action == "think":
        px(4, 3); px(6, 1); px(19, 1); px(20, 3)
    elif action == "cheer":
        rect(11, 0, 11, 1); rect(14, 0, 14, 1); px(9, 2); px(16, 2); px(12, 1); px(13, 1)
    elif action == "comfort":
        px(4, 5); px(5, 4); px(6, 5); px(5, 6); px(7, 5)
    elif action == "pounce":
        rect(2, 15, 4, 15); rect(21, 13, 23, 13)
    elif action == "nap":
        rect(19, 2, 20, 2); rect(20, 3, 22, 3); rect(19, 4, 20, 4)
    elif action == "wave":
        px(3, 10); px(4, 9); px(4, 11); px(5, 10)


def _draw_cat_outfit(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    outfit: str,
) -> None:
    grid = 26
    box_w = box[2] - box[0]
    box_h = box[3] - box[1]
    cell = max(2, min(box_w // grid, box_h // grid))
    sprite_w = grid * cell
    sprite_h = grid * cell
    ox = box[0] + max(0, (box_w - sprite_w) // 2)
    oy = box[1] + max(0, (box_h - sprite_h) // 2)

    def px(x: int, y: int, *, fill: int = 0) -> None:
        _draw_pixel_cell(draw, ox, oy, cell, x, y, fill=fill)

    def rect(x1: int, y1: int, x2: int, y2: int, *, fill: int = 0) -> None:
        _draw_pixel_rect(draw, ox, oy, cell, x1, y1, x2, y2, fill=fill)

    outfit = _normalize_cat_outfit(outfit)
    if outfit == "travel":
        rect(8, 0, 16, 2)
        rect(15, 2, 18, 3)
        rect(13, 3, 18, 4)
        px(17, 1, fill=1)
        px(9, 1, fill=1)
    elif outfit == "science":
        rect(7, 0, 18, 1)
        rect(10, 2, 15, 3)
        px(17, 2); px(18, 3); px(18, 4); px(17, 5)
        px(16, 5)
    elif outfit == "food":
        rect(8, 1, 16, 2)
        rect(7, 0, 9, 1)
        rect(10, 0, 12, 1)
        rect(13, 0, 15, 1)
        rect(16, 0, 17, 1)
        px(8, 3); px(16, 3)
    elif outfit == "fitness":
        rect(9, 4, 16, 5)
        px(17, 5); px(18, 6); px(18, 7)
        px(8, 5, fill=1); px(16, 5, fill=1)
    elif outfit == "business":
        rect(11, 12, 14, 13)
        px(12, 14); px(13, 14)
        px(12, 15); px(13, 15)
        rect(12, 16, 13, 18)
    elif outfit == "art":
        rect(8, 1, 15, 2)
        rect(9, 0, 14, 1)
        px(15, 3); px(16, 4)
        px(8, 2, fill=1); px(14, 1, fill=1)
    elif outfit == "comfort":
        rect(9, 12, 16, 13)
        rect(8, 13, 10, 14)
        rect(15, 13, 17, 14)
        rect(10, 14, 12, 15)
        rect(13, 14, 14, 16)
    else:
        rect(10, 12, 15, 13)
        px(12, 14); px(13, 14)
        px(12, 13, fill=1); px(13, 13, fill=1)


def _render_cat_alert_card(w: int, h: int, alert_payload: dict) -> Image.Image:
    sender = str(alert_payload.get("sender") or "PIXEL CAT").strip() or "PIXEL CAT"
    message = str(alert_payload.get("message") or "").strip()
    action = _normalize_cat_action(str(alert_payload.get("cat_action") or "think"))
    outfit = _normalize_cat_outfit(str(alert_payload.get("cat_outfit") or "general"))
    duration_seconds = max(10, int(alert_payload.get("duration_seconds") or _CAT_ALERT_SECONDS))
    started_at = alert_payload.get("started_at")
    now = datetime.now()
    if not isinstance(started_at, datetime):
        started_at = now
    elapsed = max(0, int((now - started_at).total_seconds()))
    frame_names = _CAT_ACTION_FRAMES.get(action, _CAT_ACTION_FRAMES["think"])
    frame_span = max(1, duration_seconds // max(1, len(frame_names)))
    frame_index = min(len(frame_names) - 1, elapsed // frame_span)
    pose = frame_names[frame_index]
    img = Image.new("1", (w, h), 1)
    draw = ImageDraw.Draw(img)
    apply_text_fontmode(draw)

    scale = min(w / float(SCREEN_WIDTH), h / float(SCREEN_HEIGHT))
    frame_margin = max(8, int(min(w, h) * 0.035))
    left = frame_margin
    top = frame_margin
    right = w - frame_margin - 1
    bottom = h - frame_margin - 1
    draw.rectangle((left, top, right, bottom), outline=0, width=1)

    header_pad_x = max(10, int(w * 0.04))
    header_pad_y = max(8, int(h * 0.035))
    title_font = load_font("noto_serif_bold", max(13, int(22 * scale)))
    chip_font = load_font("noto_serif_bold", max(10, int(13 * scale)))
    meta_font = load_font("noto_serif_regular", max(9, int(12 * scale)))

    sender_label = _ellipsize_text(draw, sender, chip_font, int((right - left) * 0.42))
    sender_w = _measure_text(draw, sender_label, chip_font)[0] + max(14, int(18 * scale))
    chip_h = max(18, int(22 * scale))
    sender_box = (left + header_pad_x, top + header_pad_y, left + header_pad_x + sender_w, top + header_pad_y + chip_h)
    _draw_chip(draw, sender_box, sender_label, chip_font, fill=0, text_fill=1)

    badge_text = _CAT_ACTION_LABELS.get(action, "CAT MODE")
    badge_w = _measure_text(draw, badge_text, chip_font)[0] + max(14, int(18 * scale))
    badge_box = (right - header_pad_x - badge_w, top + header_pad_y, right - header_pad_x, top + header_pad_y + chip_h)
    _draw_chip(draw, badge_box, badge_text, chip_font, fill=1, text_fill=0)

    title = "PIXEL CAT"
    title_w, title_h = _measure_text(draw, title, title_font)
    title_x = left + max(0, (right - left - title_w) // 2)
    title_y = sender_box[3] + max(8, int(h * 0.028))
    draw.text((title_x, title_y), title, fill=0, font=title_font)

    divider_y = title_y + title_h + max(8, int(h * 0.03))
    draw.line((left + header_pad_x, divider_y, right - header_pad_x, divider_y), fill=0, width=1)

    footer_h = max(18, int(20 * scale))
    footer_y = bottom - header_pad_y - footer_h
    draw.line((left + header_pad_x, footer_y - max(7, int(h * 0.025)), right - header_pad_x, footer_y - max(7, int(h * 0.025))), fill=0, width=1)

    body_top = divider_y + max(12, int(h * 0.04))
    body_bottom = footer_y - max(10, int(h * 0.03))
    body_left = left + header_pad_x
    body_right = right - header_pad_x
    body_width = body_right - body_left
    body_height = body_bottom - body_top

    gap = max(10, int(w * 0.03))
    cat_width = max(96, int(body_width * 0.42))
    cat_box = (body_left, body_top, body_left + cat_width, body_bottom)
    text_box_left = cat_box[2] + gap
    text_width = max(40, body_right - text_box_left)
    text_box = (text_box_left, body_top, body_right, body_bottom)

    try:
        draw.rounded_rectangle(cat_box, radius=max(4, int(8 * scale)), outline=0, width=1)
    except Exception:
        draw.rectangle(cat_box, outline=0, width=1)

    _draw_cat_pose(draw, (cat_box[0] + 6, cat_box[1] + 6, cat_box[2] - 6, cat_box[3] - 6), pose, action)
    _draw_cat_outfit(draw, (cat_box[0] + 6, cat_box[1] + 6, cat_box[2] - 6, cat_box[3] - 6), outfit)

    action_font = load_font("noto_serif_regular", max(10, int(12 * scale)))
    action_text = {
        "think": "thinking with you",
        "wave": "saying hi",
        "cheer": "cheering you on",
        "comfort": "staying close",
        "pounce": "play mode",
        "nap": "soft sleepy mode",
    }.get(action, "thinking with you")
    action_w, _ = _measure_text(draw, action_text, action_font)
    action_y = cat_box[3] - max(26, int(30 * scale))
    draw.text((cat_box[0] + max(0, (cat_box[2] - cat_box[0] - action_w) // 2), action_y), action_text, fill=0, font=action_font)
    outfit_font = load_font("noto_serif_regular", max(9, int(11 * scale)))
    outfit_text = _CAT_OUTFIT_LABELS.get(outfit, "CLASSIC CAT").lower()
    outfit_w, _ = _measure_text(draw, outfit_text, outfit_font)
    draw.text((cat_box[0] + max(0, (cat_box[2] - cat_box[0] - outfit_w) // 2), action_y + max(11, int(14 * scale))), outfit_text, fill=0, font=outfit_font)

    body_font, lines, line_height = _fit_alert_body(draw, message, text_width, body_height, scale)
    quote_font = load_font("noto_serif_bold", max(12, int(18 * scale)))
    draw.text((text_box[0], text_box[1]), '"', fill=0, font=quote_font)
    text_start_y = text_box[1] + max(10, int(18 * scale))
    text_block_height = len(lines) * line_height if lines else line_height
    current_y = text_start_y + max(0, (body_height - max(10, int(18 * scale)) - text_block_height) // 2)
    for line in lines:
        if line:
            draw.text((text_box[0], current_y), line, fill=0, font=body_font)
        current_y += line_height

    footer_left = _CAT_OUTFIT_LABELS.get(outfit, "CLASSIC CAT").lower()
    footer_right = sender_label.upper()
    draw.text((body_left, footer_y), footer_left, fill=0, font=meta_font)
    footer_right_w, _ = _measure_text(draw, footer_right, meta_font)
    draw.text((body_right - footer_right_w, footer_y), footer_right, fill=0, font=meta_font)
    return img


def _render_text_alert_card(w: int, h: int, alert_payload: dict) -> Image.Image:
    sender = str(alert_payload.get("sender") or "").strip()
    message = str(alert_payload.get("message") or "").strip()
    level = str(alert_payload.get("level") or "info").strip().lower()
    duration_seconds = max(5, int(alert_payload.get("duration_seconds") or _DEFAULT_ALERT_SECONDS))

    img = Image.new("1", (w, h), 1)
    draw = ImageDraw.Draw(img)
    apply_text_fontmode(draw)

    scale = min(w / float(SCREEN_WIDTH), h / float(SCREEN_HEIGHT))
    frame_margin = max(8, int(min(w, h) * 0.035))
    frame_left = frame_margin
    frame_top = frame_margin
    frame_right = w - frame_margin - 1
    frame_bottom = h - frame_margin - 1
    draw.rectangle((frame_left, frame_top, frame_right, frame_bottom), outline=0, width=1)

    header_pad_x = max(10, int(w * 0.04))
    header_pad_y = max(8, int(h * 0.035))
    title_font = load_font("noto_serif_bold", max(13, int(22 * scale)))
    chip_font = load_font("noto_serif_bold", max(10, int(13 * scale)))
    meta_font = load_font("noto_serif_regular", max(9, int(12 * scale)))

    title = _pick_alert_title(sender, level)
    sender_label = _ellipsize_text(draw, sender or "ASK AI", chip_font, int((frame_right - frame_left) * 0.45))
    right_badge = "CRITICAL" if level == "critical" else f"{duration_seconds:02d}S TEMP"

    chip_h = max(18, int(22 * scale))
    sender_w = _measure_text(draw, sender_label, chip_font)[0] + max(14, int(18 * scale))
    sender_box = (
        frame_left + header_pad_x,
        frame_top + header_pad_y,
        frame_left + header_pad_x + sender_w,
        frame_top + header_pad_y + chip_h,
    )
    _draw_chip(draw, sender_box, sender_label, chip_font, fill=0, text_fill=1)

    badge_w = _measure_text(draw, right_badge, chip_font)[0] + max(14, int(18 * scale))
    badge_box = (
        frame_right - header_pad_x - badge_w,
        frame_top + header_pad_y,
        frame_right - header_pad_x,
        frame_top + header_pad_y + chip_h,
    )
    if level == "critical":
        _draw_chip(draw, badge_box, right_badge, chip_font, fill=0, text_fill=1)
    else:
        _draw_chip(draw, badge_box, right_badge, chip_font, fill=1, text_fill=0)

    title_w, title_h = _measure_text(draw, title, title_font)
    title_x = frame_left + max(0, (frame_right - frame_left - title_w) // 2)
    title_y = sender_box[3] + max(8, int(h * 0.028))
    draw.text((title_x, title_y), title, fill=0, font=title_font)

    divider_y = title_y + title_h + max(8, int(h * 0.03))
    draw.line((frame_left + header_pad_x, divider_y, frame_right - header_pad_x, divider_y), fill=0, width=1)

    footer_h = max(18, int(20 * scale))
    footer_y = frame_bottom - header_pad_y - footer_h
    draw.line((frame_left + header_pad_x, footer_y - max(7, int(h * 0.025)), frame_right - header_pad_x, footer_y - max(7, int(h * 0.025))), fill=0, width=1)

    body_top = divider_y + max(12, int(h * 0.04))
    body_bottom = footer_y - max(12, int(h * 0.035))
    body_left = frame_left + header_pad_x
    body_right = frame_right - header_pad_x
    body_width = max(40, body_right - body_left)
    body_height = max(24, body_bottom - body_top)

    body_font, lines, line_height = _fit_alert_body(draw, message, body_width, body_height, scale)
    text_block_height = len(lines) * line_height if lines else line_height
    current_y = body_top + max(0, (body_height - text_block_height) // 2)
    center_lines = len(lines) <= 4
    for line in lines:
        if not line:
            current_y += line_height
            continue
        line_w, _ = _measure_text(draw, line, body_font)
        line_x = body_left if not center_lines else body_left + max(0, (body_width - line_w) // 2)
        draw.text((line_x, current_y), line, fill=0, font=body_font)
        current_y += line_height

    footer_left = "Temporary answer" if level != "critical" else "Priority message"
    footer_right = sender_label.upper()
    draw.text((body_left, footer_y), footer_left, fill=0, font=meta_font)
    footer_right_w, _ = _measure_text(draw, footer_right, meta_font)
    draw.text((body_right - footer_right_w, footer_y), footer_right, fill=0, font=meta_font)
    return img


@router.get("/device/{mac}/alert-bmp")
async def alert_bmp(
    mac: str,
    w: int = Query(default=SCREEN_WIDTH, ge=100, le=1600),
    h: int = Query(default=SCREEN_HEIGHT, ge=100, le=1200),
    x_device_token: Optional[str] = Header(default=None, alias="X-Device-Token"),
):
    mac = validate_mac_param(mac)
    await require_device_token(mac, x_device_token)

    alert_payload = await _get_display_alert(mac)
    if not alert_payload:
        return Response(status_code=204)
    if str(alert_payload.get("kind") or "text").strip().lower() == "cat":
        img = _render_cat_alert_card(w, h, alert_payload)
    else:
        img = _render_text_alert_card(w, h, alert_payload)
    return Response(content=image_to_bmp_bytes(img), media_type="image/bmp")


@router.post("/device/{mac}/apply-preview")
async def apply_preview_to_device(
    mac: str,
    request: Request,
    mode: str = Query(default="", description="Optional mode hint for logs/state"),
    x_device_token: Optional[str] = Header(default=None),
    ink_session: Optional[str] = Cookie(default=None),
):
    await ensure_web_or_device_access(request, mac, x_device_token, ink_session)
    body = await request.body()
    if not body:
        return JSONResponse({"error": "empty image payload"}, status_code=400)
    if len(body) > 4 * 1024 * 1024:
        return JSONResponse({"error": "image payload too large"}, status_code=413)

    try:
        with Image.open(io.BytesIO(body)) as incoming:
            normalized = io.BytesIO()
            if incoming.mode == "P":
                incoming.save(normalized, format="PNG")
            else:
                incoming.convert("L").save(normalized, format="PNG")
            normalized_bytes = normalized.getvalue()
    except (UnidentifiedImageError, OSError, ValueError):
        logger.warning("[DEVICE] Invalid preview payload for %s", mac, exc_info=True)
        return JSONResponse({"error": "invalid image payload"}, status_code=400)

    mode_hint = mode.strip().upper()
    async with _preview_push_queue_lock:
        _preview_push_queue[mac] = {"image": normalized_bytes, "mode": mode_hint}
        logger.info("[APPLY-PREVIEW] Queue now: mac=%s, mode=%s, image_size=%d bytes", mac, mode_hint, len(normalized_bytes))
    await set_pending_refresh(mac, True)
    from core.config_store import get_device_state as _get_ds
    st = await _get_ds(mac)
    logger.info("[APPLY-PREVIEW] Device state after push: mac=%s, pending_refresh=%s, pending_mode=%s", mac, st.get("pending_refresh") if st else "N/A", st.get("pending_mode") if st else "N/A")
    logger.info("[DEVICE] Queued preview push for %s, mode=%s", mac, mode_hint or "-")
    return {"ok": True, "message": "Preview queued"}


@router.post("/device/{mac}/switch")
async def switch_mode(
    mac: str,
    body: dict,
    request: Request,
    x_device_token: Optional[str] = Header(default=None),
    ink_session: Optional[str] = Cookie(default=None),
):
    from core.mode_registry import get_registry

    await ensure_web_or_device_access(request, mac, x_device_token, ink_session)
    mode = body.get("mode", "").upper()
    registry = get_registry()
    if not mode or not registry.is_supported(mode, mac):
        return JSONResponse({"error": f"unsupported mode: {mode}"}, status_code=400)
    await update_device_state(mac, pending_mode=mode, pending_refresh=1)
    logger.info("[DEVICE] Pending mode switch to %s for %s", mode, mac)
    return {"ok": True, "message": f"Mode switch to {mode} queued"}


@router.post("/device/{mac}/favorite")
async def favorite_content(
    mac: str,
    request: Request,
    body: Optional[dict] = None,
    x_device_token: Optional[str] = Header(default=None),
    ink_session: Optional[str] = Cookie(default=None),
):
    from core.mode_registry import get_registry

    await ensure_web_or_device_access(request, mac, x_device_token, ink_session)
    mode = str((body or {}).get("mode", "")).strip().upper()
    if mode:
        registry = get_registry()
        if not registry.is_supported(mode, mac):
            return JSONResponse({"error": f"unsupported mode: {mode}"}, status_code=400)
        latest = await get_latest_render_content(mac)
        if latest and latest.get("mode_id", "").upper() == mode:
            await add_favorite(mac, mode, json.dumps(latest["content"], ensure_ascii=False))
        else:
            await add_favorite(mac, mode, None)
        return {"ok": True, "message": "Mode favorited", "mode_id": mode}

    latest = await get_latest_render_content(mac)
    if not latest:
        state = await get_device_state(mac)
        mode_id = state.get("last_persona", "UNKNOWN") if state else "UNKNOWN"
        await add_favorite(mac, mode_id, None)
    else:
        await add_favorite(mac, latest["mode_id"], json.dumps(latest["content"], ensure_ascii=False))
    return {"ok": True, "message": "Content favorited"}


@router.get("/device/{mac}/favorites")
async def list_favorites(
    mac: str,
    request: Request,
    limit: int = Query(default=30, ge=1, le=100),
    x_device_token: Optional[str] = Header(default=None),
    ink_session: Optional[str] = Cookie(default=None),
):
    await ensure_web_or_device_access(request, mac, x_device_token, ink_session)
    return {"mac": mac, "favorites": await get_favorites(mac, limit)}


@router.get("/device/{mac}/history")
async def content_history(
    mac: str,
    request: Request,
    limit: int = Query(default=30, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    mode: Optional[str] = Query(default=None),
    x_device_token: Optional[str] = Header(default=None),
    ink_session: Optional[str] = Cookie(default=None),
):
    await ensure_web_or_device_access(request, mac, x_device_token, ink_session)
    return {"mac": mac, "history": await get_content_history(mac, limit, offset, mode)}


@router.post("/device/{mac}/habit/check")
async def habit_check(
    mac: str,
    body: dict,
    request: Request,
    x_device_token: Optional[str] = Header(default=None),
    ink_session: Optional[str] = Cookie(default=None),
):
    await ensure_web_or_device_access(request, mac, x_device_token, ink_session)
    habit_name = body.get("habit", "").strip()
    if not habit_name:
        return JSONResponse({"error": "habit name is required"}, status_code=400)
    await check_habit(mac, habit_name, body.get("date"))
    return {"ok": True, "message": f"Habit '{habit_name}' checked"}


@router.get("/device/{mac}/habit/status")
async def habit_status(
    mac: str,
    request: Request,
    x_device_token: Optional[str] = Header(default=None),
    ink_session: Optional[str] = Cookie(default=None),
):
    await ensure_web_or_device_access(request, mac, x_device_token, ink_session)
    return {"mac": mac, "habits": await get_habit_status(mac)}


@router.delete("/device/{mac}/habit/{habit_name}")
async def habit_delete(
    mac: str,
    habit_name: str,
    request: Request,
    x_device_token: Optional[str] = Header(default=None),
    ink_session: Optional[str] = Cookie(default=None),
):
    await ensure_web_or_device_access(request, mac, x_device_token, ink_session)
    deleted = await delete_habit(mac, habit_name)
    if not deleted:
        return JSONResponse({"error": "Habit not found"}, status_code=404)
    return {"ok": True, "message": f"Habit '{habit_name}' deleted"}


@router.post("/device/{mac}/token")
async def provision_device_token(mac: str):
    mac = validate_mac_param(mac)
    state = await get_device_state(mac)
    if state and state.get("auth_token"):
        return {"token": state["auth_token"], "new": False}
    token = await generate_device_token(mac)
    logger.info("[AUTH] Provisioned new device token for %s", mac)
    return {"token": token, "new": True}


@router.post("/device/{mac}/claim-token")
async def provision_claim_token(
    mac: str,
    request: Request,
    body: Optional[dict] = None,
    x_device_token: Optional[str] = Header(default=None),
):
    mac = validate_mac_param(mac)
    await require_device_token(mac, x_device_token)
    preferred_pair_code = str((body or {}).get("pair_code") or "").strip()
    created = await create_claim_token(mac, source="portal", preferred_pair_code=preferred_pair_code)
    if created is None:
        return JSONResponse({"error": "pair_code_conflict"}, status_code=409)
    return {
        "ok": True,
        "token": created["token"],
        "pair_code": created["pair_code"],
        "claim_url": build_claim_url(request, created["token"]),
        "expires_at": created["expires_at"],
    }


@router.post("/claim/consume")
async def claim_consume(body: dict, user_id: int = Depends(require_user)):
    token = str(body.get("token") or "").strip()
    pair_code = str(body.get("pair_code") or "").strip()
    if not token and not pair_code:
        return JSONResponse({"error": "token or pair_code is required"}, status_code=400)
    result = await consume_claim_token(user_id=user_id, token=token, pair_code=pair_code)
    if result["status"] == "invalid":
        return JSONResponse({"error": "Invalid pair code or claim token"}, status_code=404)
    if result["status"] == "expired":
        return JSONResponse({"error": "Pair code or claim token has expired"}, status_code=410)
    return {"ok": True, **result}


@router.get("/devices/recent")
async def recent_devices(
    minutes: int = Query(default=DISCOVERY_WINDOW_MINUTES, ge=1, le=60),
    admin_auth: None = Depends(require_admin),
):
    from core.db import get_main_db

    cutoff = (datetime.now() - timedelta(minutes=minutes)).isoformat()
    db = await get_main_db()
    cursor = await db.execute(
        """WITH recent AS (
               SELECT mac, MAX(created_at) AS last_seen
               FROM device_heartbeats
               WHERE created_at > ?
               GROUP BY mac
           )
           SELECT recent.mac,
                  recent.last_seen,
                  CASE WHEN owner.user_id IS NULL THEN 0 ELSE 1 END AS has_owner
           FROM recent
           LEFT JOIN device_memberships owner
             ON owner.mac = recent.mac AND owner.role = 'owner' AND owner.status = 'active'
           ORDER BY recent.last_seen DESC""",
        (cutoff,),
    )
    rows = await cursor.fetchall()
    devices = [{"mac": row[0], "last_seen": row[1], "has_owner": bool(row[2])} for row in rows if row and row[0]]
    return {"devices": devices}


@router.get("/device/{mac}/qr")
async def device_qr(
    mac: str,
    request: Request,
    base_url: Optional[str] = Query(default=None),
    x_device_token: Optional[str] = Header(default=None),
    ink_session: Optional[str] = Cookie(default=None),
):
    import qrcode

    await ensure_web_or_device_access(request, mac, x_device_token, ink_session)
    remote_base = base_url or "https://www.inksight.site"
    url = f"{remote_base}/remote?mac={mac}"
    qr = qrcode.QRCode(version=1, box_size=4, border=2)
    qr.add_data(url)
    qr.make(fit=True)
    qr_img = qr.make_image(fill_color="black", back_color="white").convert("1")

    qr_w, qr_h = qr_img.size
    canvas = Image.new("1", (SCREEN_WIDTH, SCREEN_HEIGHT), 1)
    x_offset = (SCREEN_WIDTH - qr_w) // 2
    y_offset = (SCREEN_HEIGHT - qr_h) // 2 - 20
    canvas.paste(qr_img, (x_offset, max(y_offset, 30)))
    return Response(content=image_to_bmp_bytes(canvas), media_type="image/bmp")


@router.get("/device/{mac}/share")
async def share_image(
    mac: str,
    request: Request,
    w: int = Query(default=800, ge=400, le=1600),
    h: int = Query(default=450, ge=300, le=900),
    x_device_token: Optional[str] = Header(default=None),
    ink_session: Optional[str] = Cookie(default=None),
):
    await ensure_web_or_device_access(request, mac, x_device_token, ink_session)
    latest = await get_latest_render_content(mac)
    if not latest:
        return JSONResponse({"error": "no content to share"}, status_code=404)

    img = Image.new("L", (w, h), 255)
    draw = ImageDraw.Draw(img)
    font_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "fonts")
    try:
        title_font = ImageFont.truetype(os.path.join(font_dir, "NotoSerifSC-Bold.ttf"), 24)
        body_font = ImageFont.truetype(os.path.join(font_dir, "NotoSerifSC-Regular.ttf"), 18)
        small_font = ImageFont.truetype(os.path.join(font_dir, "NotoSerifSC-Regular.ttf"), 12)
    except OSError:
        logger.warning("[DEVICE] Falling back to default fonts for share image", exc_info=True)
        title_font = ImageFont.load_default()
        body_font = ImageFont.load_default()
        small_font = ImageFont.load_default()

    draw.rectangle([(0, 0), (w - 1, h - 1)], outline=0, width=2)
    draw.text((40, 30), latest["mode_id"], fill=0, font=title_font)

    y = 80
    content = latest["content"]
    main_text = ""
    for key in ("quote", "question", "challenge", "body", "word", "opening", "event_title", "name_cn"):
        if key in content:
            main_text = str(content[key])
            break
    if not main_text:
        main_text = str(list(content.values())[0]) if content else "InkSight"

    for line in main_text[:200].split("\n"):
        draw.text((40, y), line, fill=0, font=body_font)
        y += 28

    draw.line([(40, h - 50), (w - 40, h - 50)], fill=180, width=1)
    draw.text((40, h - 40), "InkSight | inco", fill=128, font=small_font)
    draw.text((w - 180, h - 40), "www.inksight.site", fill=128, font=small_font)
    return Response(content=image_to_png_bytes(img.convert("1")), media_type="image/png")
