import os
import io
import json
import re
import math
import asyncio
import urllib.request
import urllib.error
import html as html_module
import struct
import base64
import tempfile
import subprocess
from typing import AsyncGenerator, List

try:
    import cv2
    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False

import google.generativeai as genai
from PIL import Image
from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

genai.configure(api_key=os.environ.get("GOOGLE_API_KEY", ""))

app = FastAPI(title="OmniAI — Multimodal AI Studio")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Model aliases ────────────────────────────────────────────────────────────
FLASH   = "gemini-2.0-flash"
FLASH15 = "gemini-1.5-flash"
PRO15   = "gemini-1.5-pro"

def resolve_model(name: str) -> str:
    mapping = {
        "claude-opus-4-8": FLASH, "claude-opus-4-7": FLASH, "claude-opus-4-6": FLASH,
        "claude-sonnet-4-6": FLASH, "claude-fable-5": PRO15,
        "claude-haiku-4-5": FLASH15, "claude-haiku-4-5-20251001": FLASH15,
    }
    return mapping.get(name, name if name.startswith("gemini") else FLASH)


# ── Gemini Files API helpers ─────────────────────────────────────────────────

async def gemini_upload(data, mime_type: str, display_name: str = "") -> genai.types.File:
    loop = asyncio.get_event_loop()
    if isinstance(data, bytes):
        buf = io.BytesIO(data)
        buf.name = display_name or "upload"
        return await loop.run_in_executor(None, lambda: genai.upload_file(buf, mime_type=mime_type, display_name=display_name))
    return await loop.run_in_executor(None, lambda: genai.upload_file(data, mime_type=mime_type, display_name=display_name))


async def gemini_get_file(name: str) -> genai.types.File:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: genai.get_file(name))


async def wait_for_active(file_ref: genai.types.File, timeout: int = 120) -> genai.types.File:
    elapsed = 0
    while file_ref.state.name == "PROCESSING":
        if elapsed >= timeout:
            raise TimeoutError(f"File processing timeout: {file_ref.name}")
        await asyncio.sleep(3)
        elapsed += 3
        file_ref = await gemini_get_file(file_ref.name)
    if file_ref.state.name == "FAILED":
        raise ValueError(f"File processing failed: {file_ref.name}")
    return file_ref


async def gemini_delete(name: str):
    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(None, lambda: genai.delete_file(name))
    except Exception:
        pass


def convert_content_to_parts(content) -> list:
    """Convert Anthropic-format content to Gemini parts (sync, no file fetching)."""
    if isinstance(content, str):
        return [content]
    if not isinstance(content, list):
        return [str(content)]
    parts = []
    seen_files: set[str] = set()
    for block in content:
        if not isinstance(block, dict):
            continue
        btype = block.get("type", "")
        if btype == "text":
            if block.get("text"):
                parts.append(block["text"])
        elif btype == "image":
            source = block.get("source", {})
            stype = source.get("type", "")
            if stype == "file":
                fid = source.get("file_id", "")
                if fid and fid not in seen_files:
                    seen_files.add(fid)
                    try:
                        parts.append(genai.get_file(fid))
                    except Exception:
                        pass
            elif stype == "base64":
                try:
                    img = Image.open(io.BytesIO(base64.b64decode(source.get("data", ""))))
                    parts.append(img)
                except Exception:
                    pass
    return parts or [""]


# ── Streaming helper ─────────────────────────────────────────────────────────

async def gemini_stream(model_name: str, contents, max_tokens: int = 4096, system: str | None = None):
    """Core SSE streaming generator — yields data: lines."""
    m = (genai.GenerativeModel(model_name, system_instruction=system)
         if system else genai.GenerativeModel(model_name))
    cfg = genai.GenerationConfig(max_output_tokens=max_tokens)
    full = ""
    try:
        resp = await m.generate_content_async(contents, generation_config=cfg, stream=True)
        async for chunk in resp:
            try:
                t = chunk.text
                if t:
                    full += t
                    yield f"data: {json.dumps({'type':'text','text':t})}\n\n"
            except Exception:
                pass
    except Exception as e:
        yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"
    return full  # not used directly but keeps pattern clear


async def gemini_stream_json(model_name: str, contents, max_tokens: int = 4096, system: str | None = None):
    """Stream + parse final JSON. Yields text chunks then a 'result' event."""
    m = (genai.GenerativeModel(model_name, system_instruction=system)
         if system else genai.GenerativeModel(model_name))
    cfg = genai.GenerationConfig(max_output_tokens=max_tokens)
    full = ""
    try:
        resp = await m.generate_content_async(contents, generation_config=cfg, stream=True)
        async for chunk in resp:
            try:
                t = chunk.text
                if t:
                    full += t
                    yield f"data: {json.dumps({'type':'text','text':t})}\n\n"
            except Exception:
                pass
        try:
            clean = re.sub(r"```(?:json)?\s*", "", full).strip()
            parsed = json.loads(clean)
            yield f"data: {json.dumps({'type':'result','data':parsed})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type':'parse_error','raw':full[:2000],'error':str(e)})}\n\n"
    except Exception as e:
        yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"
    yield f"data: {json.dumps({'type':'done'})}\n\n"


# ── cv2 / FFmpeg helpers ─────────────────────────────────────────────────────

def extract_frames_cv2(video_path: str, max_frames: int = 20) -> tuple[list, dict]:
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError("Cannot open video file")
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    duration_sec = total_frames / fps if fps > 0 else 0
    step = max(1, total_frames // max_frames)
    frame_indices = list(range(0, total_frames, step))[:max_frames]
    frames_data = []
    for idx in frame_indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ret, frame = cap.read()
        if not ret:
            continue
        h, w = frame.shape[:2]
        if w > 1280:
            scale = 1280 / w
            main_frame = cv2.resize(frame, (1280, int(h * scale)), interpolation=cv2.INTER_AREA)
        else:
            main_frame = frame
        rgb = cv2.cvtColor(main_frame, cv2.COLOR_BGR2RGB)
        buf = io.BytesIO()
        Image.fromarray(rgb).save(buf, format="JPEG", quality=82)
        main_bytes = buf.getvalue()
        thumb = cv2.resize(frame, (160, 90), interpolation=cv2.INTER_AREA)
        thumb_rgb = cv2.cvtColor(thumb, cv2.COLOR_BGR2RGB)
        tbuf = io.BytesIO()
        Image.fromarray(thumb_rgb).save(tbuf, format="JPEG", quality=72)
        frames_data.append((main_bytes, tbuf.getvalue(), idx / fps))
    cap.release()
    return frames_data, {
        "duration_sec": round(duration_sec, 3), "fps": round(fps, 3),
        "total_frames": total_frames, "width": width, "height": height,
    }


def detect_scenes_cv2(video_path: str, threshold: float = 0.35) -> list[dict]:
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    sample_step = max(1, total // 500)
    scenes = []
    prev_hist = None
    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx % sample_step == 0:
            small = cv2.resize(frame, (160, 90))
            hist = cv2.calcHist([small], [0, 1, 2], None, [8, 8, 8], [0, 256, 0, 256, 0, 256])
            hist = cv2.normalize(hist, hist).flatten()
            if prev_hist is not None:
                corr = float(cv2.compareHist(prev_hist, hist, cv2.HISTCMP_CORREL))
                if corr < threshold:
                    scenes.append({
                        "frame": frame_idx, "timestamp_sec": round(frame_idx / fps, 3),
                        "timestamp": sec_to_tc(frame_idx / fps), "correlation": round(corr, 3),
                    })
            prev_hist = hist
        frame_idx += 1
    cap.release()
    return scenes


def detect_motion_energy(video_path: str, max_samples: int = 100) -> list[dict]:
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    step = max(1, total // max_samples)
    energy = []
    prev_gray = None
    idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if idx % step == 0:
            small = cv2.resize(frame, (80, 45))
            gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
            if prev_gray is not None:
                diff = cv2.absdiff(gray, prev_gray)
                energy.append({"t": round(idx / fps, 2), "e": round(float(diff.mean()) / 255.0, 4)})
            prev_gray = gray
        idx += 1
    cap.release()
    return energy


def sec_to_tc(sec: float, srt: bool = False) -> str:
    h = int(sec // 3600); m = int((sec % 3600) // 60); s = sec % 60
    if srt:
        return f"{h:02d}:{m:02d}:{int(s):02d},{int((s%1)*1000):03d}"
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def sec_to_tc_short(sec: float) -> str:
    return f"{int(sec//60)}:{sec%60:05.2f}"


def extract_audio_waveform_ffmpeg(video_path: str, n_samples: int = 300) -> list[float]:
    try:
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", video_path, "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"],
            capture_output=True, timeout=90,
        )
        if not result.stdout:
            return []
        raw = result.stdout
        n_floats = len(raw) // 4
        if n_floats < 4:
            return []
        pcm = struct.unpack(f"{n_floats}f", raw[:n_floats * 4])
        step = max(1, n_floats // n_samples)
        waveform: list[float] = []
        for i in range(0, n_floats, step):
            chunk = pcm[i:i + step]
            rms = math.sqrt(sum(x * x for x in chunk) / len(chunk))
            waveform.append(round(min(1.0, rms * 6), 4))
            if len(waveform) >= n_samples:
                break
        return waveform
    except Exception:
        return []


def ffmpeg_available() -> bool:
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=3)
        return True
    except Exception:
        return False


def tc_to_sec(tc: str) -> float:
    if not tc:
        return 0.0
    try:
        parts = tc.replace(",", ".").split(":")
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    except (IndexError, ValueError):
        return 0.0


def build_edit_filter(decisions: list) -> tuple[str, str]:
    keeps = [d for d in decisions if d.get("action") not in ("CUT", "FADE_IN", "FADE_OUT", "DISSOLVE")]
    if not keeps:
        return "", ""
    segments_v, segments_a = [], []
    valid = 0
    for d in keeps:
        in_s = tc_to_sec(d.get("in_point", "00:00:00.000"))
        out_s = tc_to_sec(d.get("out_point", "00:00:05.000"))
        if out_s <= in_s or (out_s - in_s) < 0.1:
            continue
        speed = max(0.25, min(4.0, float(d.get("speed") or 1.0)))
        vf = f"[0:v]trim={in_s:.3f}:{out_s:.3f},setpts=PTS-STARTPTS"
        if speed != 1.0:
            vf += f",setpts={1/speed:.4f}*PTS"
        vf += f"[v{valid}]"
        segments_v.append(vf)
        af = f"[0:a]atrim={in_s:.3f}:{out_s:.3f},asetpts=PTS-STARTPTS"
        if speed != 1.0 and 0.5 <= speed <= 2.0:
            af += f",atempo={speed:.4f}"
        af += f"[a{valid}]"
        segments_a.append(af)
        valid += 1
    if not segments_v:
        return "", ""
    n = valid
    concat_v = "".join(f"[v{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0[outv_raw]"
    concat_a = "".join(f"[a{i}]" for i in range(n)) + f"concat=n={n}:v=0:a=1[outa]"
    return ";".join(segments_v + segments_a + [concat_v, concat_a]), "[outv_raw][outa]"


def build_color_filter(cg: dict) -> str:
    if not cg:
        return ""
    exposure = float(cg.get("exposure", 0))
    contrast = float(cg.get("contrast", 0))
    saturation = float(cg.get("saturation", 0))
    vibrance = float(cg.get("vibrance", 0))
    highlights = float(cg.get("highlights", 0))
    shadows = float(cg.get("shadows", 0))
    brightness = max(-0.4, min(0.4, exposure / 10.0))
    ffmpeg_contrast = max(0.4, min(2.5, 1.0 + contrast / 100.0))
    ffmpeg_sat = max(0.0, min(2.5, 1.0 + (saturation + vibrance * 0.4) / 100.0))
    parts = [f"eq=brightness={brightness:.3f}:contrast={ffmpeg_contrast:.3f}:saturation={ffmpeg_sat:.3f}"]
    if abs(highlights) > 3 or abs(shadows) > 3:
        sh = max(-0.12, min(0.12, shadows / 100.0 * 0.12))
        hl = max(-0.12, min(0.12, highlights / 100.0 * 0.12))
        p1 = max(0.05, min(0.95, 0.25 + sh))
        p2 = max(0.05, min(0.95, 0.75 + hl))
        parts.append(f"curves=m='0/0 0.25/{p1:.3f} 0.75/{p2:.3f} 1/1'")
    temp = float(cg.get("temperature", 5500))
    if temp < 4800:
        shift = min(0.14, (4800 - temp) / 4800.0 * 0.14)
        parts.append(f"curves=r='0/0 1/{min(1.0,1+shift):.3f}':b='0/0 1/{max(0.72,1-shift):.3f}'")
    elif temp > 6300:
        shift = min(0.1, (temp - 6300) / 6300.0 * 0.1)
        parts.append(f"curves=r='0/0 1/{max(0.82,1-shift):.3f}':b='0/0 1/{min(1.0,1+shift):.3f}'")
    return ",".join(parts)


# ── Pydantic models ───────────────────────────────────────────────────────────

class Message(BaseModel):
    role: str
    content: list | str


class ChatRequest(BaseModel):
    messages: list[Message]
    model: str = FLASH
    enable_thinking: bool = True
    enable_web_search: bool = False
    enable_code_execution: bool = False
    system: str | None = None


class FileUploadResponse(BaseModel):
    file_id: str
    filename: str
    media_type: str


class VideoFrame(BaseModel):
    file_id: str        # Gemini Files API name for the whole video
    timestamp_sec: float
    frame_index: int
    thumbnail_b64: str = ""


class VideoExtractResponse(BaseModel):
    frames: list[VideoFrame]
    duration_sec: float
    fps: float
    total_frames: int
    width: int
    height: int
    filename: str
    scenes: list[dict]
    energy: list[dict]


# ── AI Edit prompt ────────────────────────────────────────────────────────────

AI_EDIT_PROMPT = """You are a world-class video editor with 20 years of experience in Hollywood films, documentaries, and viral content.
You are watching the full video (duration: ~{duration}s).

Your job: produce a COMPLETE, PROFESSIONAL edit package as strict JSON. No prose before or after — ONLY the JSON object.

{{
  "summary": "One-sentence description of the video content",
  "genre": "documentary|interview|vlog|commercial|music_video|tutorial|narrative|other",
  "overall_score": 7,
  "pacing": {{
    "current_cpm": 4.2,
    "recommended_cpm": 8.0,
    "rating": "too_slow|good|too_fast",
    "verdict": "Short note on pacing"
  }},
  "scenes": [
    {{
      "id": 1,
      "title": "Scene title",
      "in_point": "00:00:00.000",
      "out_point": "00:00:08.500",
      "type": "action|dialogue|broll|transition|title|credits",
      "mood": "energetic|calm|tense|emotional|neutral",
      "keep": true,
      "quality_score": 8,
      "notes": "Why this scene works or doesn't"
    }}
  ],
  "edit_decisions": [
    {{
      "action": "CUT|KEEP|TRIM|SPEED|FREEZE|FADE_IN|FADE_OUT|DISSOLVE",
      "in_point": "00:00:00.000",
      "out_point": "00:00:05.000",
      "speed": 1.0,
      "reason": "Specific reason for this edit decision"
    }}
  ],
  "color_grade": {{
    "style": "Cinematic|Natural|Moody|Commercial|Vintage|Cold|Warm",
    "temperature": 5500,
    "tint": 0,
    "exposure": 0.1,
    "contrast": 15,
    "highlights": -25,
    "shadows": 10,
    "whites": 5,
    "blacks": -10,
    "vibrance": 15,
    "saturation": 5,
    "lut_suggestion": "Kodak 5218 / Fuji 3510",
    "davinci_node_order": "Primary Wheels → Custom Curves → Qualifier (skin tone) → Output",
    "premiere_lumetri": "Basic correction → Creative → Color Wheels",
    "reasoning": "Why this color treatment fits the content"
  }},
  "audio": {{
    "silence_sections": [
      {{"start": "00:00:03.0", "end": "00:00:05.0", "remove": true, "reason": "Dead air"}}
    ],
    "music_sync_points": [
      {{"timestamp": "00:00:04.2", "type": "beat_hit|transition|drop|emotion_peak", "note": "Cut here on beat"}}
    ],
    "music_genre_suggestion": "Electronic / Cinematic / Lo-fi",
    "audio_design_notes": "Specific sound design recommendations"
  }},
  "captions": [
    {{"id": 1, "start": "00:00:00,000", "end": "00:00:02,500", "speaker": "Person 1", "text": "Transcribed dialogue"}}
  ],
  "broll_suggestions": [
    {{"at_timecode": "00:00:10.0", "suggestion": "Cutaway to close-up of hands", "reason": "Talking head needs visual relief"}}
  ],
  "motion_graphics": [
    {{"timecode": "00:00:01.0", "type": "lower_third|title_card|callout|logo|end_card", "text": "Suggested overlay text", "duration": 3.0}}
  ],
  "shorts_clip": {{
    "best_start": "00:00:15.000",
    "best_end": "00:00:45.000",
    "hook_text": "Best 6-word hook for thumbnail/caption",
    "vertical_crop": "crop=720:1280:280:0",
    "virality_score": 7
  }},
  "thumbnail": {{
    "best_frame_timestamp": "00:00:12.5",
    "text_overlay": "THUMBNAIL TEXT HERE",
    "composition_notes": "Subject on left third, high contrast background"
  }},
  "ffmpeg_commands": [
    {{
      "label": "Apply color grade",
      "command": "ffmpeg -i INPUT.mp4 -vf \\"eq=brightness=0.05:contrast=1.15:saturation=1.2\\" OUTPUT_graded.mp4"
    }},
    {{
      "label": "Export vertical Shorts (9:16)",
      "command": "ffmpeg -i INPUT.mp4 -vf \\"crop=ih*9/16:ih\\" -ss 00:00:15 -to 00:00:45 SHORTS.mp4"
    }}
  ],
  "social_content": {{
    "youtube_title": "Engaging YouTube title under 60 chars",
    "youtube_description": "3-paragraph YouTube description with timestamps",
    "youtube_tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
    "instagram_caption": "Instagram caption under 220 chars with 5 hashtags",
    "tiktok_hook": "First 3 seconds hook description",
    "twitter_thread": ["Tweet 1/3: hook", "Tweet 2/3: main point", "Tweet 3/3: CTA"],
    "linkedin_post": "Professional LinkedIn post under 300 chars"
  }}
}}

Output ONLY the JSON. No markdown code blocks, no explanation."""


async def stream_ai_edit(
    frame_file_ids: list[str],
    timestamps: list[float],
    model: str,
    duration: float,
    edit_instructions: str = "",
) -> AsyncGenerator[str, None]:
    model_name = resolve_model(model)
    if not frame_file_ids:
        yield f"data: {json.dumps({'type':'error','message':'No video file provided'})}\n\n"
        return

    # All frame_ids are the same Gemini video file name
    video_file_name = frame_file_ids[0]
    try:
        video_file = await gemini_get_file(video_file_name)
        video_file = await wait_for_active(video_file)
    except Exception as e:
        yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"
        return

    prompt = AI_EDIT_PROMPT.format(duration=round(duration, 1))
    if edit_instructions.strip():
        prompt += f"\n\nDirector's additional instructions: {edit_instructions.strip()}\nPrioritize these instructions."

    full_text = ""
    async for line in gemini_stream_json(model_name, [video_file, prompt], max_tokens=8000):
        # Replace 'result' event key for ai-edit compatibility
        if line.startswith("data: "):
            try:
                ev = json.loads(line[6:])
                if ev.get("type") == "text":
                    full_text += ev.get("text", "")
                    yield f"data: {json.dumps({'type':'chunk','text':ev['text']})}\n\n"
                elif ev.get("type") == "result":
                    yield f"data: {json.dumps({'type':'result','data':ev['data']})}\n\n"
                elif ev.get("type") == "parse_error":
                    yield f"data: {json.dumps({'type':'parse_error','raw':full_text,'error':ev.get('error','')})}\n\n"
                elif ev.get("type") == "done":
                    yield f"data: {json.dumps({'type':'done'})}\n\n"
                elif ev.get("type") == "error":
                    yield line
            except Exception:
                yield line
        else:
            yield line


# ── Chat ──────────────────────────────────────────────────────────────────────

async def stream_response(request: ChatRequest) -> AsyncGenerator[str, None]:
    model_name = resolve_model(request.model)
    messages = [{"role": m.role, "content": m.content} for m in request.messages]
    system = request.system or (
        "You are OmniAI, a highly capable multimodal AI assistant. "
        "You understand text, images, documents, video, and code. "
        "Answer concisely and helpfully."
    )

    gemini_history = []
    for msg in messages[:-1]:
        role = "user" if msg["role"] == "user" else "model"
        parts = convert_content_to_parts(msg["content"])
        if parts:
            gemini_history.append({"role": role, "parts": parts})

    last_parts = convert_content_to_parts(messages[-1]["content"]) if messages else [""]

    m = genai.GenerativeModel(model_name, system_instruction=system)
    cfg = genai.GenerationConfig(max_output_tokens=16000)
    chat = m.start_chat(history=gemini_history)
    try:
        resp = await chat.send_message_async(last_parts, generation_config=cfg, stream=True)
        async for chunk in resp:
            try:
                if chunk.text:
                    yield f"data: {json.dumps({'type':'text','text':chunk.text})}\n\n"
            except Exception:
                pass
        yield f"data: {json.dumps({'type':'done','stop_reason':'end_turn'})}\n\n"
    except Exception as e:
        yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "provider": "gemini", "cv2": HAS_CV2}


@app.post("/api/chat")
async def chat(request: ChatRequest):
    return StreamingResponse(
        stream_response(request),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/upload", response_model=FileUploadResponse)
async def upload_file(file: UploadFile = File(...)):
    content = await file.read()
    media_type = file.content_type or "application/octet-stream"
    if len(content) > 32 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 32MB)")
    try:
        uploaded = await gemini_upload(content, media_type, file.filename or "upload")
        return FileUploadResponse(file_id=uploaded.name, filename=file.filename or "", media_type=media_type)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/extract-video-frames")
async def extract_video_frames(
    file: UploadFile = File(...),
    max_frames: int = Form(20),
):
    video_types = {
        "video/mp4", "video/quicktime", "video/x-msvideo",
        "video/x-matroska", "video/webm", "video/mpeg", "video/3gpp", "video/x-flv",
    }
    filename = file.filename or "video.mp4"
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "mp4"
    video_exts = {"mp4", "mov", "avi", "mkv", "webm", "mpeg", "mpg", "3gp", "flv", "m4v"}
    media_type = file.content_type or f"video/{ext}"
    if media_type not in video_types and ext not in video_exts:
        raise HTTPException(status_code=415, detail=f"Not a video file: {media_type}")

    content = await file.read()
    if len(content) > 500 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Video too large (max 500MB)")

    suffix = f".{ext}"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    try:
        # Upload entire video to Gemini Files API
        video_file = await gemini_upload(content, media_type, filename)

        # Extract thumbnails with cv2 for filmstrip UI
        frames_data, meta = [], {"duration_sec": 0, "fps": 25.0, "total_frames": 0, "width": 0, "height": 0}
        scenes, energy, audio_waveform = [], [], []
        if HAS_CV2:
            try:
                max_frames = min(max(1, max_frames), 30)
                frames_data, meta = extract_frames_cv2(tmp_path, max_frames)
                scenes = detect_scenes_cv2(tmp_path)
                energy = detect_motion_energy(tmp_path)
            except Exception:
                pass
        if ffmpeg_available():
            audio_waveform = extract_audio_waveform_ffmpeg(tmp_path)
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass

    # Build frames array — all share the same Gemini video file name
    video_frames = []
    if frames_data:
        for i, (_, thumb_bytes, ts) in enumerate(frames_data):
            thumb_b64 = "data:image/jpeg;base64," + base64.b64encode(thumb_bytes).decode()
            video_frames.append(VideoFrame(
                file_id=video_file.name,
                timestamp_sec=round(ts, 2),
                frame_index=i,
                thumbnail_b64=thumb_b64,
            ))
    else:
        # No cv2 — create a single placeholder frame entry
        video_frames.append(VideoFrame(
            file_id=video_file.name,
            timestamp_sec=0.0,
            frame_index=0,
            thumbnail_b64="",
        ))

    return {
        "frames": [f.dict() for f in video_frames],
        "filename": filename,
        "scenes": scenes,
        "energy": energy,
        "audio_waveform": audio_waveform,
        **meta,
    }


@app.post("/api/ai-edit")
async def ai_edit(
    frame_ids: str = Form(...),
    timestamps: str = Form(...),
    model: str = Form(FLASH),
    duration: float = Form(0),
    edit_instructions: str = Form(""),
):
    try:
        ids = json.loads(frame_ids)
        ts = json.loads(timestamps)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="Invalid JSON")
    if not ids:
        raise HTTPException(status_code=422, detail="No frames")

    return StreamingResponse(
        stream_ai_edit(ids, ts, model, duration, edit_instructions),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/export-srt")
async def export_srt(captions: str = Form(...), filename: str = Form("subtitles")):
    try:
        caps = json.loads(captions)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="Invalid captions JSON")
    lines = []
    for i, c in enumerate(caps, 1):
        lines += [str(i), f"{c.get('start','00:00:00,000')} --> {c.get('end','00:00:02,000')}",
                  f"{'['+c['speaker']+'] ' if c.get('speaker') else ''}{c.get('text','')}", ""]
    return Response(content="\n".join(lines), media_type="text/plain",
                    headers={"Content-Disposition": f'attachment; filename="{filename}.srt"'})


@app.post("/api/export-edl")
async def export_edl(edit_decisions: str = Form(...), filename: str = Form("edit"), fps: float = Form(25.0)):
    try:
        decisions = json.loads(edit_decisions)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="Invalid JSON")
    lines = ["TITLE: OmniAI Edit", "FCM: NON-DROP FRAME", ""]
    event_num = 1
    for d in decisions:
        if d.get("action") in ("KEEP", "TRIM", "SPEED"):
            in_tc = d.get("in_point", "00:00:00.000").replace(".", ":")
            out_tc = d.get("out_point", "00:00:05.000").replace(".", ":")
            lines.append(f"{event_num:03d}  AX  V     C        {in_tc} {out_tc} {in_tc} {out_tc}")
            if d.get("reason"):
                lines.append(f"* FROM CLIP NAME: {d['reason'][:60]}")
            lines.append("")
            event_num += 1
    return Response(content="\n".join(lines), media_type="text/plain",
                    headers={"Content-Disposition": f'attachment; filename="{filename}.edl"'})


@app.post("/api/export-ffmpeg-script")
async def export_ffmpeg_script(commands: str = Form(...), filename: str = Form("edit_script")):
    try:
        cmds = json.loads(commands)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="Invalid JSON")
    lines = [
        "#!/bin/bash", "# OmniAI — Auto-generated FFmpeg Edit Script",
        "# Replace INPUT.mp4 with your actual video file", "",
        'INPUT="$1"', 'if [ -z "$INPUT" ]; then',
        '  echo "Usage: ./edit_script.sh your_video.mp4"', "  exit 1", "fi", "",
    ]
    for i, cmd in enumerate(cmds, 1):
        label = cmd.get("label", f"Step {i}")
        command = cmd.get("command", "").replace("INPUT.mp4", '"$INPUT"')
        lines += [f"# Step {i}: {label}", command, ""]
    return Response(content="\n".join(lines), media_type="text/plain",
                    headers={"Content-Disposition": f'attachment; filename="{filename}.sh"'})


@app.delete("/api/files/{file_id:path}")
async def delete_file(file_id: str):
    await gemini_delete(file_id)
    return {"deleted": file_id}


@app.post("/api/process-video")
async def process_video(
    file: UploadFile = File(...),
    operation: str = Form(...),
    params: str = Form("{}"),
    edit_data: str = Form("{}"),
):
    if not ffmpeg_available():
        raise HTTPException(status_code=503, detail="FFmpeg not available in this environment")
    try:
        params_dict = json.loads(params)
        edit_dict = json.loads(edit_data)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="Invalid JSON params")

    content = await file.read()
    ext = (file.filename or "video.mp4").rsplit(".", 1)[-1].lower()
    in_path = tempfile.mktemp(suffix=f".{ext}")
    out_path = tempfile.mktemp(suffix=f"_out.{ext}")

    with open(in_path, "wb") as f:
        f.write(content)

    cmd = None
    out_name = f"omni_{operation}.{ext}"

    try:
        if operation == "color_grade":
            cg = edit_dict.get("color_grade", {})
            vf = build_color_filter(cg)
            if not vf:
                vf = "eq=brightness=0:contrast=1:saturation=1"
            cmd = ["ffmpeg", "-y", "-i", in_path, "-vf", vf, "-c:a", "aac", out_path]

        elif operation == "apply_cuts":
            decisions = edit_dict.get("edit_decisions", [])
            fc, maps = build_edit_filter(decisions)
            if fc and maps:
                cmd = ["ffmpeg", "-y", "-i", in_path, "-filter_complex", fc,
                       "-map", "[outv_raw]", "-map", "[outa]",
                       "-c:v", "libx264", "-preset", "fast", "-c:a", "aac", out_path]
            else:
                cmd = ["ffmpeg", "-y", "-i", in_path, "-c", "copy", out_path]

        elif operation == "export_shorts":
            sc = edit_dict.get("shorts_clip", {})
            start = sc.get("best_start", "00:00:00.000")
            end = sc.get("best_end", "00:00:30.000")
            out_path = out_path.replace(f".{ext}", ".mp4")
            out_name = "shorts.mp4"
            cmd = ["ffmpeg", "-y", "-i", in_path, "-ss", start, "-to", end,
                   "-vf", "crop=ih*9/16:ih", "-c:v", "libx264", "-preset", "fast",
                   "-c:a", "aac", out_path]

        elif operation == "burn_srt":
            srt_content = params_dict.get("srt", "")
            srt_path = tempfile.mktemp(suffix=".srt")
            with open(srt_path, "w", encoding="utf-8") as sf:
                sf.write(srt_content)
            cmd = ["ffmpeg", "-y", "-i", in_path,
                   "-vf", f"subtitles={srt_path}:force_style='FontSize=20,PrimaryColour=&Hffffff'",
                   "-c:a", "aac", out_path]

        elif operation == "remove_silences":
            silences = params_dict.get("silences", [])
            if not silences:
                cmd = ["ffmpeg", "-y", "-i", in_path, "-c", "copy", out_path]
            else:
                keeps = []
                prev_end = 0.0
                duration_total = params_dict.get("duration", 3600.0)
                for s in sorted(silences, key=lambda x: x.get("start", 0)):
                    s_start = float(s.get("start", 0))
                    s_end = float(s.get("end", 0))
                    if s_start > prev_end + 0.05:
                        keeps.append({"action": "KEEP", "in_point": sec_to_tc(prev_end), "out_point": sec_to_tc(s_start)})
                    prev_end = s_end
                if prev_end < duration_total - 0.05:
                    keeps.append({"action": "KEEP", "in_point": sec_to_tc(prev_end), "out_point": sec_to_tc(duration_total)})
                fc, maps = build_edit_filter(keeps)
                if fc and maps:
                    cmd = ["ffmpeg", "-y", "-i", in_path, "-filter_complex", fc,
                           "-map", "[outv_raw]", "-map", "[outa]",
                           "-c:v", "libx264", "-preset", "fast", "-c:a", "aac", out_path]
                else:
                    cmd = ["ffmpeg", "-y", "-i", in_path, "-c", "copy", out_path]

        elif operation == "aspect_ratio":
            ratio = params_dict.get("ratio", "16:9")
            ratio_map = {"16:9": "iw:iw*9/16", "9:16": "ih*9/16:ih", "1:1": "min(iw\\,ih):min(iw\\,ih)", "4:3": "iw:iw*3/4"}
            crop = ratio_map.get(ratio, "iw:iw*9/16")
            cmd = ["ffmpeg", "-y", "-i", in_path, "-vf", f"crop={crop}", "-c:a", "aac", out_path]

        elif operation == "highlight_reel":
            clips = params_dict.get("clips", [])
            if not clips:
                raise HTTPException(status_code=422, detail="No highlight clips provided")
            fc, maps = build_edit_filter(clips)
            if fc and maps:
                cmd = ["ffmpeg", "-y", "-i", in_path, "-filter_complex", fc,
                       "-map", "[outv_raw]", "-map", "[outa]",
                       "-c:v", "libx264", "-preset", "fast", "-c:a", "aac", out_path]
            else:
                cmd = ["ffmpeg", "-y", "-i", in_path, "-c", "copy", out_path]

        else:
            cmd = ["ffmpeg", "-y", "-i", in_path, "-c", "copy", out_path]

        if cmd:
            result = subprocess.run(cmd, capture_output=True, timeout=300)
            if result.returncode != 0:
                raise HTTPException(status_code=500, detail=f"FFmpeg error: {result.stderr.decode()[-500:]}")

        with open(out_path, "rb") as f:
            output_bytes = f.read()

        return Response(
            content=output_bytes,
            media_type="video/mp4",
            headers={"Content-Disposition": f'attachment; filename="{out_name}"'},
        )
    finally:
        for p in [in_path, out_path]:
            try:
                os.unlink(p)
            except Exception:
                pass


@app.post("/api/extract-thumbnail")
async def extract_thumbnail(file: UploadFile = File(...), timestamp: float = Form(0.0)):
    if not HAS_CV2:
        raise HTTPException(status_code=503, detail="Thumbnail extraction unavailable in this environment")
    content = await file.read()
    ext = (file.filename or "video.mp4").rsplit(".", 1)[-1].lower()
    tmp = tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False)
    tmp.write(content)
    tmp.close()
    try:
        cap = cv2.VideoCapture(tmp.name)
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(timestamp * fps))
        ret, frame = cap.read()
        cap.release()
        if not ret:
            raise HTTPException(status_code=404, detail="Frame not found at timestamp")
        h, w = frame.shape[:2]
        if w > 1920:
            scale = 1920 / w
            frame = cv2.resize(frame, (1920, int(h * scale)), interpolation=cv2.INTER_LANCZOS4)
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        buf = io.BytesIO()
        Image.fromarray(rgb).save(buf, format="JPEG", quality=92)
        return Response(content=buf.getvalue(), media_type="image/jpeg",
                        headers={"Content-Disposition": "attachment; filename=\"thumbnail.jpg\""})
    finally:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass


@app.post("/api/translate-captions")
async def translate_captions(
    captions: str = Form(...),
    target_language: str = Form("Hebrew"),
    model: str = Form(FLASH),
):
    try:
        caps = json.loads(captions)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="Invalid captions JSON")

    model_name = resolve_model(model)
    prompt = (
        f"Translate these captions to {target_language}. "
        "Return ONLY a JSON array with the exact same structure but with the 'text' field translated. "
        "Preserve all other fields exactly. No markdown, no explanation.\n\n"
        f"{json.dumps(caps)}"
    )

    async def _stream():
        full = ""
        async for line in gemini_stream(model_name, prompt, max_tokens=4000):
            if line.startswith("data: "):
                try:
                    ev = json.loads(line[6:])
                    if ev.get("type") == "text":
                        full += ev.get("text", "")
                except Exception:
                    pass
            yield line
        try:
            clean = re.sub(r"```(?:json)?\s*", "", full).strip()
            parsed = json.loads(clean)
            yield f"data: {json.dumps({'type':'result','captions':parsed})}\n\n"
        except Exception:
            pass

    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/video-search")
async def video_search(
    frame_ids: str = Form(...),
    timestamps: str = Form(...),
    query: str = Form(...),
    model: str = Form(FLASH),
):
    try:
        ids = json.loads(frame_ids)
        ts = json.loads(timestamps)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="Invalid JSON")

    model_name = resolve_model(model)
    if not ids:
        raise HTTPException(status_code=422, detail="No frames")

    try:
        video_file = await gemini_get_file(ids[0])
        video_file = await wait_for_active(video_file)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    prompt = (
        f"Watch this video and search for: '{query}'\n\n"
        "Return ONLY a JSON array of matching timestamps:\n"
        '[{"timestamp": "00:00:05.2", "description": "What is happening that matches the query"}]'
    )

    async def _stream():
        async for line in gemini_stream_json(model_name, [video_file, prompt], max_tokens=2000):
            yield line

    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/burn-subtitles")
async def burn_subtitles(file: UploadFile = File(...), srt_content: str = Form(...)):
    if not ffmpeg_available():
        raise HTTPException(status_code=503, detail="FFmpeg not available")
    content = await file.read()
    ext = (file.filename or "video.mp4").rsplit(".", 1)[-1].lower()
    in_path = tempfile.mktemp(suffix=f".{ext}")
    out_path = tempfile.mktemp(suffix="_subtitled.mp4")
    srt_path = tempfile.mktemp(suffix=".srt")
    with open(in_path, "wb") as f:
        f.write(content)
    with open(srt_path, "w", encoding="utf-8") as f:
        f.write(srt_content)
    try:
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", in_path,
             "-vf", f"subtitles={srt_path}:force_style='FontSize=20,PrimaryColour=&Hffffff'",
             "-c:a", "aac", out_path],
            capture_output=True, timeout=300,
        )
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=f"FFmpeg error: {result.stderr.decode()[-300:]}")
        with open(out_path, "rb") as f:
            return Response(content=f.read(), media_type="video/mp4",
                            headers={"Content-Disposition": "attachment; filename=\"subtitled.mp4\""})
    finally:
        for p in [in_path, out_path, srt_path]:
            try:
                os.unlink(p)
            except Exception:
                pass


@app.post("/api/remove-silences")
async def remove_silences_endpoint(
    file: UploadFile = File(...),
    silences: str = Form(...),
    duration: float = Form(0),
):
    if not ffmpeg_available():
        raise HTTPException(status_code=503, detail="FFmpeg not available")
    try:
        silence_list = json.loads(silences)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="Invalid silences JSON")
    content = await file.read()
    ext = (file.filename or "video.mp4").rsplit(".", 1)[-1].lower()
    in_path = tempfile.mktemp(suffix=f".{ext}")
    out_path = tempfile.mktemp(suffix=f"_no_silence.{ext}")
    with open(in_path, "wb") as f:
        f.write(content)
    try:
        keeps = []
        prev_end = 0.0
        for s in sorted(silence_list, key=lambda x: x.get("start", 0)):
            s_start = float(s.get("start", 0))
            s_end = float(s.get("end", 0))
            if s_start > prev_end + 0.05:
                keeps.append({"action": "KEEP", "in_point": sec_to_tc(prev_end), "out_point": sec_to_tc(s_start)})
            prev_end = s_end
        if prev_end < duration - 0.05:
            keeps.append({"action": "KEEP", "in_point": sec_to_tc(prev_end), "out_point": sec_to_tc(duration)})
        fc, maps = build_edit_filter(keeps)
        if fc and maps:
            cmd = ["ffmpeg", "-y", "-i", in_path, "-filter_complex", fc,
                   "-map", "[outv_raw]", "-map", "[outa]",
                   "-c:v", "libx264", "-preset", "fast", "-c:a", "aac", out_path]
        else:
            cmd = ["ffmpeg", "-y", "-i", in_path, "-c", "copy", out_path]
        result = subprocess.run(cmd, capture_output=True, timeout=300)
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=f"FFmpeg: {result.stderr.decode()[-300:]}")
        with open(out_path, "rb") as f:
            return Response(content=f.read(), media_type="video/mp4",
                            headers={"Content-Disposition": "attachment; filename=\"no_silence.mp4\""})
    finally:
        for p in [in_path, out_path]:
            try:
                os.unlink(p)
            except Exception:
                pass


@app.post("/api/highlight-reel")
async def highlight_reel(
    frame_ids: str = Form(...),
    timestamps: str = Form(...),
    model: str = Form(FLASH),
    duration: float = Form(0),
    target_duration: float = Form(60),
):
    try:
        ids = json.loads(frame_ids)
        ts = json.loads(timestamps)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="Invalid JSON")

    model_name = resolve_model(model)
    if not ids:
        raise HTTPException(status_code=422, detail="No frames")

    try:
        video_file = await gemini_get_file(ids[0])
        video_file = await wait_for_active(video_file)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    prompt = (
        f"Watch this video (total {round(duration,1)}s) and select the best clips for a highlight reel "
        f"of approximately {target_duration} seconds.\n\n"
        "Return ONLY a JSON array of clip segments:\n"
        '[{"action":"KEEP","in_point":"00:00:05.000","out_point":"00:00:15.000","reason":"Most engaging moment"}]'
    )

    async def _stream():
        async for line in gemini_stream_json(model_name, [video_file, prompt], max_tokens=3000):
            yield line

    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/generate-voiceover")
async def generate_voiceover(
    frame_ids: str = Form(...),
    timestamps: str = Form(...),
    model: str = Form(FLASH),
    duration: float = Form(0),
    style: str = Form("documentary"),
):
    try:
        ids = json.loads(frame_ids)
        ts = json.loads(timestamps)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="Invalid JSON")

    model_name = resolve_model(model)
    if not ids:
        raise HTTPException(status_code=422, detail="No frames")

    try:
        video_file = await gemini_get_file(ids[0])
        video_file = await wait_for_active(video_file)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    prompt = (
        f"Watch this {round(duration,1)}-second video and write a professional voiceover script "
        f"in {style} style.\n\n"
        "Return ONLY JSON:\n"
        '{"script": [{"timecode": "00:00:00.0", "duration": 4.0, "text": "Voiceover line"}], '
        '"full_script": "Complete narration text", "word_count": 150}'
    )

    async def _stream():
        async for line in gemini_stream_json(model_name, [video_file, prompt], max_tokens=3000):
            yield line

    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Image Studio ─────────────────────────────────────────────────────────────

IMAGE_ANALYSIS_PROMPT = """You are a world-class visual intelligence system combining photography expertise, computer vision, and AI art direction.
Analyze this image with extreme depth and detail. Return ONLY this JSON (no markdown fences):

{
  "description": "Rich, detailed 3-5 sentence description of the entire image",
  "main_subject": "The primary subject of the image",
  "objects": ["List", "of", "every", "identifiable", "object"],
  "people": {
    "count": 0,
    "descriptions": ["Person 1: age estimate, gender, clothing, expression, action"],
    "emotions": ["dominant emotions visible"]
  },
  "text_in_image": "Any visible text, signs, labels, or captions — exact transcription",
  "colors": {
    "dominant": ["#hex1 — color name", "#hex2 — color name", "#hex3 — color name"],
    "palette_mood": "warm|cool|neutral|vibrant|muted|monochromatic",
    "background": "Description of background colors and texture"
  },
  "composition": {
    "rule_of_thirds": "How the image uses rule of thirds",
    "leading_lines": "Any leading lines or geometric patterns",
    "depth": "shallow_dof|deep_focus|bokeh",
    "framing": "How subjects are framed",
    "symmetry": "Any symmetry or balance"
  },
  "technical": {
    "estimated_camera": "Type of camera/lens likely used",
    "focal_length": "Estimated focal length (e.g. 50mm)",
    "aperture_est": "f/1.8",
    "iso_est": "ISO 400",
    "shutter_speed_est": "1/500s",
    "lighting": "natural|artificial|mixed — direction and quality",
    "time_of_day": "golden_hour|midday|overcast|night|indoor",
    "quality_score": 8
  },
  "scene_context": {
    "setting": "Where this was taken",
    "occasion": "What event or situation this depicts",
    "mood": "Overall emotional atmosphere",
    "story": "The implied narrative or story of the image"
  },
  "tags": ["descriptive", "searchable", "tags", "list", "12-15", "tags"],
  "ai_regeneration_prompt": "Complete, detailed prompt to recreate this image with DALL-E/Midjourney/Stable Diffusion",
  "strengths": ["What this image does well photographically"],
  "improvements": ["Specific suggestions to improve the composition/exposure/etc"]
}"""


@app.post("/api/analyze-image")
async def analyze_image(file: UploadFile = File(...), model: str = Form(FLASH)):
    content = await file.read()
    media_type = file.content_type or "image/jpeg"
    model_name = resolve_model(model)

    file_ref = await gemini_upload(content, media_type, file.filename or "image")

    async def _stream():
        try:
            file_obj = await gemini_get_file(file_ref.name)
            async for line in gemini_stream_json(model_name, [file_obj, IMAGE_ANALYSIS_PROMPT], max_tokens=4000):
                if '"type":"result"' in line or '"type": "result"' in line:
                    try:
                        ev = json.loads(line[6:])
                        yield f"data: {json.dumps({'type':'result','data':ev['data'],'file_id':file_ref.name})}\n\n"
                    except Exception:
                        yield line
                else:
                    yield line
        except Exception as e:
            yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"

    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/image-chat")
async def image_chat(
    file_id: str = Form(...),
    messages: str = Form(...),
    model: str = Form(FLASH),
):
    try:
        msgs = json.loads(messages)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="Invalid messages JSON")
    model_name = resolve_model(model)

    try:
        image_file = await gemini_get_file(file_id)
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"Image file not found: {e}")

    gemini_history = []
    for msg in msgs[:-1]:
        role = "user" if msg["role"] == "user" else "model"
        gemini_history.append({"role": role, "parts": [msg.get("content", "")]})

    last_msg = msgs[-1].get("content", "") if msgs else ""
    if not gemini_history:
        last_content = [image_file, "Analyze this image.", last_msg]
    else:
        last_content = [last_msg]

    m = genai.GenerativeModel(model_name, system_instruction="You are an expert image analyst. Answer questions about the provided image accurately and in detail.")
    chat = m.start_chat(history=gemini_history)

    async def _stream():
        try:
            resp = await chat.send_message_async(last_content, stream=True)
            async for chunk in resp:
                try:
                    if chunk.text:
                        yield f"data: {json.dumps({'type':'text','text':chunk.text})}\n\n"
                except Exception:
                    pass
            yield f"data: {json.dumps({'type':'done'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"

    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Image Compare ────────────────────────────────────────────────────────────

@app.post("/api/compare-images")
async def compare_images(
    files: List[UploadFile] = File(...),
    prompt: str = Form("Compare these images in detail."),
    model: str = Form(FLASH),
):
    model_name = resolve_model(model)
    parts = [prompt]
    file_refs = []
    for i, f in enumerate(files[:4]):
        content = await f.read()
        mt = f.content_type or "image/jpeg"
        fref = await gemini_upload(content, mt, f.filename or f"image_{i}")
        fobj = await gemini_get_file(fref.name)
        parts = [fobj] + parts
        file_refs.append(fref.name)

    async def _stream():
        full = ""
        try:
            m = genai.GenerativeModel(model_name)
            cfg = genai.GenerationConfig(max_output_tokens=4000)
            resp = await m.generate_content_async(parts, generation_config=cfg, stream=True)
            async for chunk in resp:
                try:
                    if chunk.text:
                        full += chunk.text
                        yield f"data: {json.dumps({'type':'text','text':chunk.text})}\n\n"
                except Exception:
                    pass
        except Exception as e:
            yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"
        yield f"data: {json.dumps({'type':'done','result':full})}\n\n"

    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Live Frame ────────────────────────────────────────────────────────────────

@app.post("/api/live-frame")
async def live_frame(
    image: str = Form(...),
    model: str = Form(FLASH15),
):
    model_name = resolve_model(model)
    try:
        header, b64data = image.split(",", 1)
        media_type = header.split(":")[1].split(";")[0]
        img_bytes = base64.b64decode(b64data)
        img = Image.open(io.BytesIO(img_bytes))
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Invalid image data: {e}")

    prompt = "Describe what you see in this camera frame in 1-2 concise sentences. Focus on the main subject, action, and setting."

    async def _stream():
        full = ""
        try:
            m = genai.GenerativeModel(model_name)
            cfg = genai.GenerationConfig(max_output_tokens=300)
            resp = await m.generate_content_async([img, prompt], generation_config=cfg, stream=True)
            async for chunk in resp:
                try:
                    if chunk.text:
                        full += chunk.text
                        yield f"data: {json.dumps({'type':'text','text':chunk.text})}\n\n"
                except Exception:
                    pass
        except Exception as e:
            yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"
        yield f"data: {json.dumps({'type':'done','result':full})}\n\n"

    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Audio Studio ─────────────────────────────────────────────────────────────

AUDIO_ANALYSIS_PROMPT = """You are a world-class audio intelligence system combining speech analysis, music theory, and audio engineering expertise.
Analyze this audio and return ONLY this JSON (no markdown fences):

{
  "type": "speech|music|ambient|mixed|podcast|interview",
  "language": "Detected language",
  "duration_estimate": "Approximate duration in seconds",
  "transcript": "Full verbatim transcript — every word spoken",
  "summary": "3-5 sentence summary of the audio content",
  "speakers": [
    {"id": "Speaker 1", "gender": "male|female|unknown", "accent": "accent description", "speaking_time_pct": 60, "tone": "confident|nervous|authoritative|conversational"}
  ],
  "chapters": [
    {"title": "Chapter/Topic title", "start_estimate": "~00:00", "end_estimate": "~02:30", "summary": "What happens in this section"}
  ],
  "key_quotes": [
    {"quote": "Exact quote", "speaker": "Speaker 1", "significance": "Why this is notable"}
  ],
  "topics": ["main topic", "secondary topic", "tertiary topic"],
  "sentiment": {"overall": "positive|negative|neutral|mixed", "score": 7, "explanation": "Why"},
  "audio_quality": {"score": 8, "background_noise": "none|low|medium|high", "clarity": "excellent|good|fair|poor", "issues": ["any audio issues"]},
  "music_analysis": {"present": false, "genre": "", "tempo_bpm": 0, "key": "", "instruments": [], "mood": ""},
  "action_items": ["Any tasks or next steps mentioned"],
  "keywords": ["important", "keywords", "mentioned"]
}"""


@app.post("/api/analyze-audio")
async def analyze_audio(file: UploadFile = File(...), model: str = Form(FLASH)):
    content = await file.read()
    media_type = file.content_type or "audio/mpeg"
    model_name = resolve_model(model)

    file_ref = await gemini_upload(content, media_type, file.filename or "audio")
    file_obj = await wait_for_active(file_ref)

    async def _stream():
        try:
            async for line in gemini_stream_json(model_name, [file_obj, AUDIO_ANALYSIS_PROMPT], max_tokens=5000):
                if '"type":"result"' in line or '"type": "result"' in line:
                    try:
                        ev = json.loads(line[6:])
                        yield f"data: {json.dumps({'type':'result','data':ev['data'],'file_id':file_ref.name})}\n\n"
                    except Exception:
                        yield line
                else:
                    yield line
        except Exception as e:
            yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"

    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/audio-chat")
async def audio_chat(
    file_id: str = Form(...),
    messages: str = Form(...),
    model: str = Form(FLASH),
):
    try:
        msgs = json.loads(messages)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="Invalid messages JSON")
    model_name = resolve_model(model)

    try:
        audio_file = await gemini_get_file(file_id)
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))

    gemini_history = []
    for msg in msgs[:-1]:
        role = "user" if msg["role"] == "user" else "model"
        gemini_history.append({"role": role, "parts": [msg.get("content", "")]})

    last_msg = msgs[-1].get("content", "") if msgs else ""
    last_content = [audio_file, "Answer questions about this audio.", last_msg] if not gemini_history else [last_msg]

    m = genai.GenerativeModel(model_name, system_instruction="You are an expert audio analyst. Answer questions about the provided audio accurately.")
    chat = m.start_chat(history=gemini_history)

    async def _stream():
        try:
            resp = await chat.send_message_async(last_content, stream=True)
            async for chunk in resp:
                try:
                    if chunk.text:
                        yield f"data: {json.dumps({'type':'text','text':chunk.text})}\n\n"
                except Exception:
                    pass
            yield f"data: {json.dumps({'type':'done'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"

    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Document IQ ───────────────────────────────────────────────────────────────

DOCUMENT_ANALYSIS_PROMPT = """You are a world-class document intelligence system. Extract every meaningful piece of information from this document.
Return ONLY this JSON (no markdown fences):

{
  "title": "Document title or best guess",
  "document_type": "contract|report|research_paper|article|manual|legal|invoice|letter|other",
  "author": "Author(s) if identifiable",
  "date": "Date if present",
  "language": "Primary language",
  "page_count_estimate": 1,
  "executive_summary": "3-5 sentence executive summary capturing the most important points",
  "key_sections": [
    {"title": "Section name", "summary": "What this section covers", "key_points": ["point 1", "point 2"]}
  ],
  "entities": {
    "people": ["Name — Role/context"],
    "organizations": ["Org name — context"],
    "locations": ["Location — context"],
    "dates": ["Date — what happened"],
    "monetary_values": ["Amount — context"],
    "legal_references": ["Law/regulation — context"]
  },
  "key_facts": ["Specific factual claim 1", "Specific factual claim 2"],
  "data_tables": [
    {"title": "Table name", "headers": ["col1", "col2"], "rows": [["val1", "val2"]], "insights": "What this data shows"}
  ],
  "action_items": ["Tasks or obligations mentioned"],
  "deadlines": ["Date — what is due"],
  "definitions": [{"term": "Technical term", "definition": "Plain-language explanation"}],
  "risks_concerns": ["Any risks, warnings, or red flags"],
  "conclusions": ["Main conclusions or recommendations"],
  "sentiment": "positive|negative|neutral|mixed",
  "readability_score": 7,
  "keywords": ["important", "keywords"],
  "tags": ["category", "tags"]
}"""


@app.post("/api/analyze-document")
async def analyze_document(file: UploadFile = File(...), model: str = Form(FLASH)):
    content = await file.read()
    media_type = file.content_type or "application/pdf"
    model_name = resolve_model(model)

    file_ref = await gemini_upload(content, media_type, file.filename or "document")
    file_obj = await wait_for_active(file_ref)

    async def _stream():
        try:
            async for line in gemini_stream_json(model_name, [file_obj, DOCUMENT_ANALYSIS_PROMPT], max_tokens=6000):
                if '"type":"result"' in line or '"type": "result"' in line:
                    try:
                        ev = json.loads(line[6:])
                        yield f"data: {json.dumps({'type':'result','data':ev['data'],'file_id':file_ref.name})}\n\n"
                    except Exception:
                        yield line
                else:
                    yield line
        except Exception as e:
            yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"

    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/document-chat")
async def document_chat(
    file_id: str = Form(...),
    messages: str = Form(...),
    model: str = Form(FLASH),
):
    try:
        msgs = json.loads(messages)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="Invalid messages JSON")
    model_name = resolve_model(model)

    try:
        doc_file = await gemini_get_file(file_id)
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))

    gemini_history = []
    for msg in msgs[:-1]:
        role = "user" if msg["role"] == "user" else "model"
        gemini_history.append({"role": role, "parts": [msg.get("content", "")]})

    last_msg = msgs[-1].get("content", "") if msgs else ""
    last_content = [doc_file, "Answer questions about this document.", last_msg] if not gemini_history else [last_msg]

    m = genai.GenerativeModel(model_name, system_instruction="You are an expert document analyst. Answer questions about the provided document accurately and cite specific sections when relevant.")
    chat = m.start_chat(history=gemini_history)

    async def _stream():
        try:
            resp = await chat.send_message_async(last_content, stream=True)
            async for chunk in resp:
                try:
                    if chunk.text:
                        yield f"data: {json.dumps({'type':'text','text':chunk.text})}\n\n"
                except Exception:
                    pass
            yield f"data: {json.dumps({'type':'done'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"

    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Data Studio ───────────────────────────────────────────────────────────────

DATA_ANALYSIS_PROMPT = """You are a world-class data scientist and analyst. Analyze this dataset and return ONLY this JSON (no markdown fences):

{
  "dataset_overview": {
    "rows": 150,
    "columns": 5,
    "column_names": ["col1", "col2"],
    "data_types": {"col1": "numeric", "col2": "categorical"},
    "missing_values": {"col1": 0},
    "file_size_description": "Small dataset"
  },
  "executive_summary": "3-5 sentence summary of what this data represents and key findings",
  "key_insights": [
    {"insight": "Specific finding", "significance": "Why it matters", "confidence": "high|medium|low"}
  ],
  "statistics": {
    "numeric_columns": {
      "column_name": {
        "mean": 45.2, "median": 42.0, "std": 12.3, "min": 10.0, "max": 100.0,
        "q25": 35.0, "q75": 55.0, "outliers_count": 3
      }
    },
    "categorical_columns": {
      "column_name": {"unique_values": 5, "most_common": "value (30%)", "distribution": {"val1": 30, "val2": 20}}
    }
  },
  "correlations": [
    {"columns": ["col1", "col2"], "strength": "strong|moderate|weak", "direction": "positive|negative", "insight": "What this means"}
  ],
  "trends": [
    {"description": "Trend description", "columns_involved": ["col1"], "direction": "increasing|decreasing|cyclical"}
  ],
  "anomalies": [
    {"description": "Anomaly description", "affected_rows": "~5%", "severity": "high|medium|low"}
  ],
  "recommended_charts": [
    {"type": "bar|line|scatter|histogram|pie|heatmap", "columns": ["x_col", "y_col"], "title": "Chart title", "insight": "What this shows"}
  ],
  "data_quality": {
    "score": 8,
    "issues": ["Missing values in col3", "Potential duplicates"],
    "recommendations": ["Fill missing values with median", "Remove duplicates"]
  },
  "business_recommendations": [
    {"recommendation": "Actionable recommendation", "priority": "high|medium|low", "expected_impact": "Impact description"}
  ],
  "next_analyses": ["Suggested follow-up analyses to perform"]
}"""


@app.post("/api/analyze-data")
async def analyze_data(file: UploadFile = File(...), model: str = Form(FLASH)):
    content = await file.read()
    media_type = file.content_type or "text/csv"
    filename = file.filename or "data.csv"
    model_name = resolve_model(model)

    # Send as text for small files, use Files API for larger ones
    text_content = content.decode("utf-8", errors="replace")[:50000]
    prompt = f"Dataset filename: {filename}\n\nContent:\n{text_content}\n\n{DATA_ANALYSIS_PROMPT}"

    file_ref = await gemini_upload(content, media_type, filename)

    async def _stream():
        try:
            async for line in gemini_stream_json(model_name, prompt, max_tokens=5000):
                if '"type":"result"' in line or '"type": "result"' in line:
                    try:
                        ev = json.loads(line[6:])
                        yield f"data: {json.dumps({'type':'result','data':ev['data'],'file_id':file_ref.name})}\n\n"
                    except Exception:
                        yield line
                else:
                    yield line
        except Exception as e:
            yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"

    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/data-chat")
async def data_chat(
    file_id: str = Form(...),
    messages: str = Form(...),
    model: str = Form(FLASH),
):
    try:
        msgs = json.loads(messages)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="Invalid messages JSON")
    model_name = resolve_model(model)

    try:
        data_file = await gemini_get_file(file_id)
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))

    gemini_history = []
    for msg in msgs[:-1]:
        role = "user" if msg["role"] == "user" else "model"
        gemini_history.append({"role": role, "parts": [msg.get("content", "")]})

    last_msg = msgs[-1].get("content", "") if msgs else ""
    last_content = [data_file, "Answer questions about this dataset.", last_msg] if not gemini_history else [last_msg]

    m = genai.GenerativeModel(model_name, system_instruction="You are an expert data analyst. Answer questions about the provided dataset with specific numbers and insights.")
    chat = m.start_chat(history=gemini_history)

    async def _stream():
        try:
            resp = await chat.send_message_async(last_content, stream=True)
            async for chunk in resp:
                try:
                    if chunk.text:
                        yield f"data: {json.dumps({'type':'text','text':chunk.text})}\n\n"
                except Exception:
                    pass
            yield f"data: {json.dumps({'type':'done'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"

    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Code IQ ───────────────────────────────────────────────────────────────────

CODE_ANALYSIS_PROMPT = """You are a world-class software engineer and code reviewer. Analyze the provided code and return ONLY this JSON:

{
  "language": "Python|JavaScript|TypeScript|Java|Go|Rust|C++|other",
  "frameworks": ["detected frameworks and libraries"],
  "purpose": "What this code does in 1-2 sentences",
  "architecture": "Description of the code architecture and patterns used",
  "overall_grade": "A|B|C|D|F",
  "overall_score": 8,
  "metrics": {
    "lines_of_code": 150,
    "functions_count": 12,
    "classes_count": 3,
    "complexity": "low|medium|high|very_high",
    "maintainability": 8,
    "readability": 7,
    "test_coverage_estimate": "none|low|medium|high"
  },
  "issues": [
    {
      "severity": "critical|high|medium|low|info",
      "category": "security|performance|bug|style|maintainability",
      "description": "Specific issue description",
      "line_hint": "function/line reference",
      "fix": "Specific fix recommendation"
    }
  ],
  "security": {
    "score": 7,
    "vulnerabilities": ["SQL injection risk in getUserById", "XSS vulnerability in renderContent"],
    "best_practices_missing": ["Input validation", "Rate limiting"]
  },
  "performance": {
    "score": 6,
    "bottlenecks": ["O(n²) nested loop in processItems", "Missing database indexes"],
    "optimizations": ["Use caching for expensive computations", "Add pagination"]
  },
  "strengths": ["Well-structured class hierarchy", "Good error handling", "Clear naming conventions"],
  "refactoring_suggestions": [
    {"description": "Extract magic numbers to constants", "impact": "high|medium|low", "effort": "low"}
  ],
  "test_recommendations": ["Add unit tests for edge cases in parseInput", "Mock external API calls"],
  "documentation_score": 6,
  "dependencies_analysis": "Assessment of external dependencies used"
}"""


@app.post("/api/analyze-code")
async def analyze_code(
    files: str = Form(...),
    model: str = Form(FLASH),
):
    try:
        code_files = json.loads(files)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="Invalid files JSON")
    model_name = resolve_model(model)

    combined = ""
    for cf in code_files[:10]:
        combined += f"\n\n=== FILE: {cf.get('name','unnamed')} ===\n{cf.get('content','')[:15000]}"

    prompt = f"{CODE_ANALYSIS_PROMPT}\n\nCode to analyze:\n{combined}"

    async def _stream():
        async for line in gemini_stream_json(model_name, prompt, max_tokens=5000):
            yield line

    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/code-chat")
async def code_chat(
    code_context: str = Form(...),
    messages: str = Form(...),
    model: str = Form(FLASH),
):
    try:
        msgs = json.loads(messages)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="Invalid messages JSON")
    model_name = resolve_model(model)

    context_block = f"Code context:\n{code_context[:20000]}"
    system = "You are an expert code reviewer and software engineer. Answer questions about the provided code accurately, with specific line references when possible."

    gemini_history = []
    for msg in msgs[:-1]:
        role = "user" if msg["role"] == "user" else "model"
        gemini_history.append({"role": role, "parts": [msg.get("content", "")]})

    last_msg = msgs[-1].get("content", "") if msgs else ""
    first_parts = [context_block, last_msg] if not gemini_history else [last_msg]

    m = genai.GenerativeModel(model_name, system_instruction=system)
    chat = m.start_chat(history=gemini_history)

    async def _stream():
        try:
            resp = await chat.send_message_async(first_parts, stream=True)
            async for chunk in resp:
                try:
                    if chunk.text:
                        yield f"data: {json.dumps({'type':'text','text':chunk.text})}\n\n"
                except Exception:
                    pass
            yield f"data: {json.dumps({'type':'done'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"

    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── AI Writer ─────────────────────────────────────────────────────────────────

CONTENT_TEMPLATES = {
    "blog_post": "Write a professional blog post",
    "email": "Write a professional email",
    "tweet_thread": "Write an engaging Twitter/X thread with numbered tweets",
    "linkedin": "Write an engaging LinkedIn post",
    "youtube_desc": "Write a YouTube video description with timestamps and hashtags",
    "product_desc": "Write a compelling product description for e-commerce",
    "cover_letter": "Write a compelling cover letter",
    "press_release": "Write a professional press release",
    "cold_email": "Write an effective cold outreach email",
    "script": "Write a video/podcast script with stage directions",
    "story": "Write a creative short story or fiction piece",
    "ad_copy": "Write persuasive advertising copy",
}


@app.post("/api/generate-content")
async def generate_content(
    topic: str = Form(...),
    template: str = Form("blog_post"),
    tone: str = Form("professional"),
    length: str = Form("medium"),
    language: str = Form("English"),
    extra: str = Form(""),
    model: str = Form(FLASH),
):
    model_name = resolve_model(model)
    template_instruction = CONTENT_TEMPLATES.get(template, "Write professional content")
    length_map = {"short": "300-500 words", "medium": "600-900 words", "long": "1200-1800 words", "ultra": "2500+ words"}
    length_target = length_map.get(length, "600-900 words")

    prompt = (
        f"{template_instruction} about the following topic/brief:\n\n{topic}\n\n"
        f"Requirements:\n"
        f"- Tone: {tone}\n"
        f"- Target length: {length_target}\n"
        f"- Language: {language}\n"
        f"- Format with proper headings, paragraphs, and structure\n"
        f"- Make it engaging, specific, and high quality\n"
    )
    if extra.strip():
        prompt += f"\nAdditional instructions: {extra.strip()}\n"

    async def _stream():
        async for line in gemini_stream(model_name, prompt, max_tokens=4000):
            yield line
        yield f"data: {json.dumps({'type':'done'})}\n\n"

    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Web IQ ────────────────────────────────────────────────────────────────────

WEB_ANALYSIS_PROMPT = """Analyze this web page content and return ONLY this JSON (no markdown fences):

{
  "title": "Page title",
  "type": "news_article|blog_post|product_page|documentation|research|social|forum|other",
  "author": "Author name or 'Unknown'",
  "published_date": "Date or 'Unknown'",
  "reading_time_minutes": 3,
  "summary": {
    "one_line": "Single sentence summary",
    "executive": "3-5 sentence detailed summary",
    "key_points": ["Point 1", "Point 2", "Point 3", "Point 4", "Point 5"]
  },
  "sentiment": "positive|negative|neutral|mixed",
  "bias_assessment": "left|center-left|center|center-right|right|unknown|not_applicable",
  "credibility_signals": {
    "score": 8,
    "positives": ["Has citations", "Named author with credentials"],
    "negatives": ["No date", "Sensational headline"]
  },
  "key_entities": {
    "people": [],
    "organizations": [],
    "locations": [],
    "products": [],
    "events": []
  },
  "claims": [
    {"claim": "Specific factual claim", "verifiable": true, "context": "supporting context"}
  ],
  "quotes": ["Notable direct quote"],
  "data_points": ["Specific statistic or data mentioned"],
  "topics": ["main topic", "secondary topic"],
  "keywords": ["kw1", "kw2", "kw3", "kw4", "kw5", "kw6"],
  "related_questions": ["What question does this raise?", "What's the other side?"],
  "action_items": ["If applicable: what should the reader do?"],
  "tldr": "One punchy sentence under 20 words"
}"""


def fetch_url_content(url: str, timeout: int = 10) -> tuple[str, str]:
    headers = {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
    }
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            charset = "utf-8"
            ct = resp.headers.get("Content-Type", "")
            if "charset=" in ct:
                charset = ct.split("charset=")[-1].split(";")[0].strip()
            html = raw.decode(charset, errors="replace")
    except Exception as e:
        raise ValueError(f"Could not fetch URL: {e}")

    # Extract title
    title_match = re.search(r"<title[^>]*>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
    title = html_module.unescape(title_match.group(1).strip()) if title_match else url

    # Strip to text
    text = re.sub(r"<script[^>]*>.*?</script>", " ", html, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<style[^>]*>.*?</style>", " ", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<!--.*?-->", " ", text, flags=re.DOTALL)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html_module.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:12000], title


@app.post("/api/analyze-url")
async def analyze_url(url: str = Form(...), model: str = Form(FLASH)):
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    try:
        content, title = await asyncio.get_event_loop().run_in_executor(None, fetch_url_content, url)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))

    prompt = f"URL: {url}\nPage title: {title}\n\nPage content:\n{content}\n\n{WEB_ANALYSIS_PROMPT}"
    model_name = resolve_model(model)

    async def _stream():
        async for line in gemini_stream_json(model_name, prompt, max_tokens=4000):
            if '"type":"result"' in line or '"type": "result"' in line:
                try:
                    ev = json.loads(line[6:])
                    yield f"data: {json.dumps({'type':'result','data':ev['data'],'url':url,'page_title':title})}\n\n"
                except Exception:
                    yield line
            else:
                yield line

    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Batch Image Processor ─────────────────────────────────────────────────────

BATCH_IMAGE_PROMPT = """Analyze this image and return ONLY this compact JSON:
{
  "description": "One concise sentence",
  "objects": ["obj1","obj2","obj3"],
  "dominant_colors": ["#hex1","#hex2","#hex3"],
  "mood": "mood word",
  "quality_score": 8,
  "tags": ["tag1","tag2","tag3","tag4","tag5"],
  "text_in_image": "any visible text or empty string",
  "faces_count": 0,
  "scene": "indoor|outdoor|studio|unknown",
  "best_use": "social_media|print|editorial|commercial|portfolio",
  "improvements": ["one key improvement"]
}"""


@app.post("/api/batch-analyze-images")
async def batch_analyze_images(
    files: List[UploadFile] = File(...),
    model: str = Form(FLASH15),
):
    if len(files) > 20:
        raise HTTPException(status_code=400, detail="Max 20 images per batch")
    model_name = resolve_model(model)

    async def analyze_one(f: UploadFile, idx: int):
        content = await f.read()
        media_type = f.content_type or "image/jpeg"
        try:
            img = Image.open(io.BytesIO(content))
            m = genai.GenerativeModel(model_name)
            cfg = genai.GenerationConfig(max_output_tokens=600)
            resp = await m.generate_content_async([img, BATCH_IMAGE_PROMPT], generation_config=cfg)
            raw = resp.text
            clean = re.sub(r"```(?:json)?\s*", "", raw).strip()
            parsed = json.loads(clean)
            parsed["filename"] = f.filename or f"image_{idx+1}"
            parsed["size_kb"] = round(len(content) / 1024, 1)
            return {"index": idx, "status": "ok", "data": parsed}
        except Exception as e:
            return {"index": idx, "status": "error", "filename": f.filename or f"image_{idx+1}", "error": str(e)}

    tasks = [analyze_one(f, i) for i, f in enumerate(files)]
    results = await asyncio.gather(*tasks)

    async def _stream():
        for r in sorted(results, key=lambda x: x["index"]):
            yield f"data: {json.dumps({'type':'item','result':r})}\n\n"
        yield f"data: {json.dumps({'type':'done','total':len(results)})}\n\n"

    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Silence detect (silence in audio track) ──────────────────────────────────

@app.post("/api/silence-detect")
async def silence_detect(file: UploadFile = File(...)):
    if not ffmpeg_available():
        raise HTTPException(status_code=503, detail="FFmpeg not available")
    content = await file.read()
    ext = (file.filename or "video.mp4").rsplit(".", 1)[-1].lower()
    in_path = tempfile.mktemp(suffix=f".{ext}")
    with open(in_path, "wb") as f:
        f.write(content)
    try:
        result = subprocess.run(
            ["ffmpeg", "-i", in_path, "-af",
             "silencedetect=noise=-40dB:d=0.5", "-f", "null", "-"],
            capture_output=True, timeout=120,
        )
        stderr = result.stderr.decode("utf-8", errors="replace")
        silence_starts = re.findall(r"silence_start: ([\d.]+)", stderr)
        silence_ends = re.findall(r"silence_end: ([\d.]+)", stderr)
        silences = []
        for s, e in zip(silence_starts, silence_ends):
            start, end = float(s), float(e)
            if end - start >= 0.3:
                silences.append({"start": round(start, 3), "end": round(end, 3), "duration": round(end - start, 3)})
        return {"silences": silences, "count": len(silences)}
    finally:
        try:
            os.unlink(in_path)
        except Exception:
            pass


# ── Static files ──────────────────────────────────────────────────────────────

if not os.getenv("VERCEL"):
    app.mount("/", StaticFiles(directory="../frontend", html=True), name="frontend")
