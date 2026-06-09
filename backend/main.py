"""FastAPI backend for Office of CEO Insights Builder."""

import os
import json
import asyncio
from datetime import datetime
from typing import Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv

from models import (
    Session,
    ChatMessage,
    TokenUsage,
    SessionTokenUsage,
    CreateSessionRequest,
    SendMessageRequest,
    EditMessageRequest,
    StreamEvent,
)
from agents import AgentOrchestrator

load_dotenv()

# In-memory session store
sessions: dict[str, Session] = {}
orchestrator: Optional[AgentOrchestrator] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize resources on startup."""
    global orchestrator
    orchestrator = AgentOrchestrator()
    try:
        await orchestrator.initialize()
    except Exception as e:
        print(f"Warning: Agent initialization deferred - {e}")
    yield


app = FastAPI(
    title="Office of CEO - Insights Builder API",
    description="AI-powered executive insights for customer meetings",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Session Management ---


@app.get("/api/sessions")
async def list_sessions():
    """List all sessions."""
    return [
        {
            "id": s.id,
            "title": s.title,
            "message_count": len(s.messages),
            "token_usage": s.token_usage.cumulative.model_dump(),
            "created_at": s.created_at.isoformat(),
            "updated_at": s.updated_at.isoformat(),
        }
        for s in sorted(sessions.values(), key=lambda x: x.updated_at, reverse=True)
    ]


@app.post("/api/sessions")
async def create_session(req: CreateSessionRequest):
    """Create a new session."""
    session = Session(title=req.title or "New Session")
    sessions[session.id] = session
    return {"id": session.id, "title": session.title}


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str):
    """Get session details with messages."""
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session.model_dump()


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str):
    """Delete a session."""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    del sessions[session_id]
    return {"status": "deleted"}


@app.put("/api/sessions/{session_id}/title")
async def update_session_title(session_id: str, req: dict):
    """Update session title."""
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    session.title = req.get("title", session.title)
    session.updated_at = datetime.utcnow()
    return {"id": session.id, "title": session.title}


# --- Message Editing ---


@app.put("/api/messages/edit")
async def edit_message(req: EditMessageRequest):
    """Edit an existing message content."""
    session = sessions.get(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    for msg in session.messages:
        if msg.id == req.message_id:
            if not msg.is_edited:
                msg.original_content = msg.content
            msg.content = req.new_content
            msg.is_edited = True
            session.updated_at = datetime.utcnow()
            return msg.model_dump()

    raise HTTPException(status_code=404, detail="Message not found")


# --- Streaming Chat ---


@app.post("/api/chat/stream")
async def stream_chat(req: SendMessageRequest):
    """Stream agent responses using SSE."""
    session = sessions.get(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Add user message
    user_message = ChatMessage(role="user", content=req.content)
    session.messages.append(user_message)
    session.updated_at = datetime.utcnow()

    # Auto-title from first message
    if len(session.messages) == 1:
        session.title = req.content[:50] + ("..." if len(req.content) > 50 else "")

    # Build conversation history for agents
    history = [{"role": m.role, "content": m.content} for m in session.messages[:-1]]

    async def event_generator():
        """Generate SSE events from agent orchestration."""
        context_message_id = None
        insights_message_id = None
        context_content = ""
        insights_content = ""

        try:
            async for event in orchestrator.orchestrate(req.content, history):
                event_type = event["type"]

                if event_type == "agent_started":
                    agent = event["agent"]
                    # Create a placeholder message
                    msg = ChatMessage(
                        role="assistant", content="", agent=agent
                    )
                    session.messages.append(msg)
                    if agent == "context-builder":
                        context_message_id = msg.id
                    else:
                        insights_message_id = msg.id

                    sse_data = json.dumps(
                        {
                            "type": "agent_started",
                            "agent": agent,
                            "message_id": msg.id,
                        }
                    )
                    yield f"data: {sse_data}\n\n"

                elif event_type == "token":
                    agent = event["agent"]
                    content = event["content"]

                    # Append to the appropriate message
                    if agent == "context-builder":
                        context_content += content
                        for m in session.messages:
                            if m.id == context_message_id:
                                m.content = context_content
                                break
                    else:
                        insights_content += content
                        for m in session.messages:
                            if m.id == insights_message_id:
                                m.content = insights_content
                                break

                    sse_data = json.dumps(
                        {
                            "type": "token",
                            "agent": agent,
                            "content": content,
                            "message_id": (
                                context_message_id
                                if agent == "context-builder"
                                else insights_message_id
                            ),
                        }
                    )
                    yield f"data: {sse_data}\n\n"

                elif event_type == "agent_completed":
                    agent = event["agent"]
                    usage_data = event.get("usage", {})
                    usage = TokenUsage(**usage_data)

                    # Update token tracking
                    if agent == "context-builder":
                        session.token_usage.context_builder.prompt_tokens += (
                            usage.prompt_tokens
                        )
                        session.token_usage.context_builder.completion_tokens += (
                            usage.completion_tokens
                        )
                        session.token_usage.context_builder.total_tokens += (
                            usage.total_tokens
                        )
                    else:
                        session.token_usage.insights.prompt_tokens += (
                            usage.prompt_tokens
                        )
                        session.token_usage.insights.completion_tokens += (
                            usage.completion_tokens
                        )
                        session.token_usage.insights.total_tokens += usage.total_tokens

                    # Update cumulative
                    session.token_usage.cumulative.prompt_tokens += usage.prompt_tokens
                    session.token_usage.cumulative.completion_tokens += (
                        usage.completion_tokens
                    )
                    session.token_usage.cumulative.total_tokens += usage.total_tokens

                    sse_data = json.dumps(
                        {
                            "type": "agent_completed",
                            "agent": agent,
                            "usage": usage.model_dump(),
                            "cumulative_usage": session.token_usage.cumulative.model_dump(),
                        }
                    )
                    yield f"data: {sse_data}\n\n"

                elif event_type == "done":
                    sse_data = json.dumps(
                        {
                            "type": "done",
                            "cumulative_usage": session.token_usage.cumulative.model_dump(),
                        }
                    )
                    yield f"data: {sse_data}\n\n"

                elif event_type == "error":
                    sse_data = json.dumps(
                        {"type": "error", "error": event.get("error", "Unknown error")}
                    )
                    yield f"data: {sse_data}\n\n"

        except Exception as e:
            sse_data = json.dumps({"type": "error", "error": str(e)})
            yield f"data: {sse_data}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# --- Health Check ---


@app.get("/api/health")
async def health_check():
    return {
        "status": "healthy",
        "agents": {
            "context_builder": orchestrator._context_builder_agent is not None
            if orchestrator
            else False,
            "insights": orchestrator._insights_agent is not None
            if orchestrator
            else False,
        },
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
