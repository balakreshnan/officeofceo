"""Pydantic models for the Office of CEO Insights API."""

from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime
import uuid


class ChatMessage(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    role: str  # "user", "assistant", "system"
    content: str
    agent: Optional[str] = None  # "context-builder", "insights", or None
    is_edited: bool = False
    original_content: Optional[str] = None
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class TokenUsage(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class SessionTokenUsage(BaseModel):
    context_builder: TokenUsage = Field(default_factory=TokenUsage)
    insights: TokenUsage = Field(default_factory=TokenUsage)
    cumulative: TokenUsage = Field(default_factory=TokenUsage)


class Session(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    title: str = "New Session"
    messages: list[ChatMessage] = Field(default_factory=list)
    token_usage: SessionTokenUsage = Field(default_factory=SessionTokenUsage)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class CreateSessionRequest(BaseModel):
    title: Optional[str] = "New Session"


class SendMessageRequest(BaseModel):
    content: str
    session_id: str


class EditMessageRequest(BaseModel):
    message_id: str
    session_id: str
    new_content: str


class StreamEvent(BaseModel):
    type: str  # "agent_started", "token", "agent_completed", "error", "usage", "done"
    agent: Optional[str] = None
    content: Optional[str] = None
    message_id: Optional[str] = None
    usage: Optional[TokenUsage] = None
    error: Optional[str] = None
