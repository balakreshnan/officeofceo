"""Agent orchestration using Azure AI Projects SDK for Foundry agents."""

import os
import json
import asyncio
from typing import AsyncGenerator
from azure.ai.projects import AIProjectClient
from azure.ai.projects.models import (
    AgentStreamEvent,
    MessageDeltaChunk,
    RunStepDeltaChunk,
    ThreadMessage,
    RunStep,
)
from azure.identity import DefaultAzureCredential
from models import TokenUsage


class AgentOrchestrator:
    """Orchestrates the two Foundry agents: context-builder and insights."""

    def __init__(self):
        connection_string = os.getenv("AZURE_AI_PROJECT_CONNECTION_STRING", "")
        self.credential = DefaultAzureCredential()
        self.client = AIProjectClient.from_connection_string(
            conn_str=connection_string,
            credential=self.credential,
        )
        self.context_builder_name = os.getenv(
            "CONTEXT_BUILDER_AGENT_NAME", "oceo-context-builder"
        )
        self.insights_name = os.getenv("INSIGHTS_AGENT_NAME", "oceo-insights")
        self._context_builder_agent = None
        self._insights_agent = None

    async def _get_agent_by_name(self, name: str):
        """Find an agent by name from the Foundry project."""
        agents = self.client.agents.list_agents()
        for agent in agents.data:
            if agent.name == name:
                return agent
        raise ValueError(f"Agent '{name}' not found in the Foundry project.")

    async def initialize(self):
        """Initialize agent references."""
        self._context_builder_agent = await self._get_agent_by_name(
            self.context_builder_name
        )
        self._insights_agent = await self._get_agent_by_name(self.insights_name)

    async def run_context_builder(
        self, query: str, conversation_history: list[dict]
    ) -> AsyncGenerator[dict, None]:
        """Run the context-builder agent and stream results."""
        if not self._context_builder_agent:
            await self.initialize()

        yield {"type": "agent_started", "agent": "context-builder"}

        thread = self.client.agents.create_thread()

        # Add conversation history for context
        for msg in conversation_history[-5:]:  # Last 5 messages for context
            self.client.agents.create_message(
                thread_id=thread.id, role=msg["role"], content=msg["content"]
            )

        # Add user's current query
        self.client.agents.create_message(
            thread_id=thread.id, role="user", content=query
        )

        # Stream the run
        collected_content = ""
        usage = TokenUsage()

        with self.client.agents.create_stream(
            thread_id=thread.id, assistant_id=self._context_builder_agent.id
        ) as stream:
            for event_type, event_data, _ in stream:
                if isinstance(event_data, MessageDeltaChunk):
                    for content_part in event_data.delta.content:
                        if hasattr(content_part, "text") and content_part.text:
                            text_value = content_part.text.value
                            collected_content += text_value
                            yield {
                                "type": "token",
                                "agent": "context-builder",
                                "content": text_value,
                            }

        # Get usage from the run
        runs = self.client.agents.list_runs(thread_id=thread.id)
        if runs.data:
            run = runs.data[0]
            if run.usage:
                usage = TokenUsage(
                    prompt_tokens=run.usage.prompt_tokens,
                    completion_tokens=run.usage.completion_tokens,
                    total_tokens=run.usage.total_tokens,
                )

        yield {
            "type": "agent_completed",
            "agent": "context-builder",
            "content": collected_content,
            "usage": usage.model_dump(),
        }

        # Cleanup thread
        self.client.agents.delete_thread(thread_id=thread.id)

    async def run_insights(
        self, context: str, original_query: str, conversation_history: list[dict]
    ) -> AsyncGenerator[dict, None]:
        """Run the insights agent with gathered context and stream results."""
        if not self._insights_agent:
            await self.initialize()

        yield {"type": "agent_started", "agent": "insights"}

        thread = self.client.agents.create_thread()

        # Provide context and query to insights agent
        insights_prompt = (
            f"Based on the following research context gathered about the customer:\n\n"
            f"---CONTEXT---\n{context}\n---END CONTEXT---\n\n"
            f"Original request: {original_query}\n\n"
            f"Please provide executive-level insights, key talking points, "
            f"risks, opportunities, and recommended discussion topics for the CEO meeting."
        )

        self.client.agents.create_message(
            thread_id=thread.id, role="user", content=insights_prompt
        )

        # Stream the run
        collected_content = ""
        usage = TokenUsage()

        with self.client.agents.create_stream(
            thread_id=thread.id, assistant_id=self._insights_agent.id
        ) as stream:
            for event_type, event_data, _ in stream:
                if isinstance(event_data, MessageDeltaChunk):
                    for content_part in event_data.delta.content:
                        if hasattr(content_part, "text") and content_part.text:
                            text_value = content_part.text.value
                            collected_content += text_value
                            yield {
                                "type": "token",
                                "agent": "insights",
                                "content": text_value,
                            }

        # Get usage from the run
        runs = self.client.agents.list_runs(thread_id=thread.id)
        if runs.data:
            run = runs.data[0]
            if run.usage:
                usage = TokenUsage(
                    prompt_tokens=run.usage.prompt_tokens,
                    completion_tokens=run.usage.completion_tokens,
                    total_tokens=run.usage.total_tokens,
                )

        yield {
            "type": "agent_completed",
            "agent": "insights",
            "content": collected_content,
            "usage": usage.model_dump(),
        }

        # Cleanup thread
        self.client.agents.delete_thread(thread_id=thread.id)

    async def orchestrate(
        self, query: str, conversation_history: list[dict]
    ) -> AsyncGenerator[dict, None]:
        """Full orchestration: context-builder → insights, streaming results."""
        context_content = ""

        # Phase 1: Context Builder
        async for event in self.run_context_builder(query, conversation_history):
            if event["type"] == "agent_completed":
                context_content = event.get("content", "")
            yield event

        # Phase 2: Insights Generation
        async for event in self.run_insights(
            context_content, query, conversation_history
        ):
            yield event

        yield {"type": "done"}
