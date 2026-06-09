"""Agent orchestration using Foundry Responses API (direct REST) for streaming."""

import os
import json
import asyncio
import requests
from typing import AsyncGenerator
from azure.identity import DefaultAzureCredential, AzureCliCredential
from models import TokenUsage


class AgentOrchestrator:
    """Orchestrates the two Foundry agents: context-builder and insights."""

    def __init__(self):
        self.endpoint = os.getenv("AZURE_AI_PROJECT_ENDPOINT", "")
        self.context_builder_name = os.getenv(
            "CONTEXT_BUILDER_AGENT_NAME", "oceo-context-builder"
        )
        self.insights_name = os.getenv("INSIGHTS_AGENT_NAME", "oceo-insights")
        self.client = None  # kept for health check compatibility
        self.credential = None
        self._token = None

        try:
            tenant_id = os.getenv("AZURE_TENANT_ID", "")
            if tenant_id:
                self.credential = AzureCliCredential(tenant_id=tenant_id)
            else:
                self.credential = DefaultAzureCredential()

            if self.endpoint and self.endpoint != "your-endpoint-here":
                # Verify credential works
                self._token = self.credential.get_token("https://ai.azure.com/.default").token
                self.client = True  # Signal that we're connected
                print(f"Info: Connected to Azure AI Foundry at {self.endpoint}")
            else:
                print("Info: No Azure AI connection configured. Running in demo mode.")
        except Exception as e:
            print(f"Warning: Could not initialize credentials: {e}")

    def _get_token(self) -> str:
        """Get or refresh bearer token."""
        self._token = self.credential.get_token("https://ai.azure.com/.default").token
        return self._token

    async def initialize(self):
        """Verify connection is working."""
        if not self.client:
            return
        print(f"  ✓ Agent configured: {self.context_builder_name}")
        print(f"  ✓ Agent configured: {self.insights_name}")

    def _invoke_agent_streaming(self, agent_name: str, user_input: str):
        """Invoke a Foundry agent via Responses API with SSE streaming."""
        token = self._get_token()
        url = (
            f"{self.endpoint}/agents/{agent_name}/endpoint/protocols/openai/responses"
            f"?api-version=2025-05-15-preview"
        )
        resp = requests.post(
            url,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"input": user_input, "stream": True},
            stream=True,
            timeout=120,
        )
        resp.raise_for_status()

        for line in resp.iter_lines():
            if not line:
                continue
            decoded = line.decode("utf-8")
            if decoded.startswith("data: "):
                try:
                    data = json.loads(decoded[6:])
                    yield data
                except json.JSONDecodeError:
                    continue

    async def run_agent(
        self, agent_name: str, agent_label: str, user_input: str
    ) -> AsyncGenerator[dict, None]:
        """Run a Foundry agent with real streaming and yield events."""
        yield {"type": "agent_started", "agent": agent_label}

        try:
            loop = asyncio.get_event_loop()
            content, usage, sources = await loop.run_in_executor(
                None, self._collect_agent_response, agent_name, user_input
            )

            # Stream the content to client in chunks
            chunk_size = 30
            for i in range(0, len(content), chunk_size):
                chunk = content[i : i + chunk_size]
                yield {"type": "token", "agent": agent_label, "content": chunk}
                await asyncio.sleep(0.015)

            # Append sources section if we have any
            if sources:
                sources_section = "\n\n---\n### 📚 Sources\n"
                for s in sources:
                    sources_section += f"- {s}\n"
                yield {"type": "token", "agent": agent_label, "content": sources_section}
                content += sources_section

            yield {
                "type": "agent_completed",
                "agent": agent_label,
                "content": content,
                "usage": usage.model_dump(),
            }

        except Exception as e:
            yield {"type": "error", "error": f"Agent '{agent_name}' error: {str(e)}"}

    def _collect_agent_response(self, agent_name: str, user_input: str) -> tuple:
        """Collect full response from streaming, extract text + usage + sources."""
        content = ""
        usage = TokenUsage()
        sources = []
        file_search_results = []

        for event_data in self._invoke_agent_streaming(agent_name, user_input):
            event_type = event_data.get("type", "")

            # Collect output text deltas
            if event_type == "response.output_text.delta":
                delta = event_data.get("delta", "")
                content += delta

            # Collect completed response for usage
            elif event_type == "response.completed":
                resp = event_data.get("response", {})
                resp_usage = resp.get("usage", {})
                usage = TokenUsage(
                    prompt_tokens=resp_usage.get("input_tokens", 0),
                    completion_tokens=resp_usage.get("output_tokens", 0),
                    total_tokens=resp_usage.get("total_tokens", 0),
                )
                # Extract file_search annotations from output
                for output_item in resp.get("output", []):
                    if output_item.get("type") == "message":
                        for c in output_item.get("content", []):
                            for ann in c.get("annotations", []):
                                if ann.get("type") == "file_citation":
                                    filename = ann.get("filename", "Unknown file")
                                    if filename not in sources:
                                        sources.append(f"📄 {filename} (Vector Store)")

            # Track file_search tool calls for source attribution
            elif event_type == "response.output_item.added":
                item = event_data.get("item", {})
                if item.get("type") == "file_search_call":
                    file_search_results.append(item)

        # If file_search was used but no annotations, note it
        if file_search_results and not sources:
            sources.append("📄 Agent Knowledge Base (File Search)")

        return content, usage, sources

    async def orchestrate(
        self, query: str, conversation_history: list[dict]
    ) -> AsyncGenerator[dict, None]:
        """Full orchestration: context-builder (JSON) → insights (summary)."""
        if not self.client:
            async for event in self._demo_orchestrate(query):
                yield event
            return

        # Phase 1: Context Builder — gathers structured JSON context
        yield {"type": "agent_started", "agent": "context-builder"}
        yield {
            "type": "token",
            "agent": "context-builder",
            "content": "🔍 Researching customer data from knowledge base...\n",
        }

        context_content = ""
        try:
            loop = asyncio.get_event_loop()
            context_content, ctx_usage, ctx_sources = await loop.run_in_executor(
                None, self._collect_agent_response, self.context_builder_name, query
            )

            # Show a brief summary of what was gathered
            summary = self._summarize_context(context_content)
            yield {"type": "token", "agent": "context-builder", "content": summary}

            if ctx_sources:
                sources_section = "\n---\n### 📚 Data Sources\n"
                for s in ctx_sources:
                    sources_section += f"- {s}\n"
                yield {"type": "token", "agent": "context-builder", "content": sources_section}
                summary += sources_section

            yield {
                "type": "agent_completed",
                "agent": "context-builder",
                "content": summary,
                "usage": ctx_usage.model_dump(),
            }
        except Exception as e:
            yield {"type": "token", "agent": "context-builder", "content": f"⚠️ Could not gather context: {str(e)}"}
            yield {"type": "agent_completed", "agent": "context-builder", "content": f"Error: {str(e)}", "usage": TokenUsage().model_dump()}

        # Phase 2: Insights — summarizes the JSON into executive briefing
        # Pass the raw JSON context directly; the insights agent will summarize it
        insights_input = (
            f"Here is the structured customer context data (JSON) from our research:\n\n"
            f"{context_content}\n\n"
            f"Original user request: {query}\n\n"
            f"Please summarize this into an executive briefing."
        )
        async for event in self.run_agent(
            self.insights_name, "insights", insights_input
        ):
            yield event

        yield {"type": "done"}

    def _summarize_context(self, raw_json: str) -> str:
        """Extract a human-readable summary from the context-builder's JSON output."""
        try:
            data = json.loads(raw_json)
            lines = []
            if data.get("account_code"):
                lines.append(f"**Account:** {data.get('account_code')}")
            aliases = data.get("aliases_resolved", [])
            if aliases:
                lines.append(f"**Customer:** {aliases[0]}")
            if data.get("meeting_purpose"):
                lines.append(f"**Meeting Purpose:** {data['meeting_purpose']}")
            if data.get("meeting_date"):
                lines.append(f"**Meeting Date:** {data['meeting_date']}")
            if data.get("counterparty"):
                cp = data["counterparty"]
                lines.append(f"**Meeting With:** {cp.get('name', 'N/A')} ({cp.get('title', 'N/A')})")
            # Count data sections found
            context = data.get("context", {})
            sections_found = [k for k in context.keys() if context[k]]
            if sections_found:
                lines.append(f"**Data Gathered:** {', '.join(sections_found)}")
            # Watermelon flags
            flags = data.get("watermelon_flags", [])
            if flags:
                lines.append(f"⚠️ **Watermelon Flags:** {len(flags)} conflicting signals detected")
            gaps = data.get("data_gaps", [])
            if gaps:
                lines.append(f"📋 **Data Gaps:** {len(gaps)} missing data points noted")

            return "\n".join(lines) + "\n\n✅ Context gathered successfully. Generating insights...\n"
        except (json.JSONDecodeError, TypeError):
            # If not JSON, just show a truncated version
            preview = raw_json[:200] + "..." if len(raw_json) > 200 else raw_json
            return f"Context gathered ({len(raw_json)} chars). Generating insights...\n"

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
