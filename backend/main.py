import os
import json
import base64
import tempfile
import io
from typing import AsyncGenerator

import anthropic
import cv2
from PIL import Image
from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="OmniAI - Multimodal AI Assistant")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

VIDEO_ANALYSIS_PROMPTS = {
    "storyboard": (
        "You are a professional film director and storyboard artist. Convert these video frames into a "
        "detailed shot-by-shot storyboard document:\n\n"
        "For each distinct shot/scene:\n"
        "1. **Shot #N** — Shot type (ECU/CU/MS/LS/WS/POV/OTS/Dutch angle/aerial/etc.)\n"
        "2. **Timecode** — Estimated timestamp\n"
        "3. **Visual Description** — What is in frame, composition, lighting\n"
        "4. **Camera Movement** — Static / Pan / Tilt / Dolly / Zoom / Handheld\n"
        "5. **Subject Action** — What is happening in the shot\n"
        "6. **Dialogue/VO** — Any spoken content\n"
        "7. **Transition** — How it moves to next shot\n\n"
        "Then provide:\n"
        "- **Shot List Summary** (table with #, type, duration, description)\n"
        "- **Coverage Gaps** — What cutaways or B-roll are missing\n"
        "- **Production Notes** — Recommendations for reshoots or pickups\n\n"
        "Format professionally like an actual film/TV storyboard document."
    ),
    "shorts": (
        "You are a YouTube Shorts and TikTok viral content strategist with 10M+ views experience. "
        "Analyze this video and create a complete short-form content package:\n\n"
        "1. **Hook Analysis** — Does the first 3 seconds grab attention? Rate it 1-10, explain, suggest better hooks.\n"
        "2. **Shorts Cut Plan** — Which 15-60 second segment would perform best? (Give exact timestamps)\n"
        "3. **Vertical Reframe** — How to crop 16:9 → 9:16 without losing key content\n"
        "4. **Caption Strategy** — First caption text (max 6 words), on-screen text overlays with timestamps\n"
        "5. **Audio Hook** — What trending sound or music genre fits this content\n"
        "6. **Hashtags** — 20 optimized hashtags for maximum reach\n"
        "7. **Title Options** — 5 A/B-testable title variants\n"
        "8. **Posting Strategy** — Best time to post, which platform first (YT Shorts / TikTok / Reels)\n"
        "9. **Series Potential** — Can this become a recurring series? Suggest episode concepts.\n"
        "10. **Viral Prediction** — Rate the virality potential 1-10 with specific reasoning.\n\n"
        "Be specific, data-driven, and brutally honest."
    ),
    "color": (
        "You are a senior colorist with credits on Netflix originals and feature films. "
        "Provide a complete color grading guide for this video:\n\n"
        "1. **Current Color Profile Analysis**\n"
        "   - Color temperature (warm/cool/neutral)\n"
        "   - Contrast levels (flat/normal/contrasty)\n"
        "   - Saturation style\n"
        "   - Shadows/Midtones/Highlights breakdown\n"
        "   - Current mood conveyed by colors\n\n"
        "2. **Target Look Recommendations** (pick best for content type)\n"
        "   - Primary look name (e.g., 'Teal & Orange', 'Desaturated Film', 'Warm Cinematic', 'Clean Commercial')\n"
        "   - Specific LUT suggestions (DaVinci, VSCO, FilmConvert equivalents)\n\n"
        "3. **Scene-by-Scene Color Notes**\n"
        "   Frame by frame: what to adjust per scene\n\n"
        "4. **DaVinci Resolve Settings**\n"
        "   - Lift/Gamma/Gain values\n"
        "   - Hue curves adjustments\n"
        "   - Node structure recommendation\n\n"
        "5. **Premiere Pro / Final Cut Settings**\n"
        "   Equivalent Lumetri panel settings\n\n"
        "6. **Consistency Issues** — frames that break the color continuity\n\n"
        "Be precise and technical."
    ),
    "social": (
        "You are a social media strategist and content repurposing expert. Turn this video into a "
        "full multi-platform content package:\n\n"
        "**Platform-Specific Content Plan:**\n\n"
        "📱 **TikTok / YouTube Shorts / Instagram Reels**\n"
        "   - Best 30-second clip (timestamps)\n"
        "   - Caption (150 chars max)\n"
        "   - 10 hashtags\n\n"
        "📸 **Instagram Feed (static)**\n"
        "   - Best frame for photo post (timestamp)\n"
        "   - Carousel concept (5 slides)\n"
        "   - Caption text\n\n"
        "🐦 **X (Twitter)**\n"
        "   - 3 tweet variants to promote the video\n"
        "   - Best quote from visual content\n\n"
        "💼 **LinkedIn**\n"
        "   - Professional angle/spin on the content\n"
        "   - Long-form post hook\n\n"
        "📧 **Email Newsletter**\n"
        "   - Subject line (A/B test: 2 versions)\n"
        "   - Preview text\n"
        "   - Video embed description\n\n"
        "📝 **Blog Post**\n"
        "   - SEO title\n"
        "   - 5 H2 headers for a related blog post\n"
        "   - Meta description\n\n"
        "**Content Calendar** — Suggest a 2-week posting schedule across all platforms."
    ),
    "full": (
        "You are an expert video analyst and film editor. I'm sending you frames extracted from a video "
        "(evenly sampled throughout the duration). Analyze this video comprehensively:\n\n"
        "1. **Overview** — What is this video about? Genre, subject, purpose.\n"
        "2. **Scene Breakdown** — Describe each distinct scene/segment with approximate timestamps.\n"
        "3. **Visual Style** — Cinematography, color palette, mood, lighting, camera movement.\n"
        "4. **Pacing & Rhythm** — Is the editing fast/slow? Does the pacing work for the content?\n"
        "5. **Strengths** — What works well visually and narratively?\n"
        "6. **Weaknesses** — What could be improved?\n\n"
        "Be specific, professional, and actionable."
    ),
    "edit": (
        "You are a professional video editor at a top post-production house. Analyze these frames "
        "extracted from a video and provide detailed editing recommendations:\n\n"
        "1. **Cut Points** — Where should cuts happen? Identify specific moments (by frame number) where "
        "   the edit should be tightened or re-cut.\n"
        "2. **Transitions** — What transition types suit each scene change? (hard cut, dissolve, wipe, match cut, J/L cut)\n"
        "3. **Pacing Adjustments** — Which sections drag? Which need breathing room?\n"
        "4. **Color Grade** — Recommend a color treatment (warm/cool, contrast, saturation, LUT style).\n"
        "5. **B-Roll Suggestions** — What supplemental footage would strengthen the story?\n"
        "6. **Music & Sound** — Recommend music genre/tempo and sound design elements.\n"
        "7. **Final Cut Order** — If the sequence needs restructuring, suggest a new order.\n\n"
        "Format your response with clear sections and specific, actionable advice."
    ),
    "chapters": (
        "You are a video content strategist. Based on these evenly sampled frames from a video, "
        "generate chapter markers with timestamps.\n\n"
        "Format EXACTLY like this (I will parse it programmatically):\n\n"
        "CHAPTERS:\n"
        "00:00 - [Chapter title]\n"
        "[next timestamp] - [Chapter title]\n"
        "...\n\n"
        "Then below the chapters section, write a 2-3 sentence description of each chapter.\n"
        "Estimate timestamps based on the frame positions (the frames are evenly distributed).\n"
        "Be descriptive and YouTube-ready for the chapter titles."
    ),
    "captions": (
        "You are a professional subtitle writer. Based on these video frames, generate a realistic "
        "caption/subtitle script. Since you can see the visual content but not hear the audio:\n\n"
        "1. Infer what is likely being said based on visual context, setting, and any visible text.\n"
        "2. Generate natural-sounding captions with [SPEAKER] labels where appropriate.\n"
        "3. Include [MUSIC] or [SOUND EFFECT] notes for non-speech audio that should be captioned.\n"
        "4. Format as an SRT-style script with timecodes.\n\n"
        "Make the captions sound authentic and professional."
    ),
    "thumbnail": (
        "You are a YouTube thumbnail strategist and graphic designer. Analyze these video frames and:\n\n"
        "1. **Best Thumbnail Frame** — Which frame number would make the best thumbnail? Why?\n"
        "2. **Thumbnail Composition** — Describe exact cropping and layout.\n"
        "3. **Text Overlay** — Suggest a title text for the thumbnail (short, punchy, curiosity-driving).\n"
        "4. **Design Elements** — Colors, arrows, circles, emojis — what graphic elements to add?\n"
        "5. **A/B Test Variants** — Suggest 2 alternative thumbnail concepts.\n"
        "6. **CTR Prediction** — Rate the thumbnail's click-through potential 1-10 and explain.\n\n"
        "Be specific — describe exactly what to put where."
    ),
    "script": (
        "You are a professional scriptwriter and video producer. Based on these video frames, "
        "generate a complete production script:\n\n"
        "1. **Narration Script** — Write the voiceover text that would accompany each scene.\n"
        "2. **On-Screen Text** — Lower thirds, titles, and text overlays to add.\n"
        "3. **Director's Notes** — Shot descriptions and visual direction.\n"
        "4. **Call-to-Action** — A compelling CTA for the end of the video.\n\n"
        "Format it as a proper two-column script (Visual | Audio) where appropriate."
    ),
}


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


def build_tools(enable_web_search: bool, enable_code_execution: bool) -> list:
    tools = []
    if enable_web_search:
        tools.append({"type": "web_search_20260209", "name": "web_search"})
    if enable_code_execution:
        tools.append({"type": "code_execution_20260120", "name": "code_execution"})
    return tools


def convert_messages(messages: list[Message]) -> list[dict]:
    converted = []
    for msg in messages:
        converted.append({"role": msg.role, "content": msg.content})
    return converted


def extract_frames_cv2(video_path: str, max_frames: int = 20) -> tuple[list[bytes], dict]:
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError("Cannot open video file")

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    duration_sec = total_frames / fps

    step = max(1, total_frames // max_frames)
    frame_indices = list(range(0, total_frames, step))[:max_frames]

    frames_bytes = []
    timestamps = []

    for idx in frame_indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ret, frame = cap.read()
        if not ret:
            continue

        # Resize to max 1280px wide
        h, w = frame.shape[:2]
        if w > 1280:
            scale = 1280 / w
            frame = cv2.resize(frame, (1280, int(h * scale)), interpolation=cv2.INTER_AREA)

        # Convert BGR → RGB → JPEG
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        pil_img = Image.fromarray(rgb)
        buf = io.BytesIO()
        pil_img.save(buf, format="JPEG", quality=85)
        frames_bytes.append((buf.getvalue(), idx / fps))

    cap.release()

    meta = {
        "duration_sec": duration_sec,
        "fps": fps,
        "total_frames": total_frames,
        "width": width,
        "height": height,
    }
    return frames_bytes, meta


async def stream_response(request: ChatRequest) -> AsyncGenerator[str, None]:
    tools = build_tools(request.enable_web_search, request.enable_code_execution)
    messages = convert_messages(request.messages)

    system_prompt = request.system or (
        "You are OmniAI, a highly capable multimodal AI assistant that can understand text, "
        "images, documents, video frames, and code. You can search the web for current information, "
        "execute code, analyze images/videos/files, and engage in complex reasoning. Be helpful, "
        "accurate, and thorough."
    )

    kwargs = {
        "model": request.model,
        "max_tokens": 16000,
        "system": system_prompt,
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
                event_type = type(event).__name__

                if event_type == "RawContentBlockStartEvent":
                    block = event.content_block
                    block_type = block.type if hasattr(block, "type") else None
                    if block_type == "thinking":
                        yield f"data: {json.dumps({'type': 'thinking_start'})}\n\n"
                    elif block_type == "text":
                        yield f"data: {json.dumps({'type': 'text_start'})}\n\n"
                    elif block_type == "tool_use":
                        tool_name = block.name if hasattr(block, "name") else "tool"
                        yield f"data: {json.dumps({'type': 'tool_start', 'tool': tool_name})}\n\n"

                elif event_type == "RawContentBlockDeltaEvent":
                    delta = event.delta
                    delta_type = delta.type if hasattr(delta, "type") else None
                    if delta_type == "thinking_delta":
                        yield f"data: {json.dumps({'type': 'thinking', 'text': delta.thinking})}\n\n"
                    elif delta_type == "text_delta":
                        yield f"data: {json.dumps({'type': 'text', 'text': delta.text})}\n\n"
                    elif delta_type == "input_json_delta":
                        yield f"data: {json.dumps({'type': 'tool_input', 'text': delta.partial_json})}\n\n"

                elif event_type == "RawContentBlockStopEvent":
                    yield f"data: {json.dumps({'type': 'block_stop'})}\n\n"

                elif event_type == "RawMessageStopEvent":
                    final = stream.get_final_message()
                    yield f"data: {json.dumps({'type': 'done', 'stop_reason': final.stop_reason})}\n\n"

    except anthropic.APIError as e:
        yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
    except Exception as e:
        yield f"data: {json.dumps({'type': 'error', 'message': f'Unexpected error: {str(e)}'})}\n\n"


async def stream_video_analysis(
    frame_file_ids: list[str],
    timestamps: list[float],
    task: str,
    model: str,
) -> AsyncGenerator[str, None]:
    prompt_text = VIDEO_ANALYSIS_PROMPTS.get(task, VIDEO_ANALYSIS_PROMPTS["full"])
    n = len(frame_file_ids)
    duration_hint = timestamps[-1] if timestamps else 0

    content = []
    content.append({
        "type": "text",
        "text": (
            f"{prompt_text}\n\n"
            f"---\n"
            f"Video info: {n} frames extracted, video duration ~{duration_hint:.0f}s. "
            f"Frames are evenly sampled from start to end. "
            f"Frame timestamps (seconds): {[round(t, 1) for t in timestamps]}\n"
            f"---\n\n"
            f"Here are the {n} video frames:"
        ),
    })

    for i, fid in enumerate(frame_file_ids):
        content.append({
            "type": "image",
            "source": {"type": "file", "file_id": fid},
        })
        content.append({
            "type": "text",
            "text": f"[Frame {i+1} @ {timestamps[i]:.1f}s]",
        })

    try:
        with client.messages.stream(
            model=model,
            max_tokens=8000,
            thinking={"type": "adaptive"},
            messages=[{"role": "user", "content": content}],
            betas=["files-api-2025-04-14"],
        ) as stream:
            for event in stream:
                event_type = type(event).__name__

                if event_type == "RawContentBlockStartEvent":
                    block = event.content_block
                    block_type = block.type if hasattr(block, "type") else None
                    if block_type == "thinking":
                        yield f"data: {json.dumps({'type': 'thinking_start'})}\n\n"
                    elif block_type == "text":
                        yield f"data: {json.dumps({'type': 'text_start'})}\n\n"

                elif event_type == "RawContentBlockDeltaEvent":
                    delta = event.delta
                    delta_type = delta.type if hasattr(delta, "type") else None
                    if delta_type == "thinking_delta":
                        yield f"data: {json.dumps({'type': 'thinking', 'text': delta.thinking})}\n\n"
                    elif delta_type == "text_delta":
                        yield f"data: {json.dumps({'type': 'text', 'text': delta.text})}\n\n"

                elif event_type == "RawContentBlockStopEvent":
                    yield f"data: {json.dumps({'type': 'block_stop'})}\n\n"

                elif event_type == "RawMessageStopEvent":
                    yield f"data: {json.dumps({'type': 'done'})}\n\n"

    except anthropic.APIError as e:
        yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
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

    supported_types = {
        "image/jpeg", "image/png", "image/gif", "image/webp",
        "application/pdf",
        "text/plain", "text/html", "text/css", "text/javascript",
        "text/markdown", "text/csv", "application/json",
    }

    if media_type not in supported_types:
        raise HTTPException(status_code=415, detail=f"Unsupported file type: {media_type}")

    try:
        uploaded = client.beta.files.upload(file=(file.filename, content, media_type))
        return FileUploadResponse(file_id=uploaded.id, filename=file.filename, media_type=media_type)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")


@app.post("/api/extract-video-frames", response_model=VideoExtractResponse)
async def extract_video_frames(
    file: UploadFile = File(...),
    max_frames: int = Form(20),
):
    video_types = {
        "video/mp4", "video/quicktime", "video/x-msvideo",
        "video/x-matroska", "video/webm", "video/mpeg",
        "video/3gpp", "video/x-flv",
    }
    media_type = file.content_type or ""

    # Some browsers report wrong MIME for .mov etc — allow by extension too
    filename = file.filename or ""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    video_exts = {"mp4", "mov", "avi", "mkv", "webm", "mpeg", "mpg", "3gp", "flv", "m4v"}

    if media_type not in video_types and ext not in video_exts:
        raise HTTPException(status_code=415, detail=f"Not a video file: {media_type}")

    content = await file.read()
    if len(content) > 500 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Video too large (max 500MB)")

    # Write to temp file for cv2
    suffix = f".{ext}" if ext else ".mp4"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    try:
        max_frames = min(max(1, max_frames), 30)
        frames_data, meta = extract_frames_cv2(tmp_path, max_frames)
    finally:
        os.unlink(tmp_path)

    if not frames_data:
        raise HTTPException(status_code=422, detail="Could not extract frames from video")

    # Upload all frames to Files API
    video_frames = []
    for i, (jpeg_bytes, ts) in enumerate(frames_data):
        frame_name = f"frame_{i:03d}_{ts:.1f}s.jpg"
        try:
            uploaded = client.beta.files.upload(
                file=(frame_name, jpeg_bytes, "image/jpeg")
            )
            video_frames.append(VideoFrame(
                file_id=uploaded.id,
                timestamp_sec=round(ts, 2),
                frame_index=i,
            ))
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Frame upload failed: {str(e)}")

    return VideoExtractResponse(
        frames=video_frames,
        filename=filename,
        **meta,
    )


@app.post("/api/analyze-video")
async def analyze_video(
    frame_ids: str = Form(...),
    timestamps: str = Form(...),
    task: str = Form("full"),
    model: str = Form("claude-opus-4-8"),
):
    try:
        ids = json.loads(frame_ids)
        ts = json.loads(timestamps)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="Invalid frame_ids or timestamps JSON")

    if not ids:
        raise HTTPException(status_code=422, detail="No frames provided")

    valid_tasks = set(VIDEO_ANALYSIS_PROMPTS.keys())
    if task not in valid_tasks:
        task = "full"

    return StreamingResponse(
        stream_video_analysis(ids, ts, task, model),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.delete("/api/files/{file_id}")
async def delete_file(file_id: str):
    try:
        client.beta.files.delete(file_id)
        return {"status": "deleted", "file_id": file_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/models")
async def list_models():
    return {
        "models": [
            {"id": "claude-opus-4-8", "name": "Claude Opus 4.8", "description": "Most capable"},
            {"id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6", "description": "Balanced"},
            {"id": "claude-haiku-4-5", "name": "Claude Haiku 4.5", "description": "Fastest"},
            {"id": "claude-fable-5", "name": "Claude Fable 5", "description": "Most powerful"},
        ]
    }


@app.get("/api/health")
async def health():
    return {"status": "ok"}


app.mount("/", StaticFiles(directory="../frontend", html=True), name="frontend")
