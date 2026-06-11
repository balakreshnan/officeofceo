import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Voice read-out hook. Plays text aloud using the backend AUDIO_MODEL
 * (gpt-realtime) text-to-speech endpoint, falling back to the browser
 * SpeechSynthesis API when the backend is unavailable.
 *
 * Tracks a caller-supplied `id` so the UI can show per-item playing state.
 */
export function useSpeech() {
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  const cleanup = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const stop = useCallback(() => {
    cleanup();
    setSpeakingId(null);
    setLoadingId(null);
  }, [cleanup]);

  const browserSpeak = useCallback((text: string, id: string) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      setLoadingId(null);
      setSpeakingId(null);
      return;
    }
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.0;
    utter.pitch = 1.0;
    utter.onend = () => setSpeakingId(prev => (prev === id ? null : prev));
    utter.onerror = () => setSpeakingId(prev => (prev === id ? null : prev));
    setLoadingId(null);
    setSpeakingId(id);
    window.speechSynthesis.speak(utter);
  }, []);

  const speak = useCallback(async (rawText: string, id: string, voice = 'alloy') => {
    const text = (rawText || '').replace(/\s+/g, ' ').trim();
    if (!text) return;

    // Toggle off if the same item is already active.
    if (speakingId === id || loadingId === id) {
      stop();
      return;
    }

    cleanup();
    setLoadingId(id);
    setSpeakingId(null);

    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice }),
      });
      if (!res.ok) throw new Error(`TTS ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => stop();
      audio.onerror = () => browserSpeak(text, id);
      setLoadingId(null);
      setSpeakingId(id);
      await audio.play();
    } catch {
      // Backend unavailable — fall back to browser speech synthesis.
      browserSpeak(text, id);
    }
  }, [speakingId, loadingId, stop, cleanup, browserSpeak]);

  useEffect(() => cleanup, [cleanup]);

  return { speak, stop, speakingId, loadingId };
}
