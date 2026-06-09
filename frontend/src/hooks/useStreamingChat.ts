import { useCallback, useRef, useState } from 'react';
import { StreamEvent } from '../types';

export function useStreamingChat() {
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    async (
      sessionId: string,
      content: string,
      onEvent: (event: StreamEvent) => void
    ) => {
      setIsStreaming(true);
      abortRef.current = new AbortController();

      try {
        const response = await fetch('/api/chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, content }),
          signal: abortRef.current.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response body');

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (!data) continue;

              try {
                const event: StreamEvent = JSON.parse(data);
                if (event.type === 'agent_started') {
                  setActiveAgent(event.agent || null);
                } else if (event.type === 'done') {
                  setActiveAgent(null);
                }
                onEvent(event);
              } catch {
                // Skip malformed events
              }
            }
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name !== 'AbortError') {
          onEvent({ type: 'error', error: err.message });
        }
      } finally {
        setIsStreaming(false);
        setActiveAgent(null);
      }
    },
    []
  );

  const cancelStream = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
    setActiveAgent(null);
  }, []);

  return { sendMessage, cancelStream, isStreaming, activeAgent };
}
