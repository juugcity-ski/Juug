
export interface Transcription {
  role: 'user' | 'model';
  text: string;
  timestamp: number;
}

export enum TranslationMode {
  AUTO = 'AUTO',
  EN_TO_ES = 'EN_TO_ES',
  ES_TO_EN = 'ES_TO_EN'
}

export interface TranslationSessionState {
  isActive: boolean;
  isConnecting: boolean;
  mode: TranslationMode;
  error: string | null;
}
