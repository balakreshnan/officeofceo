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
    edited_by: Optional[str] = None  # display name of collaborator who last edited
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class Collaborator(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    email: str
    role: str = "editor"  # "owner", "editor", "viewer"
    added_at: datetime = Field(default_factory=datetime.utcnow)


class DraftDocument(BaseModel):
    content: str = ""  # markdown content
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    updated_by: Optional[str] = None


class RubricCriterion(BaseModel):
    name: str
    score: float  # 1-5
    max_score: float = 5.0
    rationale: str = ""


class DraftEvaluation(BaseModel):
    overall_score: float = 0.0  # 0-100
    criteria: list[RubricCriterion] = Field(default_factory=list)
    summary: str = ""
    strengths: list[str] = Field(default_factory=list)
    improvements: list[str] = Field(default_factory=list)
    evaluated_at: datetime = Field(default_factory=datetime.utcnow)


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
    collaborators: list[Collaborator] = Field(default_factory=list)
    assignee: Optional[str] = None  # collaborator id assigned ownership
    draft: DraftDocument = Field(default_factory=DraftDocument)
    evaluation: Optional[DraftEvaluation] = None
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
    user_name: Optional[str] = None


class AddCollaboratorRequest(BaseModel):
    name: str
    email: str
    role: str = "editor"


class AssignRequest(BaseModel):
    collaborator_id: Optional[str] = None


class SaveDraftRequest(BaseModel):
    content: str
    user_name: Optional[str] = None


class EvaluateDraftRequest(BaseModel):
    content: Optional[str] = None  # if omitted, uses stored draft


class StreamEvent(BaseModel):
    type: str  # "agent_started", "token", "agent_completed", "error", "usage", "done"
    agent: Optional[str] = None
    content: Optional[str] = None
    message_id: Optional[str] = None
    usage: Optional[TokenUsage] = None
    error: Optional[str] = None
