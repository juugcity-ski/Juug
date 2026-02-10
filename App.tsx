
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { TranslationLog } from './components/TranslationLog';
import { AudioVisualizer } from './components/AudioVisualizer';
import { Transcription, TranslationMode, TranslationSessionState } from './types';
import { createBlob, decode, decodeAudioData, encode } from './utils/audio-processing';

const API_KEY = process.env.API_KEY || '';

const App: React.FC = () => {
  // --- States ---
  const [session, setSessionState] = useState<TranslationSessionState>({
    isActive: false,
    isConnecting: false,
    mode: TranslationMode.AUTO,
    error: null,
  });
  const [transcriptions, setTranscriptions] = useState<Transcription[]>([]);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);

  // --- Refs ---
  const aiRef = useRef<any>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const transcriptionBufferRef = useRef({ user: '', model: '' });

  // --- Audio Cleanup ---
  const cleanupAudio = useCallback(() => {
    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }
    if (micStream) {
      micStream.getTracks().forEach(track => track.stop());
      setMicStream(null);
    }
    sourcesRef.current.forEach(source => source.stop());
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  }, [micStream]);

  const toggleSession = async () => {
    if (session.isActive) {
      // Close session
      if (sessionPromiseRef.current) {
        const activeSession = await sessionPromiseRef.current;
        activeSession.close();
      }
      cleanupAudio();
      setSessionState(prev => ({ ...prev, isActive: false, isConnecting: false }));
    } else {
      // Start session
      startSession();
    }
  };

  const startSession = async () => {
    try {
      setSessionState(prev => ({ ...prev, isConnecting: true, error: null }));
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicStream(stream);

      const ai = new GoogleGenAI({ apiKey: API_KEY });
      aiRef.current = ai;

      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction: `You are a real-time voice translator between English and Spanish. 
            - When you hear English, translate it precisely into Spanish.
            - When you hear Spanish, translate it precisely into English.
            - Provide ONLY the translation as audio output. No conversational fillers or explanations.
            - If you are unsure or the audio is unclear, stay silent or ask briefly for clarification in the detected language.`,
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            console.log('Gemini Live session opened');
            setSessionState(prev => ({ ...prev, isActive: true, isConnecting: false }));

            // Start streaming microphone data
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then((s) => s.sendRealtimeInput({ media: pcmBlob }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Transcription
            if (message.serverContent?.inputTranscription) {
              transcriptionBufferRef.current.user += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              transcriptionBufferRef.current.model += message.serverContent.outputTranscription.text;
            }
            if (message.serverContent?.turnComplete) {
              const userText = transcriptionBufferRef.current.user.trim();
              const modelText = transcriptionBufferRef.current.model.trim();
              
              if (userText || modelText) {
                setTranscriptions(prev => [
                  ...prev,
                  ...(userText ? [{ role: 'user', text: userText, timestamp: Date.now() }] as Transcription[] : []),
                  ...(modelText ? [{ role: 'model', text: modelText, timestamp: Date.now() + 1 }] as Transcription[] : [])
                ]);
              }
              transcriptionBufferRef.current = { user: '', model: '' };
            }

            // Handle Audio Output
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && outputAudioContextRef.current) {
              const ctx = outputAudioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              
              const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              const sourceNode = ctx.createBufferSource();
              sourceNode.buffer = audioBuffer;
              sourceNode.connect(ctx.destination);
              
              sourceNode.addEventListener('ended', () => {
                sourcesRef.current.delete(sourceNode);
              });

              sourceNode.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(sourceNode);
            }

            // Handle Interruptions
            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => s.stop());
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (err) => {
            console.error('Session error:', err);
            setSessionState(prev => ({ ...prev, error: 'Connection error occurred.', isActive: false, isConnecting: false }));
          },
          onclose: () => {
            console.log('Session closed');
            setSessionState(prev => ({ ...prev, isActive: false, isConnecting: false }));
          }
        }
      });

      sessionPromiseRef.current = sessionPromise;

    } catch (err: any) {
      console.error('Failed to start session:', err);
      setSessionState(prev => ({ ...prev, error: err.message || 'Failed to connect.', isConnecting: false }));
    }
  };

  return (
    <div className="flex flex-col h-screen max-w-lg mx-auto bg-slate-950 text-slate-100 overflow-hidden relative">
      {/* Header */}
      <header className="px-6 py-4 flex items-center justify-between glass-panel sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className={`w-3 h-3 rounded-full ${session.isActive ? 'bg-green-500 animate-pulse' : 'bg-slate-600'}`}></div>
          <h1 className="font-bold text-lg tracking-tight">The Juug Translator</h1>
        </div>
        <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
          <span className="px-2 py-1 rounded-full bg-slate-800 border border-slate-700">EN</span>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>
          <span className="px-2 py-1 rounded-full bg-slate-800 border border-slate-700">ES</span>
        </div>
      </header>

      {/* Main Translation Feed */}
      <main className="flex-1 flex flex-col min-h-0">
        <TranslationLog transcriptions={transcriptions} />
      </main>

      {/* Control Area */}
      <footer className="p-6 pb-10 glass-panel border-t border-slate-800 space-y-6">
        {session.error && (
          <div className="text-red-400 text-xs bg-red-950/30 border border-red-900/50 p-2 rounded text-center mb-2">
            {session.error}
          </div>
        )}

        <div className="flex flex-col items-center gap-4">
          <AudioVisualizer stream={micStream} isActive={session.isActive} />
          
          <button
            onClick={toggleSession}
            disabled={session.isConnecting}
            className={`w-20 h-20 rounded-full flex items-center justify-center transition-all duration-300 transform active:scale-95 ${
              session.isActive 
                ? 'bg-red-500 hover:bg-red-600 shadow-lg shadow-red-500/20' 
                : 'bg-blue-600 hover:bg-blue-700 shadow-lg shadow-blue-500/20'
            } ${session.isConnecting ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {session.isConnecting ? (
              <svg className="animate-spin h-8 w-8 text-white" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            ) : session.isActive ? (
              <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" /></svg>
            ) : (
              <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
            )}
          </button>
          
          <p className="text-slate-400 text-sm font-medium">
            {session.isActive ? 'Tap to stop translating' : session.isConnecting ? 'Connecting...' : 'Tap to start voice translation'}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <button className="flex items-center justify-center gap-2 py-3 px-4 bg-slate-800 rounded-xl text-sm font-semibold border border-slate-700 hover:bg-slate-700 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
            Save Log
          </button>
          <button 
            onClick={() => setTranscriptions([])}
            className="flex items-center justify-center gap-2 py-3 px-4 bg-slate-800 rounded-xl text-sm font-semibold border border-slate-700 hover:bg-slate-700 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            Clear
          </button>
        </div>
      </footer>

      {/* Visual background details */}
      <div className="absolute -top-24 -left-24 w-64 h-64 bg-blue-500/10 rounded-full blur-3xl pointer-events-none"></div>
      <div className="absolute -bottom-24 -right-24 w-64 h-64 bg-blue-600/10 rounded-full blur-3xl pointer-events-none"></div>
    </div>
  );
};

export default App;
