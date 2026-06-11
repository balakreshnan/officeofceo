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
        self.customer_data_name = os.getenv(
            "CUSTOMER_DATA_AGENT_NAME", "oceo-customerdata"
        )
        self.insights_name = os.getenv("INSIGHTS_AGENT_NAME", "oceo-insights")
        self.model_deployment = os.getenv("AZURE_AI_MODEL_DEPLOYMENT", "gpt-5.4-mini")
        self.openai_api_version = os.getenv("AZURE_OPENAI_API_VERSION", "2024-10-21")
        # Base resource endpoint (strip the /api/projects/... suffix used for agents)
        self.resource_endpoint = self.endpoint.split("/api/projects/")[0] if self.endpoint else ""
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
        """Get or refresh bearer token (Foundry agents scope)."""
        self._token = self.credential.get_token("https://ai.azure.com/.default").token
        return self._token

    def _get_cognitive_token(self) -> str:
        """Bearer token for the Cognitive Services data plane (model inference)."""
        return self.credential.get_token(
            "https://cognitiveservices.azure.com/.default"
        ).token

    def rephrase_text(self, text: str, instruction: str = "", tone: str = "") -> dict:
        """Rephrase selected text using a direct GPT model deployment.

        Returns {"text": <rephrased>, "usage": {...}}. Falls back to a light
        heuristic when no model connection is available.
        """
        text = (text or "").strip()
        if not text:
            return {"text": "", "usage": TokenUsage().model_dump()}

        if not self.client or not self.resource_endpoint:
            return {"text": self._demo_rephrase(text), "usage": TokenUsage().model_dump()}

        system_prompt = (
            "You are an expert executive-communications editor. Rephrase the user's "
            "text to be clearer, more concise, and professional, suitable for a CEO "
            "briefing. Preserve all facts, figures, and meaning. Keep any Markdown "
            "formatting intact. Return ONLY the rephrased text with no preamble, "
            "quotes, or commentary."
        )
        if tone:
            system_prompt += f" Use a {tone} tone."

        user_content = text
        if instruction:
            user_content = f"Instruction: {instruction}\n\nText:\n{text}"

        try:
            token = self._get_cognitive_token()
            url = (
                f"{self.resource_endpoint}/openai/deployments/{self.model_deployment}"
                f"/chat/completions?api-version={self.openai_api_version}"
            )
            resp = requests.post(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                json={
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_content},
                    ],
                    "temperature": 0.5,
                },
                timeout=60,
            )
            resp.raise_for_status()
            data = resp.json()
            rephrased = data["choices"][0]["message"]["content"].strip()
            # Strip surrounding quotes the model sometimes adds
            if len(rephrased) >= 2 and rephrased[0] in '"“' and rephrased[-1] in '"”':
                rephrased = rephrased[1:-1].strip()
            u = data.get("usage", {})
            usage = TokenUsage(
                prompt_tokens=u.get("prompt_tokens", 0),
                completion_tokens=u.get("completion_tokens", 0),
                total_tokens=u.get("total_tokens", 0),
            )
            return {"text": rephrased, "usage": usage.model_dump()}
        except Exception as e:
            print(f"Warning: rephrase failed, using fallback - {e}")
            return {"text": self._demo_rephrase(text), "usage": TokenUsage().model_dump()}

    def _demo_rephrase(self, text: str) -> str:
        """Trivial offline fallback when no model is available."""
        return text.strip()

    async def initialize(self):
        """Verify connection is working."""
        if not self.client:
            return
        print(f"  ✓ Agent configured: {self.context_builder_name}")
        print(f"  ✓ Agent configured: {self.customer_data_name}")
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

            # Send the raw context data for knowledge graph visualization
            try:
                graph_data = self._extract_graph(context_content)
                if graph_data:
                    print(f"  → Emitting context_graph ({len(graph_data.get('nodes', []))} nodes, {len(graph_data.get('links', []))} links)")
                    yield {"type": "context_graph", "data": graph_data}
                else:
                    print(f"  ⚠ Graph extraction returned None. Context length: {len(context_content)}")
                    print(f"  ⚠ Context preview: {context_content[:200]}")
            except Exception as e:
                print(f"  ⚠ Graph extraction error: {e}")

            # Send watermelon and scorecard data
            try:
                watermelon_data = self._extract_watermelon(context_content)
                if watermelon_data:
                    print(f"  → Emitting watermelon_data ({len(watermelon_data.get('watermelon_signals', []))} signals)")
                    yield {"type": "watermelon_data", "data": watermelon_data}
            except Exception as e:
                print(f"  ⚠ Watermelon extraction error: {e}")

            try:
                scorecard_data = self._extract_scorecard(context_content)
                if scorecard_data:
                    print(f"  → Emitting scorecard_data (health={scorecard_data.get('health_score')})")
                    yield {"type": "scorecard_data", "data": scorecard_data}
            except Exception as e:
                print(f"  ⚠ Scorecard extraction error: {e}")
        except Exception as e:
            yield {"type": "token", "agent": "context-builder", "content": f"⚠️ Could not gather context: {str(e)}"}
            yield {"type": "agent_completed", "agent": "context-builder", "content": f"Error: {str(e)}", "usage": TokenUsage().model_dump()}

        # Phase 2: Customer Data — gathers additional customer data
        yield {"type": "agent_started", "agent": "customer-data"}
        yield {
            "type": "token",
            "agent": "customer-data",
            "content": "📊 Gathering additional customer data and metrics...\n",
        }

        customer_data_content = ""
        try:
            loop = asyncio.get_event_loop()
            customer_data_content, cd_usage, cd_sources = await loop.run_in_executor(
                None, self._collect_agent_response, self.customer_data_name, query
            )

            # Show brief summary
            yield {"type": "token", "agent": "customer-data", "content": f"✅ Customer data collected ({len(customer_data_content)} chars)\n"}

            if cd_sources:
                sources_section = "\n---\n### 📚 Data Sources\n"
                for s in cd_sources:
                    sources_section += f"- {s}\n"
                yield {"type": "token", "agent": "customer-data", "content": sources_section}

            yield {
                "type": "agent_completed",
                "agent": "customer-data",
                "content": f"Customer data collected successfully.",
                "usage": cd_usage.model_dump(),
            }
        except Exception as e:
            yield {"type": "token", "agent": "customer-data", "content": f"⚠️ Could not gather customer data: {str(e)}"}
            yield {"type": "agent_completed", "agent": "customer-data", "content": f"Error: {str(e)}", "usage": TokenUsage().model_dump()}

        # Phase 3: Insights — combines context + customer data into executive briefing
        # Pass both data sources; request bullet points and tables
        insights_input = (
            f"You are preparing an executive briefing for the CEO's Chief of Staff.\n\n"
            f"## Source 1: Context Builder Data\n"
            f"{context_content}\n\n"
            f"## Source 2: Customer Data\n"
            f"{customer_data_content}\n\n"
            f"## Original Request\n"
            f"{query}\n\n"
            f"## Output Format Requirements\n"
            f"Please synthesize both data sources into a comprehensive executive briefing with:\n"
            f"1. **Executive Summary** — 3-5 bullet points of the most critical findings\n"
            f"2. **Key Metrics Table** — A markdown table with columns: Metric | Value | Trend | Risk Level\n"
            f"3. **Strategic Talking Points** — Bullet points the CEO should raise in the meeting\n"
            f"4. **Risk & Opportunity Matrix** — A table with: Item | Type (Risk/Opportunity) | Severity | Recommended Action\n"
            f"5. **Recommended Next Steps** — Prioritized bullet list of actions\n\n"
            f"Use markdown formatting with headers, bullet points, bold text, and tables throughout."
        )
        async for event in self.run_agent(
            self.insights_name, "insights", insights_input
        ):
            yield event

        yield {"type": "done"}

    def evaluate_draft(self, draft_content: str) -> dict:
        """Evaluate a draft document against an executive-briefing rubric.

        Returns a dict with overall_score (0-100), per-criterion scores,
        summary, strengths, and improvements. Uses the insights agent as
        an LLM evaluator returning strict JSON.
        """
        rubric_criteria = [
            "Completeness — covers account, financials, risks, pipeline, and recommendations",
            "Clarity — concise, well-organized, easy for an executive to skim",
            "Grounding — claims are specific and backed by data/sources, not vague",
            "Actionability — provides clear talking points and next steps",
            "Structure & Formatting — effective use of headings, bullets, tables",
            "Executive Readiness — appropriate tone and strategic framing for a CEO",
        ]
        criteria_list = "\n".join(f"- {c}" for c in rubric_criteria)

        eval_prompt = (
            "You are a strict executive-communications evaluator. Score the DRAFT below "
            "against this rubric. Each criterion is scored 1-5 (5 = excellent).\n\n"
            f"## Rubric Criteria\n{criteria_list}\n\n"
            "## DRAFT TO EVALUATE\n"
            f"{draft_content}\n\n"
            "## Output\n"
            "Return ONLY a JSON object (no markdown fences, no preamble) with this exact shape:\n"
            "{\n"
            '  "criteria": [\n'
            '    {"name": "Completeness", "score": <1-5>, "rationale": "<one sentence>"},\n'
            '    {"name": "Clarity", "score": <1-5>, "rationale": "<one sentence>"},\n'
            '    {"name": "Grounding", "score": <1-5>, "rationale": "<one sentence>"},\n'
            '    {"name": "Actionability", "score": <1-5>, "rationale": "<one sentence>"},\n'
            '    {"name": "Structure & Formatting", "score": <1-5>, "rationale": "<one sentence>"},\n'
            '    {"name": "Executive Readiness", "score": <1-5>, "rationale": "<one sentence>"}\n'
            "  ],\n"
            '  "summary": "<2-3 sentence overall assessment>",\n'
            '  "strengths": ["<strength>", "<strength>"],\n'
            '  "improvements": ["<improvement>", "<improvement>"]\n'
            "}"
        )

        if not self.client:
            return self._demo_evaluation(draft_content)

        content, _usage, _sources = self._collect_agent_response(
            self.insights_name, eval_prompt
        )

        try:
            data = self._parse_json(content)
        except (json.JSONDecodeError, TypeError, ValueError):
            return self._demo_evaluation(draft_content)

        criteria = []
        total = 0.0
        count = 0
        for c in data.get("criteria", []):
            try:
                score = float(c.get("score", 0))
            except (TypeError, ValueError):
                score = 0.0
            score = max(0.0, min(5.0, score))
            criteria.append({
                "name": c.get("name", "Criterion"),
                "score": score,
                "max_score": 5.0,
                "rationale": c.get("rationale", ""),
            })
            total += score
            count += 1

        overall = round((total / (count * 5.0)) * 100, 1) if count else 0.0

        return {
            "overall_score": overall,
            "criteria": criteria,
            "summary": data.get("summary", ""),
            "strengths": data.get("strengths", []),
            "improvements": data.get("improvements", []),
        }

    def _demo_evaluation(self, draft_content: str) -> dict:
        """Heuristic fallback evaluation when no agent is available."""
        text = draft_content or ""
        length = len(text)
        has_headers = "#" in text
        has_bullets = ("- " in text) or ("* " in text)
        has_tables = "|" in text
        has_numbers = any(ch.isdigit() for ch in text)

        def clamp(v):
            return max(1.0, min(5.0, v))

        criteria = [
            {"name": "Completeness", "score": clamp(2 + length / 600), "max_score": 5.0,
             "rationale": "Estimated from draft length and section coverage."},
            {"name": "Clarity", "score": clamp(3 + (1 if has_headers else 0)), "max_score": 5.0,
             "rationale": "Headings improve skimmability." if has_headers else "Add headings to improve clarity."},
            {"name": "Grounding", "score": clamp(2 + (2 if has_numbers else 0)), "max_score": 5.0,
             "rationale": "Specific figures present." if has_numbers else "Add concrete data points."},
            {"name": "Actionability", "score": clamp(3 + (1 if has_bullets else 0)), "max_score": 5.0,
             "rationale": "Bulleted actions detected." if has_bullets else "Add clear next steps."},
            {"name": "Structure & Formatting", "score": clamp(2 + (1 if has_headers else 0) + (1 if has_tables else 0)), "max_score": 5.0,
             "rationale": "Tables/headings aid structure." if (has_tables or has_headers) else "Use headings and tables."},
            {"name": "Executive Readiness", "score": clamp(3), "max_score": 5.0,
             "rationale": "Heuristic baseline (agent offline)."},
        ]
        total = sum(c["score"] for c in criteria)
        overall = round((total / (len(criteria) * 5.0)) * 100, 1)
        return {
            "overall_score": overall,
            "criteria": criteria,
            "summary": "Heuristic evaluation (AI evaluator offline). Connect Azure for a full rubric review.",
            "strengths": ["Draft captured" if length else "No content yet"],
            "improvements": ["Add data-backed specifics", "Ensure clear next steps and tables"],
        }

    def _parse_json(self, raw: str) -> dict:
        """Parse JSON from agent output, handling markdown code fences."""
        import re
        text = raw.strip()
        # Strip markdown code fences (```json ... ``` or ``` ... ```)
        match = re.search(r'```(?:json)?\s*\n?(.*?)```', text, re.DOTALL)
        if match:
            text = match.group(1).strip()
        # Try to find a JSON object if raw text has preamble
        if not text.startswith('{'):
            idx = text.find('{')
            if idx >= 0:
                text = text[idx:]
                # Find matching closing brace
                depth = 0
                for i, ch in enumerate(text):
                    if ch == '{': depth += 1
                    elif ch == '}': depth -= 1
                    if depth == 0:
                        text = text[:i+1]
                        break
        return json.loads(text)

    def _summarize_context(self, raw_json: str) -> str:
        """Extract a human-readable summary from the context-builder's JSON output."""
        try:
            data = self._parse_json(raw_json)
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
        except (json.JSONDecodeError, TypeError, ValueError):
            return f"Context gathered ({len(raw_json)} chars). Generating insights...\n"

    def _extract_graph(self, raw_json: str) -> dict:
        """Extract knowledge graph nodes and links from context-builder JSON."""
        try:
            data = self._parse_json(raw_json)
        except (json.JSONDecodeError, TypeError, ValueError):
            return None

        nodes = []
        links = []
        node_ids = set()

        def add_node(nid: str, label: str, group: str, details: str = ""):
            if nid not in node_ids:
                nodes.append({"id": nid, "label": label, "group": group, "details": details})
                node_ids.add(nid)

        # Central account node
        account_name = (data.get("aliases_resolved") or ["Unknown"])[0]
        account_code = data.get("account_code", "")
        add_node("account", account_name, "account", f"Code: {account_code}")

        # Executive / meeting participants
        executive = data.get("executive", "CEO")
        add_node("executive", executive, "person", "Our executive")
        links.append({"source": "executive", "target": "account", "label": "meeting with"})

        counterparty = data.get("counterparty", {})
        if counterparty:
            cp_name = counterparty.get("name", "Contact")
            cp_title = counterparty.get("title", "")
            add_node("counterparty", f"{cp_name} ({cp_title})", "person", "Customer contact")
            links.append({"source": "counterparty", "target": "account", "label": "represents"})

        # Context sections as category nodes
        context = data.get("context", {})

        # Financials
        fin = context.get("financials", {})
        if fin:
            revenue = fin.get("annual_revenue") or fin.get("revenue", "")
            add_node("financials", "Financials", "data", f"Revenue: {revenue}")
            links.append({"source": "account", "target": "financials", "label": "financials"})

        # Telemetry / usage
        tel = context.get("telemetry", {})
        if tel:
            add_node("telemetry", "Usage & Telemetry", "data", str(tel.get("summary", ""))[:100])
            links.append({"source": "account", "target": "telemetry", "label": "telemetry"})

        # Risk
        risk = context.get("risk", {})
        if risk:
            sentiment = risk.get("system_sentiment") or risk.get("overall_risk", "")
            add_node("risk", "Risk Profile", "risk", f"Sentiment: {sentiment}")
            links.append({"source": "account", "target": "risk", "label": "risk"})

        # Staffing
        staff = context.get("staffing", {})
        if staff:
            add_node("staffing", "Staffing", "data", "Team & resource data")
            links.append({"source": "account", "target": "staffing", "label": "staffing"})
            # Add individual team members if available
            team = staff.get("team") or staff.get("key_contacts") or []
            for i, member in enumerate(team[:5]):
                if isinstance(member, dict):
                    name = member.get("name", f"Person {i+1}")
                    role = member.get("role", member.get("title", ""))
                    mid = f"staff_{i}"
                    add_node(mid, name, "person", role)
                    links.append({"source": "staffing", "target": mid, "label": role[:20]})

        # Pipeline / opportunities
        pipeline = context.get("pipeline", {})
        if pipeline:
            add_node("pipeline", "Pipeline", "opportunity", "Deals & opportunities")
            links.append({"source": "account", "target": "pipeline", "label": "pipeline"})
            opps = pipeline.get("opportunities") or pipeline.get("deals") or []
            for i, opp in enumerate(opps[:4]):
                if isinstance(opp, dict):
                    name = opp.get("name", opp.get("deal_name", f"Deal {i+1}"))
                    value = opp.get("value", opp.get("amount", ""))
                    oid = f"opp_{i}"
                    add_node(oid, name, "opportunity", f"Value: {value}")
                    links.append({"source": "pipeline", "target": oid, "label": "deal"})

        # Relationship history
        rel = context.get("relationship_history", {})
        if rel:
            add_node("relationship", "Relationship History", "data", "Past interactions")
            links.append({"source": "account", "target": "relationship", "label": "history"})

        # External context
        ext = context.get("external_context", {})
        if ext:
            add_node("external", "External Intel", "data", "Market & industry data")
            links.append({"source": "account", "target": "external", "label": "external"})

        # Watermelon flags
        flags = data.get("watermelon_flags", [])
        for i, flag in enumerate(flags):
            fid = f"flag_{i}"
            desc = flag if isinstance(flag, str) else json.dumps(flag)[:80]
            add_node(fid, f"⚠️ Flag {i+1}", "risk", desc)
            links.append({"source": "account", "target": fid, "label": "conflict"})

        if not nodes:
            return None

        return {"nodes": nodes, "links": links, "knowledge_graph_ref": data.get("knowledge_graph_ref", "")}

    def _extract_watermelon(self, raw_json: str) -> dict:
        """Extract watermelon reveal data from context-builder JSON."""
        try:
            data = self._parse_json(raw_json)
        except (json.JSONDecodeError, TypeError, ValueError):
            return None

        account_name = (data.get("aliases_resolved") or ["Unknown Account"])[0]
        account_code = data.get("account_code", "")
        context = data.get("context", {})
        fin = context.get("financials", {})
        tel = context.get("telemetry", {})
        risk = context.get("risk", {})
        account_info = context.get("account", {})

        # System metrics (the "green" side)
        system_metrics = {
            "revenue": fin.get("ytd_revenue_usd") or fin.get("annual_revenue") or fin.get("revenue", "N/A"),
            "revenue_growth": fin.get("yoy_growth_pct") or fin.get("growth", ""),
            "consumption_growth": tel.get("mom_growth_pct") or tel.get("growth", ""),
            "nps": risk.get("nps") or account_info.get("nps", ""),
            "support_tickets": risk.get("open_p1_p2") or risk.get("support_tickets", ""),
            "engagement": account_info.get("signals", [{}])[0].get("value", "healthy") if account_info.get("signals") else "N/A",
            "renewal_status": risk.get("renewal_status") or "On Track",
        }

        # Watermelon flags (the "red inside")
        flags = data.get("watermelon_flags", [])
        watermelon_signals = []
        for flag in flags:
            if isinstance(flag, dict):
                watermelon_signals.append({
                    "severity": flag.get("severity", "amber"),
                    "signal": flag.get("signal") or flag.get("description") or flag.get("finding", "Unknown signal"),
                    "source": flag.get("source", "Agent intelligence"),
                })
            elif isinstance(flag, str):
                watermelon_signals.append({"severity": "red", "signal": flag, "source": "Agent intelligence"})

        # Also check risk section for hidden signals
        risk_items = risk.get("risks") or risk.get("risk_factors") or []
        if not watermelon_signals and risk_items:
            for item in risk_items[:5]:
                if isinstance(item, dict):
                    watermelon_signals.append({
                        "severity": item.get("severity", "amber"),
                        "signal": item.get("description") or item.get("risk") or str(item),
                        "source": "Risk analysis",
                    })
                elif isinstance(item, str):
                    watermelon_signals.append({"severity": "amber", "signal": item, "source": "Risk analysis"})

        # Derive signals from open incidents, staffing gaps, and telemetry
        if not watermelon_signals:
            incidents = risk.get("open_incidents", [])
            for inc in incidents[:3]:
                if isinstance(inc, dict):
                    watermelon_signals.append({
                        "severity": "red" if inc.get("severity") == "P1" else "amber",
                        "signal": f"{inc.get('severity', 'P2')} incident: {inc.get('summary', 'Open issue')} (aging {inc.get('aging_days', '?')} days)",
                        "source": risk.get("source", "ServiceNow"),
                    })

            # Staffing concerns
            staffing = context.get("staffing", {})
            if staffing.get("open_roles") and staffing.get("key_open_role"):
                watermelon_signals.append({
                    "severity": "amber",
                    "signal": f"Key role unfilled: {staffing['key_open_role']}",
                    "source": staffing.get("source", "Workday"),
                })
            if staffing.get("attrition_last_quarter", 0) > 1:
                watermelon_signals.append({
                    "severity": "amber",
                    "signal": f"Team attrition: {staffing['attrition_last_quarter']} departures last quarter",
                    "source": staffing.get("source", "Workday"),
                })

            # Telemetry decline
            growth = tel.get("qoq_growth_pct") or tel.get("mom_growth_pct")
            if growth and isinstance(growth, (int, float)) and growth < 0:
                watermelon_signals.append({
                    "severity": "amber",
                    "signal": f"Usage declining: {growth*100:.1f}% QoQ ({tel.get('consumption_trend', 'declining')})",
                    "source": tel.get("source", "Telemetry"),
                })

            # Sentiment not green
            sentiment = risk.get("system_sentiment", "")
            if sentiment in ("amber", "red"):
                watermelon_signals.append({
                    "severity": sentiment,
                    "signal": f"System sentiment: {sentiment} (despite positive revenue metrics)",
                    "source": risk.get("source", "Risk engine"),
                })

        # Agent-adjusted metrics
        agent_metrics = {
            "true_renewal_probability": risk.get("true_renewal_pct") or risk.get("renewal_probability", ""),
            "system_renewal_confidence": risk.get("system_confidence") or "94%",
            "champion_risk": risk.get("champion_risk") or "",
            "competitor_activity": risk.get("competitor_activity") or "",
            "budget_risk": fin.get("budget_risk") or "",
        }

        tier = account_info.get("tier", "")

        return {
            "account_name": account_name,
            "account_code": account_code,
            "tier": tier,
            "system_metrics": system_metrics,
            "watermelon_signals": watermelon_signals,
            "agent_metrics": agent_metrics,
        }

    def _extract_scorecard(self, raw_json: str) -> dict:
        """Extract executive scorecard data from context-builder JSON."""
        try:
            data = self._parse_json(raw_json)
        except (json.JSONDecodeError, TypeError, ValueError):
            return None

        account_name = (data.get("aliases_resolved") or ["Unknown Account"])[0]
        account_code = data.get("account_code", "")
        context = data.get("context", {})
        fin = context.get("financials", {})
        tel = context.get("telemetry", {})
        risk = context.get("risk", {})
        pipeline = context.get("pipeline", {})
        account_info = context.get("account", {})
        staffing = context.get("staffing", {})

        # Revenue
        revenue = fin.get("ytd_revenue_usd") or fin.get("annual_revenue") or fin.get("revenue", 0)
        prior_revenue = fin.get("prior_ytd_revenue_usd", 0)
        if revenue and prior_revenue and isinstance(revenue, (int, float)) and isinstance(prior_revenue, (int, float)) and prior_revenue > 0:
            revenue_growth = f"{((revenue - prior_revenue) / prior_revenue) * 100:.1f}%"
        else:
            revenue_growth = fin.get("yoy_growth_pct") or fin.get("growth_pct", "N/A")
        margin = fin.get("margin_pct", "")
        if isinstance(margin, float) and margin < 1:
            margin = f"{margin * 100:.0f}%"

        # Pipeline
        opps = pipeline.get("opportunities") or pipeline.get("deals") or []
        total_pipeline = sum(
            float(o.get("value", 0) or o.get("amount", 0) or 0)
            for o in opps if isinstance(o, dict)
        )
        deal_count = len(opps)

        # Telemetry
        active_seats = tel.get("monthly_active_seats") or tel.get("active_users", "")
        consumption_trend = tel.get("consumption_trend") or tel.get("trend", "")
        qoq_growth = tel.get("qoq_growth_pct") or tel.get("mom_growth_pct", "")
        if isinstance(qoq_growth, float):
            qoq_growth = f"{qoq_growth * 100:.1f}%"

        # CSAT / NPS
        csat = risk.get("csat") or account_info.get("csat", "")
        csat_prior = risk.get("csat_prior", "")
        nps = risk.get("nps") or account_info.get("nps", "")

        # Health score — derive from system_sentiment if not explicit
        health_score = risk.get("health_score") or risk.get("overall_score", "")
        health_status = risk.get("system_sentiment") or risk.get("overall_risk", "")
        if not health_score and health_status:
            score_map = {"green": 85, "amber": 65, "red": 40}
            health_score = score_map.get(health_status, 70)

        # Risk factors from incidents and flags
        risk_factors = []
        flags = data.get("watermelon_flags", [])
        for flag in flags:
            if isinstance(flag, dict):
                risk_factors.append({
                    "severity": flag.get("severity", "amber"),
                    "description": flag.get("signal") or flag.get("description") or flag.get("finding", ""),
                })
            elif isinstance(flag, str):
                risk_factors.append({"severity": "amber", "description": flag})

        # Add incidents as risk factors
        incidents = risk.get("open_incidents", [])
        for inc in incidents[:3]:
            if isinstance(inc, dict):
                risk_factors.append({
                    "severity": "red" if inc.get("severity") == "P1" else "amber",
                    "description": f"{inc.get('severity', 'P2')}: {inc.get('summary', 'Open incident')}",
                })

        # Staffing
        open_roles = staffing.get("open_roles", 0)
        if open_roles and staffing.get("key_open_role"):
            risk_factors.append({
                "severity": "amber",
                "description": f"Unfilled: {staffing['key_open_role']}",
            })

        # Renewal
        renewal_date = risk.get("renewal_date") or fin.get("renewal_date", "")
        renewal_status = risk.get("renewal_status") or "On Track"

        tier = account_info.get("tier", "")

        return {
            "account_name": account_name,
            "account_code": account_code,
            "tier": tier,
            "health_score": health_score,
            "health_status": health_status,
            "revenue": revenue,
            "revenue_growth": revenue_growth,
            "margin": margin,
            "pipeline_value": total_pipeline,
            "deal_count": deal_count,
            "active_seats": active_seats,
            "consumption_trend": consumption_trend,
            "qoq_growth": qoq_growth,
            "nps": nps,
            "csat": csat,
            "csat_prior": csat_prior,
            "risk_factors": risk_factors,
            "renewal_date": renewal_date,
            "renewal_status": renewal_status,
            "open_p1": risk.get("open_P1", 0),
            "staffing_ftes": staffing.get("billable_ftes", ""),
            "staffing_open_roles": open_roles,
        }

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
