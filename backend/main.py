import os
import io
import json
import re
import base64
import tempfile
import subprocess
from typing import AsyncGenerator

import anthropic
import cv2
from PIL import Image
from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="OmniAI — Multimodal AI Studio")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))


# ── Helpers ────────────────────────────────────────────────────────────────

def extract_frames_cv2(video_path: str, max_frames: int = 20) -> tuple[list, dict]:
    """Returns list of (main_jpeg_bytes, thumb_jpeg_bytes, timestamp_sec) tuples."""
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

        # Main frame for AI (max 1280px wide)
        if w > 1280:
            scale = 1280 / w
            main_frame = cv2.resize(frame, (1280, int(h * scale)), interpolation=cv2.INTER_AREA)
        else:
            main_frame = frame
        rgb = cv2.cvtColor(main_frame, cv2.COLOR_BGR2RGB)
        buf = io.BytesIO()
        Image.fromarray(rgb).save(buf, format="JPEG", quality=82)
        main_bytes = buf.getvalue()

        # Thumbnail for filmstrip UI (160x90)
        thumb = cv2.resize(frame, (160, 90), interpolation=cv2.INTER_AREA)
        thumb_rgb = cv2.cvtColor(thumb, cv2.COLOR_BGR2RGB)
        tbuf = io.BytesIO()
        Image.fromarray(thumb_rgb).save(tbuf, format="JPEG", quality=72)
        thumb_bytes = tbuf.getvalue()

        frames_data.append((main_bytes, thumb_bytes, idx / fps))

    cap.release()
    return frames_data, {
        "duration_sec": round(duration_sec, 3),
        "fps": round(fps, 3),
        "total_frames": total_frames,
        "width": width,
        "height": height,
    }


def detect_scenes_cv2(video_path: str, threshold: float = 0.35) -> list[dict]:
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    # Sample at most every 5 frames for speed
    sample_step = max(1, total // 500)
    scenes = []
    prev_hist = None
    frame_idx = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx % sample_step == 0:
            # Resize for speed
            small = cv2.resize(frame, (160, 90))
            hist = cv2.calcHist([small], [0, 1, 2], None, [8, 8, 8], [0, 256, 0, 256, 0, 256])
            hist = cv2.normalize(hist, hist).flatten()
            if prev_hist is not None:
                corr = float(cv2.compareHist(prev_hist, hist, cv2.HISTCMP_CORREL))
                if corr < threshold:
                    scenes.append({
                        "frame": frame_idx,
                        "timestamp_sec": round(frame_idx / fps, 3),
                        "timestamp": sec_to_tc(frame_idx / fps),
                        "correlation": round(corr, 3),
                    })
            prev_hist = hist
        frame_idx += 1

    cap.release()
    return scenes


def detect_motion_energy(video_path: str, max_samples: int = 100) -> list[dict]:
    """Return per-frame motion energy scores for timeline waveform."""
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
                score = float(diff.mean()) / 255.0
                energy.append({"t": round(idx / fps, 2), "e": round(score, 4)})
            prev_gray = gray
        idx += 1

    cap.release()
    return energy


def sec_to_tc(sec: float, srt: bool = False) -> str:
    """Convert seconds to timecode HH:MM:SS.mmm or SRT format."""
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec % 60
    if srt:
        ms = int((s % 1) * 1000)
        return f"{h:02d}:{m:02d}:{int(s):02d},{ms:03d}"
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def sec_to_tc_short(sec: float) -> str:
    m = int(sec // 60)
    s = sec % 60
    return f"{m}:{s:05.2f}"


def ffmpeg_available() -> bool:
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=3)
        return True
    except Exception:
        return False


def tc_to_sec(tc: str) -> float:
    """Parse HH:MM:SS.mmm or HH:MM:SS,mmm timecode to seconds."""
    if not tc:
        return 0.0
    try:
        parts = tc.replace(",", ".").split(":")
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    except (IndexError, ValueError):
        return 0.0


def build_edit_filter(decisions: list) -> tuple[str, str]:
    """Build FFmpeg filter_complex string for cut decisions.
    Returns (filter_complex, output_maps). Empty strings if passthrough.
    """
    keeps = [d for d in decisions if d.get("action") not in ("CUT", "FADE_IN", "FADE_OUT", "DISSOLVE")]
    if not keeps:
        return "", ""

    segments_v, segments_a = [], []
    valid = 0
    for i, d in enumerate(keeps):
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
    fc = ";".join(segments_v + segments_a + [concat_v, concat_a])
    return fc, "[outv_raw][outa]"


def build_color_filter(cg: dict) -> str:
    """Build an FFmpeg vf filter chain from AI color_grade JSON."""
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

    # Highlights / shadows via master curves
    if abs(highlights) > 3 or abs(shadows) > 3:
        sh = max(-0.12, min(0.12, shadows / 100.0 * 0.12))
        hl = max(-0.12, min(0.12, highlights / 100.0 * 0.12))
        p1 = max(0.05, min(0.95, 0.25 + sh))
        p2 = max(0.05, min(0.95, 0.75 + hl))
        parts.append(f"curves=m='0/0 0.25/{p1:.3f} 0.75/{p2:.3f} 1/1'")

    # Color temperature via RGB curves
    temp = float(cg.get("temperature", 5500))
    if temp < 4800:
        shift = min(0.14, (4800 - temp) / 4800.0 * 0.14)
        parts.append(
            f"curves=r='0/0 1/{min(1.0,1+shift):.3f}'"
            f":b='0/0 1/{max(0.72,1-shift):.3f}'"
        )
    elif temp > 6300:
        shift = min(0.1, (temp - 6300) / 6300.0 * 0.1)
        parts.append(
            f"curves=r='0/0 1/{max(0.82,1-shift):.3f}'"
            f":b='0/0 1/{min(1.0,1+shift):.3f}'"
        )

    return ",".join(parts)


# ── Models ─────────────────────────────────────────────────────────────────

class Message(BaseModel):
    role: str
    content: list | str


class ChatRequest(BaseModel):
    messages: list[Message]
    model: str = "claude-opus-4-8"
    enable_thinking: bool = True
    enable_web_search: bool = True
    enable_code_execution: bool = True
    system: str | None = None


class FileUploadResponse(BaseModel):
    file_id: str
    filename: str
    media_type: str


class VideoFrame(BaseModel):
    file_id: str
    timestamp_sec: float
    frame_index: int
    thumbnail_b64: str = ""  # data:image/jpeg;base64,... for filmstrip display


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


# ── Chat streaming ─────────────────────────────────────────────────────────

def build_tools(ws: bool, ce: bool) -> list:
    tools = []
    if ws:
        tools.append({"type": "web_search_20260209", "name": "web_search"})
    if ce:
        tools.append({"type": "code_execution_20260120", "name": "code_execution"})
    return tools


async def stream_response(request: ChatRequest) -> AsyncGenerator[str, None]:
    tools = build_tools(request.enable_web_search, request.enable_code_execution)
    messages = [{"role": m.role, "content": m.content} for m in request.messages]

    system = request.system or (
        "You are OmniAI, a highly capable multimodal AI assistant that understands text, images, "
        "documents, video frames, and code. You can search the web and execute code."
    )

    kwargs = {
        "model": request.model,
        "max_tokens": 16000,
        "system": system,
        "messages": messages,
    }
    if tools:
        kwargs["tools"] = tools
        kwargs["betas"] = ["web-search-2026-02-09", "code-execution-2026-01-20"]
    if request.enable_thinking:
        kwargs["thinking"] = {"type": "adaptive"}

    try:
        with client.messages.stream(**kwargs) as stream:
            for event in stream:
                t = type(event).__name__
                if t == "RawContentBlockStartEvent":
                    bt = getattr(event.content_block, "type", None)
                    if bt == "thinking":
                        yield f"data: {json.dumps({'type': 'thinking_start'})}\n\n"
                    elif bt == "text":
                        yield f"data: {json.dumps({'type': 'text_start'})}\n\n"
                    elif bt == "tool_use":
                        yield f"data: {json.dumps({'type': 'tool_start', 'tool': getattr(event.content_block, 'name', 'tool')})}\n\n"
                elif t == "RawContentBlockDeltaEvent":
                    dt = getattr(event.delta, "type", None)
                    if dt == "thinking_delta":
                        yield f"data: {json.dumps({'type': 'thinking', 'text': event.delta.thinking})}\n\n"
                    elif dt == "text_delta":
                        yield f"data: {json.dumps({'type': 'text', 'text': event.delta.text})}\n\n"
                    elif dt == "input_json_delta":
                        yield f"data: {json.dumps({'type': 'tool_input', 'text': event.delta.partial_json})}\n\n"
                elif t == "RawContentBlockStopEvent":
                    yield f"data: {json.dumps({'type': 'block_stop'})}\n\n"
                elif t == "RawMessageStopEvent":
                    yield f"data: {json.dumps({'type': 'done', 'stop_reason': stream.get_final_message().stop_reason})}\n\n"
    except anthropic.APIError as e:
        yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
    except Exception as e:
        yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"


# ── AI Video Editor (structured JSON output) ────────────────────────────────

AI_EDIT_PROMPT = """You are a world-class video editor with 20 years of experience in Hollywood films, documentaries, and viral content.
I am giving you {n} frames extracted from a video (duration: ~{duration}s, timestamps: {timestamps}).

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
    "music_genre_suggestion": "Electronic / Cinematic / Lo-fi / etc",
    "audio_design_notes": "Specific sound design recommendations"
  }},
  "captions": [
    {{"id": 1, "start": "00:00:00,000", "end": "00:00:02,500", "speaker": "Person 1", "text": "Inferred or visible dialogue"}}
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
      "label": "Remove silence at 3s-5s",
      "command": "ffmpeg -i INPUT.mp4 -filter_complex \\"[0:v]trim=0:3,setpts=PTS-STARTPTS[v1];[0:v]trim=5,setpts=PTS-STARTPTS[v2];[v1][v2]concat=n=2:v=1[out]\\" -map \\"[out]\\" OUTPUT.mp4"
    }},
    {{
      "label": "Apply color grade",
      "command": "ffmpeg -i INPUT.mp4 -vf \\"eq=brightness=0.05:contrast=1.15:saturation=1.2,curves=r='0/0 0.5/0.53 1/1':g='0/0 0.5/0.5 1/1':b='0/0 0.5/0.47 1/0.95'\\" OUTPUT_graded.mp4"
    }},
    {{
      "label": "Export vertical Shorts (9:16)",
      "command": "ffmpeg -i INPUT.mp4 -vf \\"crop=ih*9/16:ih\\" -ss 00:00:15 -to 00:00:45 SHORTS.mp4"
    }},
    {{
      "label": "Speed up slow sections",
      "command": "ffmpeg -i INPUT.mp4 -filter:v \\"setpts=0.5*PTS\\" -filter:a \\"atempo=2.0\\" OUTPUT_fast.mp4"
    }}
  ],
  "top_issues": [
    "Issue 1 with specific timecode",
    "Issue 2"
  ],
  "top_strengths": [
    "Strength 1",
    "Strength 2"
  ],
  "recommended_final_duration": 45.0
}}

Estimate all timestamps from the provided frame positions. Be creative, specific, and professional.
Generate realistic dialogue for captions based on visual context.
The FFmpeg commands must be VALID and EXECUTABLE — use real filter syntax.
Output ONLY the JSON. No markdown code blocks, no explanation."""


async def stream_ai_edit(
    frame_file_ids: list[str],
    timestamps: list[float],
    model: str,
    duration: float,
) -> AsyncGenerator[str, None]:
    n = len(frame_file_ids)
    ts_str = str([round(t, 1) for t in timestamps])

    prompt = AI_EDIT_PROMPT.format(n=n, duration=round(duration, 1), timestamps=ts_str)

    content = [{"type": "text", "text": prompt}]
    for i, fid in enumerate(frame_file_ids):
        content.append({"type": "image", "source": {"type": "file", "file_id": fid}})
        content.append({"type": "text", "text": f"[Frame {i+1} @ {timestamps[i]:.1f}s]"})

    full_text = ""
    try:
        with client.messages.stream(
            model=model,
            max_tokens=8000,
            messages=[{"role": "user", "content": content}],
            betas=["files-api-2025-04-14"],
        ) as stream:
            for event in stream:
                t = type(event).__name__
                if t == "RawContentBlockDeltaEvent":
                    dt = getattr(event.delta, "type", None)
                    if dt == "text_delta":
                        full_text += event.delta.text
                        yield f"data: {json.dumps({'type': 'chunk', 'text': event.delta.text})}\n\n"
                elif t == "RawMessageStopEvent":
                    # Try to parse JSON
                    try:
                        # Remove any markdown code fences
                        clean = re.sub(r"```(?:json)?\s*", "", full_text).strip()
                        parsed = json.loads(clean)
                        yield f"data: {json.dumps({'type': 'result', 'data': parsed})}\n\n"
                    except json.JSONDecodeError as e:
                        yield f"data: {json.dumps({'type': 'parse_error', 'raw': full_text, 'error': str(e)})}\n\n"
                    yield f"data: {json.dumps({'type': 'done'})}\n\n"
    except Exception as e:
        yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"


# ── Routes ─────────────────────────────────────────────────────────────────

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
    supported = {
        "image/jpeg", "image/png", "image/gif", "image/webp",
        "application/pdf", "text/plain", "text/html", "text/css",
        "text/javascript", "text/markdown", "text/csv", "application/json",
    }
    if media_type not in supported:
        raise HTTPException(status_code=415, detail=f"Unsupported: {media_type}")
    try:
        uploaded = client.beta.files.upload(file=(file.filename, content, media_type))
        return FileUploadResponse(file_id=uploaded.id, filename=file.filename, media_type=media_type)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/extract-video-frames")
async def extract_video_frames(
    file: UploadFile = File(...),
    max_frames: int = Form(20),
):
    video_types = {
        "video/mp4", "video/quicktime", "video/x-msvideo",
        "video/x-matroska", "video/webm", "video/mpeg",
        "video/3gpp", "video/x-flv",
    }
    filename = file.filename or "video.mp4"
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "mp4"
    video_exts = {"mp4", "mov", "avi", "mkv", "webm", "mpeg", "mpg", "3gp", "flv", "m4v"}

    media_type = file.content_type or ""
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
        max_frames = min(max(1, max_frames), 30)
        frames_data, meta = extract_frames_cv2(tmp_path, max_frames)
        scenes = detect_scenes_cv2(tmp_path)
        energy = detect_motion_energy(tmp_path)
    finally:
        os.unlink(tmp_path)

    if not frames_data:
        raise HTTPException(status_code=422, detail="Could not extract frames")

    video_frames = []
    for i, (main_bytes, thumb_bytes, ts) in enumerate(frames_data):
        frame_name = f"frame_{i:03d}_{ts:.1f}s.jpg"
        uploaded = client.beta.files.upload(file=(frame_name, main_bytes, "image/jpeg"))
        thumb_b64 = "data:image/jpeg;base64," + base64.b64encode(thumb_bytes).decode()
        video_frames.append(VideoFrame(
            file_id=uploaded.id,
            timestamp_sec=round(ts, 2),
            frame_index=i,
            thumbnail_b64=thumb_b64,
        ))

    return {
        "frames": [f.dict() for f in video_frames],
        "filename": filename,
        "scenes": scenes,
        "energy": energy,
        **meta,
    }


@app.post("/api/ai-edit")
async def ai_edit(
    frame_ids: str = Form(...),
    timestamps: str = Form(...),
    model: str = Form("claude-opus-4-8"),
    duration: float = Form(0),
):
    try:
        ids = json.loads(frame_ids)
        ts = json.loads(timestamps)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="Invalid JSON")
    if not ids:
        raise HTTPException(status_code=422, detail="No frames")

    return StreamingResponse(
        stream_ai_edit(ids, ts, model, duration),
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
        lines.append(str(i))
        lines.append(f"{c.get('start', '00:00:00,000')} --> {c.get('end', '00:00:02,000')}")
        speaker = f"[{c['speaker']}] " if c.get("speaker") else ""
        lines.append(f"{speaker}{c.get('text', '')}")
        lines.append("")

    srt_content = "\n".join(lines)
    return Response(
        content=srt_content,
        media_type="text/plain",
        headers={"Content-Disposition": f'attachment; filename="{filename}.srt"'},
    )


@app.post("/api/export-edl")
async def export_edl(
    edit_decisions: str = Form(...),
    filename: str = Form("edit"),
    fps: float = Form(25.0),
):
    try:
        decisions = json.loads(edit_decisions)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="Invalid JSON")

    def tc_to_frames(tc: str, fps: float) -> int:
        parts = tc.replace(",", ".").split(":")
        try:
            h, m, s = int(parts[0]), int(parts[1]), float(parts[2])
        except (IndexError, ValueError):
            return 0
        total_sec = h * 3600 + m * 60 + s
        return int(total_sec * fps)

    lines = [
        "TITLE: OmniAI Edit",
        f"FCM: NON-DROP FRAME",
        "",
    ]
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

    edl_content = "\n".join(lines)
    return Response(
        content=edl_content,
        media_type="text/plain",
        headers={"Content-Disposition": f'attachment; filename="{filename}.edl"'},
    )


@app.post("/api/export-ffmpeg-script")
async def export_ffmpeg_script(
    commands: str = Form(...),
    filename: str = Form("edit_script"),
):
    try:
        cmds = json.loads(commands)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="Invalid JSON")

    lines = [
        "#!/bin/bash",
        "# OmniAI — Auto-generated FFmpeg Edit Script",
        "# Replace INPUT.mp4 with your actual video file",
        "",
        'INPUT="$1"',
        'if [ -z "$INPUT" ]; then',
        '  echo "Usage: ./edit_script.sh your_video.mp4"',
        "  exit 1",
        "fi",
        "",
    ]
    for i, cmd in enumerate(cmds, 1):
        label = cmd.get("label", f"Step {i}")
        command = cmd.get("command", "").replace("INPUT.mp4", '"$INPUT"')
        lines.append(f"# Step {i}: {label}")
        lines.append(command)
        lines.append("")

    script = "\n".join(lines)
    return Response(
        content=script,
        media_type="text/plain",
        headers={"Content-Disposition": f'attachment; filename="{filename}.sh"'},
    )


@app.delete("/api/files/{file_id}")
async def delete_file(file_id: str):
    try:
        client.beta.files.delete(file_id)
        return {"status": "deleted", "file_id": file_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/process-video")
async def process_video_op(
    file: UploadFile = File(...),
    operation: str = Form("full_edit"),   # full_edit | shorts | color_grade
    edit_decisions: str = Form("[]"),
    color_grade: str = Form("{}"),
    shorts_clip: str = Form("{}"),
):
    if not ffmpeg_available():
        raise HTTPException(status_code=503, detail="FFmpeg is not installed on this server")

    try:
        decisions = json.loads(edit_decisions)
        cg = json.loads(color_grade)
        sc = json.loads(shorts_clip)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=422, detail=f"Invalid JSON: {e}")

    content = await file.read()
    ext = (file.filename or "video.mp4").rsplit(".", 1)[-1].lower()
    original_name = (file.filename or "video.mp4").rsplit(".", 1)[0]

    tmp_in = tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False)
    tmp_in.write(content)
    tmp_in.close()
    in_path = tmp_in.name
    out_path = in_path + "_out.mp4"

    try:
        color_vf = build_color_filter(cg)

        if operation == "color_grade":
            if color_vf:
                cmd = ["ffmpeg", "-y", "-i", in_path, "-vf", color_vf,
                       "-c:v", "libx264", "-crf", "20", "-preset", "fast",
                       "-c:a", "copy", out_path]
            else:
                cmd = ["ffmpeg", "-y", "-i", in_path, "-c", "copy", out_path]

        elif operation == "shorts":
            start_s = tc_to_sec(sc.get("best_start", "00:00:00.000"))
            end_s = tc_to_sec(sc.get("best_end", "00:00:30.000"))
            crop = sc.get("vertical_crop", "crop=ih*9/16:ih")
            # Strip any 'crop=' prefix if AI included it
            if "=" in crop and not crop.startswith("crop"):
                crop = f"crop={crop.split('=',1)[1]}"
            vf_chain = crop + (f",{color_vf}" if color_vf else "")
            cmd = ["ffmpeg", "-y",
                   "-ss", str(start_s), "-to", str(end_s),
                   "-i", in_path,
                   "-vf", vf_chain,
                   "-c:v", "libx264", "-crf", "20", "-preset", "fast",
                   "-c:a", "aac", "-b:a", "192k", out_path]

        else:  # full_edit
            fc, maps = build_edit_filter(decisions)
            if fc:
                if color_vf:
                    # Apply color grade on outv_raw → outv_colored
                    fc_full = fc + f";[outv_raw]{color_vf}[outv_colored]"
                    cmd = ["ffmpeg", "-y", "-i", in_path,
                           "-filter_complex", fc_full,
                           "-map", "[outv_colored]", "-map", "[outa]",
                           "-c:v", "libx264", "-crf", "20", "-preset", "fast",
                           "-c:a", "aac", "-b:a", "192k", out_path]
                else:
                    # Use outv_raw directly as output
                    cmd = ["ffmpeg", "-y", "-i", in_path,
                           "-filter_complex", fc,
                           "-map", "[outv_raw]", "-map", "[outa]",
                           "-c:v", "libx264", "-crf", "20", "-preset", "fast",
                           "-c:a", "aac", "-b:a", "192k", out_path]
            elif color_vf:
                cmd = ["ffmpeg", "-y", "-i", in_path, "-vf", color_vf,
                       "-c:v", "libx264", "-crf", "20", "-preset", "fast",
                       "-c:a", "copy", out_path]
            else:
                cmd = ["ffmpeg", "-y", "-i", in_path, "-c", "copy", out_path]

        result = subprocess.run(cmd, capture_output=True, timeout=600)

        if result.returncode != 0:
            err = result.stderr.decode("utf-8", errors="replace")[-1500:]
            # Fallback: if filter_complex failed, try color-grade-only or straight copy
            if operation == "full_edit" and fc:
                fallback_vf = color_vf if color_vf else None
                if fallback_vf:
                    fallback_cmd = ["ffmpeg", "-y", "-i", in_path, "-vf", fallback_vf,
                                    "-c:v", "libx264", "-crf", "20", "-preset", "fast",
                                    "-c:a", "copy", out_path]
                else:
                    fallback_cmd = ["ffmpeg", "-y", "-i", in_path, "-c", "copy", out_path]
                result2 = subprocess.run(fallback_cmd, capture_output=True, timeout=600)
                if result2.returncode != 0:
                    raise HTTPException(status_code=500, detail=f"FFmpeg error: {err}")
            else:
                raise HTTPException(status_code=500, detail=f"FFmpeg error: {err}")

        if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
            raise HTTPException(status_code=500, detail="FFmpeg produced no output")

        with open(out_path, "rb") as f:
            video_data = f.read()

        suffix_map = {"full_edit": "edited", "shorts": "shorts_9x16", "color_grade": "color_graded"}
        out_name = f"{original_name}_{suffix_map.get(operation,'processed')}.mp4"

        return Response(
            content=video_data,
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
async def extract_thumbnail(
    file: UploadFile = File(...),
    timestamp: float = Form(0.0),
):
    content = await file.read()
    ext = (file.filename or "video.mp4").rsplit(".", 1)[-1].lower()
    tmp = tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False)
    tmp.write(content)
    tmp.close()
    try:
        cap = cv2.VideoCapture(tmp.name)
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        target_frame = int(timestamp * fps)
        cap.set(cv2.CAP_PROP_POS_FRAMES, target_frame)
        ret, frame = cap.read()
        cap.release()
        if not ret:
            raise HTTPException(status_code=404, detail="Frame not found at timestamp")
        h, w = frame.shape[:2]
        # Full-res thumbnail (max 1920px)
        if w > 1920:
            scale = 1920 / w
            frame = cv2.resize(frame, (1920, int(h * scale)), interpolation=cv2.INTER_LANCZOS4)
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        buf = io.BytesIO()
        Image.fromarray(rgb).save(buf, format="JPEG", quality=95)
        jpeg_bytes = buf.getvalue()
        base_name = (file.filename or "frame").rsplit(".", 1)[0]
        return Response(
            content=jpeg_bytes,
            media_type="image/jpeg",
            headers={"Content-Disposition": f'attachment; filename="{base_name}_thumbnail.jpg"'},
        )
    finally:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass


@app.get("/api/health")
async def health():
    return {"status": "ok", "ffmpeg": ffmpeg_available()}


app.mount("/", StaticFiles(directory="../frontend", html=True), name="frontend")
