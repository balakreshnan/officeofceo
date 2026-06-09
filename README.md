# Office of CEO - Insights Builder

AI-powered executive insights platform for CEO meeting preparation. Uses Microsoft Foundry agents to research customers and generate strategic insights.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  React Frontend (Vite + TypeScript)                 │
│  • Chat & Voice Input                              │
│  • Streaming Output with Markdown                  │
│  • Editable Responses                              │
│  • Session Management & Token Tracking             │
└──────────────────────┬──────────────────────────────┘
                       │ SSE (Server-Sent Events)
┌──────────────────────▼──────────────────────────────┐
│  FastAPI Backend                                    │
│  • Session Management (REST)                       │
│  • Streaming Chat (SSE)                            │
│  • Agent Orchestration                             │
└──────────────────────┬──────────────────────────────┘
                       │ Azure AI Projects SDK
┌──────────────────────▼──────────────────────────────┐
│  Microsoft Foundry Agents                           │
│  • oceo-context-builder (Customer Research)        │
│  • oceo-insights (Strategic Analysis)              │
└─────────────────────────────────────────────────────┘
```

## Features

- **Chat-based & Voice Input** - Type or speak your queries
- **Dual-Agent Pipeline** - Context Builder gathers research → Insights Agent generates executive briefing
- **Streaming Output** - Real-time token-by-token response display
- **Editable Responses** - Click to edit any AI response, with revert capability
- **Session Management** - Create, switch, and manage conversation sessions
- **Token Tracking** - Cumulative token usage displayed per session
- **Professional UI** - Dark-themed business executive aesthetic

## Prerequisites

- Python 3.11+
- Node.js 18+
- Azure subscription with AI Foundry project
- Two agents created in Foundry: `oceo-context-builder` and `oceo-insights`

## Setup

### Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate   # Windows
pip install -r requirements.txt

# Configure environment
cp .env.example .env
# Edit .env with your Azure AI Project connection string
```

### Frontend

```bash
cd frontend
npm install
```

## Running

### Development

```bash
# Terminal 1 - Backend
cd backend
uvicorn main:app --reload --port 8000

# Terminal 2 - Frontend
cd frontend
npm run dev
```

The frontend runs at `http://localhost:5173` with API proxy to backend.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `AZURE_AI_PROJECT_CONNECTION_STRING` | Azure AI Foundry project connection string |
| `CONTEXT_BUILDER_AGENT_NAME` | Name of context builder agent (default: `oceo-context-builder`) |
| `INSIGHTS_AGENT_NAME` | Name of insights agent (default: `oceo-insights`) |

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sessions` | List all sessions |
| POST | `/api/sessions` | Create new session |
| GET | `/api/sessions/{id}` | Get session with messages |
| DELETE | `/api/sessions/{id}` | Delete session |
| POST | `/api/chat/stream` | Send message (SSE streaming) |
| PUT | `/api/messages/edit` | Edit a message |
| GET | `/api/health` | Health check |

## Agent Orchestration Flow

1. User submits query (chat or voice)
2. Backend invokes `oceo-context-builder` → streams research context
3. Backend passes context to `oceo-insights` → streams strategic insights
4. Both responses stream to UI in real-time with agent badges
5. Token usage tracked and displayed cumulatively
Office of CEO - Chief of Staff Project
