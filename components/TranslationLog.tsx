
import React, { useEffect, useRef } from 'react';
import { Transcription } from '../types';

interface TranslationLogProps {
  transcriptions: Transcription[];
}

export const TranslationLog: React.FC<TranslationLogProps> = ({ transcriptions }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcriptions]);

  return (
    <div 
      ref={scrollRef}
      className="flex-1 overflow-y-auto space-y-4 p-4 scroll-smooth"
    >
      {transcriptions.length === 0 ? (
        <div className="h-full flex items-center justify-center text-slate-500 text-sm italic">
          Start speaking to see translations...
        </div>
      ) : (
        transcriptions.map((t, i) => (
          <div 
            key={`${t.timestamp}-${i}`}
            className={`flex flex-col ${t.role === 'user' ? 'items-end' : 'items-start'}`}
          >
            <div className={`max-w-[85%] rounded-2xl p-4 shadow-sm ${
              t.role === 'user' 
                ? 'bg-blue-600 text-white rounded-tr-none' 
                : 'bg-slate-800 text-slate-100 rounded-tl-none border border-slate-700'
            }`}>
              <p className="text-sm leading-relaxed">{t.text}</p>
            </div>
            <span className="text-[10px] text-slate-500 mt-1 uppercase tracking-wider font-semibold">
              {t.role === 'user' ? 'Original' : 'Translated'}
            </span>
          </div>
        ))
      )}
    </div>
  );
};
