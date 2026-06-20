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
            frame = cv2.resize(frame, (1280, int(h * scale)), interpolation=cv2.INTER_AREA)
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        buf = io.BytesIO()
        Image.fromarray(rgb).save(buf, format="JPEG", quality=82)
        frames_data.append((buf.getvalue(), idx / fps))

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
    for i, (jpeg_bytes, ts) in enumerate(frames_data):
        frame_name = f"frame_{i:03d}_{ts:.1f}s.jpg"
        uploaded = client.beta.files.upload(file=(frame_name, jpeg_bytes, "image/jpeg"))
        video_frames.append(VideoFrame(file_id=uploaded.id, timestamp_sec=round(ts, 2), frame_index=i))

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


@app.get("/api/health")
async def health():
    return {"status": "ok", "ffmpeg": ffmpeg_available()}


app.mount("/", StaticFiles(directory="../frontend", html=True), name="frontend")
