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
        self.context_builder_name = os.getenv(
            "CONTEXT_BUILDER_AGENT_NAME", "oceo-context-builder"
        )
        self.insights_name = os.getenv("INSIGHTS_AGENT_NAME", "oceo-insights")
        self._context_builder_agent = None
        self._insights_agent = None
        self.client = None

        if connection_string and connection_string != "your-connection-string-here":
            try:
                self.credential = DefaultAzureCredential()
                self.client = AIProjectClient.from_connection_string(
                    conn_str=connection_string,
                    credential=self.credential,
                )
            except Exception as e:
                print(f"Warning: Could not initialize AI Project client: {e}")
        else:
            print("Info: No Azure AI connection string configured. Running in demo mode.")

    async def _get_agent_by_name(self, name: str):
        """Find an agent by name from the Foundry project."""
        if not self.client:
            raise ValueError("Azure AI Project client not configured")
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
        if not self.client:
            # Demo mode - simulate agent responses
            async for event in self._demo_orchestrate(query):
                yield event
            return

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

    async def _demo_orchestrate(self, query: str) -> AsyncGenerator[dict, None]:
        """Demo mode when no Azure connection is configured."""
        import asyncio

        # Simulate context-builder
        yield {"type": "agent_started", "agent": "context-builder"}
        demo_context = (
            f"## Customer Research: Based on your query\n\n"
            f"**Query:** {query}\n\n"
            f"### Company Overview\n"
            f"- Industry leader in their sector\n"
            f"- Recent quarterly revenue growth of 12% YoY\n"
            f"- Key executives: CEO, CTO, CFO identified\n\n"
            f"### Recent News & Events\n"
            f"- Announced digital transformation initiative\n"
            f"- Expanding into cloud-native architecture\n"
            f"- New partnership announcements in AI/ML space\n\n"
            f"### Relationship History\n"
            f"- Active customer for 3+ years\n"
            f"- Current engagement across multiple product lines\n"
            f"- Strategic account with executive sponsorship\n\n"
            f"---\n"
            f"### 📚 Sources\n"
            f"- [Company 10-K Annual Report (SEC Filing)](https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany) — Financial data, revenue growth\n"
            f"- [Bloomberg Company Profile](https://www.bloomberg.com/profile/company) — Executive team, market cap\n"
            f"- [Reuters News Feed](https://www.reuters.com/business) — Digital transformation announcement (May 2026)\n"
            f"- [CRM: Salesforce Account Record](https://crm.internal/accounts) — Relationship history, engagement data\n"
            f"- [LinkedIn Company Page](https://www.linkedin.com/company) — Recent hiring trends, org changes\n"
        )
        for char in demo_context:
            yield {"type": "token", "agent": "context-builder", "content": char}
            await asyncio.sleep(0.005)

        yield {
            "type": "agent_completed",
            "agent": "context-builder",
            "content": demo_context,
            "usage": {"prompt_tokens": 150, "completion_tokens": 200, "total_tokens": 350},
        }

        # Simulate insights
        yield {"type": "agent_started", "agent": "insights"}
        demo_insights = (
            f"## Executive Insights & Talking Points\n\n"
            f"### 🎯 Key Talking Points\n"
            f"1. **Digital Transformation Alignment** — Their cloud migration creates upsell opportunity\n"
            f"2. **AI/ML Partnership** — Position our platform as their AI infrastructure backbone\n"
            f"3. **Executive Engagement** — Strengthen C-suite relationship with joint innovation session\n\n"
            f"### ⚡ Opportunities\n"
            f"- Expand current engagement into AI workloads (~$2M potential)\n"
            f"- Co-develop industry solution for their vertical\n"
            f"- Joint case study for thought leadership\n\n"
            f"### ⚠️ Risks to Address\n"
            f"- Competitive pressure from alternative cloud providers\n"
            f"- Budget constraints in current fiscal quarter\n"
            f"- Technical debt in legacy systems may slow adoption\n\n"
            f"### 📋 Recommended Discussion Agenda\n"
            f"1. Acknowledge their growth and transformation progress\n"
            f"2. Present AI/ML roadmap alignment\n"
            f"3. Propose joint innovation workshop\n"
            f"4. Discuss expanded partnership framework\n"
            f"5. Agree on next steps and executive check-in cadence\n\n"
            f"---\n"
            f"### 📚 Sources\n"
            f"- [Gartner Industry Analysis (2026)](https://www.gartner.com/en/industries) — Competitive landscape, market positioning\n"
            f"- [IDC MarketScape Report](https://www.idc.com/research) — AI/ML adoption benchmarks\n"
            f"- [Internal Deal Desk: Opportunity Pipeline](https://msx.internal/opportunities) — Revenue potential, deal stage\n"
            f"- [Customer Success Platform](https://success.internal/health-scores) — Account health score, NPS data\n"
            f"- [McKinsey Digital Insights](https://www.mckinsey.com/capabilities/mckinsey-digital) — Digital transformation best practices\n"
        )
        for char in demo_insights:
            yield {"type": "token", "agent": "insights", "content": char}
            await asyncio.sleep(0.005)

        yield {
            "type": "agent_completed",
            "agent": "insights",
            "content": demo_insights,
            "usage": {"prompt_tokens": 250, "completion_tokens": 350, "total_tokens": 600},
        }

        yield {"type": "done"}
