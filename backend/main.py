import os
import json
import base64
import asyncio
from typing import AsyncGenerator

import anthropic
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
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

TOOLS = [
    {
        "type": "web_search_20260209",
        "name": "web_search",
    },
    {
        "type": "code_execution_20260120",
        "name": "code_execution",
    },
]


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
        if isinstance(msg.content, str):
            converted.append({"role": msg.role, "content": msg.content})
        else:
            converted.append({"role": msg.role, "content": msg.content})
    return converted


async def stream_response(request: ChatRequest) -> AsyncGenerator[str, None]:
    tools = build_tools(request.enable_web_search, request.enable_code_execution)
    messages = convert_messages(request.messages)

    system_prompt = request.system or (
        "You are OmniAI, a highly capable multimodal AI assistant that can understand text, "
        "images, documents, and code. You can search the web for current information, execute "
        "code, analyze images and files, and engage in complex reasoning. Be helpful, accurate, "
        "and thorough. When appropriate, use your tools to provide the most up-to-date and "
        "precise answers."
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
                    stop_reason = final.stop_reason
                    yield f"data: {json.dumps({'type': 'done', 'stop_reason': stop_reason})}\n\n"

    except anthropic.APIError as e:
        yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
    except Exception as e:
        yield f"data: {json.dumps({'type': 'error', 'message': f'Unexpected error: {str(e)}'})}\n\n"


@app.post("/api/chat")
async def chat(request: ChatRequest):
    return StreamingResponse(
        stream_response(request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
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
        "text/markdown", "text/csv",
        "application/json",
    }

    if media_type not in supported_types:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type: {media_type}. Supported: images, PDF, text files"
        )

    try:
        uploaded = client.beta.files.upload(
            file=(file.filename, content, media_type),
        )
        return FileUploadResponse(
            file_id=uploaded.id,
            filename=file.filename,
            media_type=media_type,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")


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
            {"id": "claude-opus-4-8", "name": "Claude Opus 4.8", "description": "Most capable — best for complex tasks"},
            {"id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6", "description": "Balanced — fast and smart"},
            {"id": "claude-haiku-4-5", "name": "Claude Haiku 4.5", "description": "Fastest — best for simple tasks"},
            {"id": "claude-fable-5", "name": "Claude Fable 5", "description": "Most powerful — highest reasoning"},
        ]
    }


@app.get("/api/health")
async def health():
    return {"status": "ok", "model": "claude-opus-4-8"}


app.mount("/", StaticFiles(directory="../frontend", html=True), name="frontend")
