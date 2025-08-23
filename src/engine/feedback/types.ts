// Shared types for the feedback system

export interface TranscriptMessage {
  type: 'user' | 'assistant' | 'system';
  uuid: string;
  parentUuid: string;
  sessionId: string;
  timestamp: string;
  version: string;
  cwd: string;
  gitBranch: string;
  isSidechain: boolean;
  userType: string;
  message: {
    role: string;
    content: Array<{
      type: string;
      text?: string;
      name?: string;
      id?: string;
      input?: any;
      tool_use_id?: string;
    }>;
    id?: string;
    model?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  requestId?: string;
  toolUseResult?: any;
}

export interface MessageMetadata {
  id?: number;
  workspace_id?: string;
  session_id: string;
  message_uuid: string;
  parent_uuid?: string;
  timestamp: string;
  type: string;
  role?: string;
  summary?: string;
  intent?: string;
  project_context?: string;
  compliance_score?: number;
  efficiency_score?: number;
  created_at: number;
}

export interface Feedback {
  id?: number;
  workspace_id?: string;
  session_id: string;
  message_uuid: string;
  feedback_type: 'overstepping' | 'verbose' | 'inefficient' | 'good' | 'none';
  severity: 'good' | 'annoying' | 'problematic';
  remark?: string;
  funny_observation?: string;
  icon?: string;
  shown: boolean;
  expires_at?: number;
  created_at: number;
}

export interface ProcessingLock {
  message_uuid: string;
  process_pid: number;
  locked_at: number;
  completed: boolean;
  completed_at?: number;
}

export interface AnalysisState {
  id: number;
  last_processed_uuid?: string;
  last_processed_timestamp?: number;
  total_messages_processed: number;
  last_cleanup_at?: number;
}

export interface LLMAnalysisResult {
  compliance_score: number;
  efficiency_score: number;
  feedback_type: 'overstepping' | 'verbose' | 'inefficient' | 'good' | 'none';
  severity: 'good' | 'annoying' | 'problematic';
  remark?: string;
  funny_observation?: string;
  summary: string;
  intent?: string;
  project_context?: string;
}

export interface FeedbackConfig {
  enabled: boolean;
  mode: 'full' | 'passive' | 'off';
  checkInterval: number;
  batchSize: number;
  minMessages: number;
  staleLockTime: number;
  dbPath: string;
  dbMaxSize: number;
  // AI Provider Selection
  aiProvider: 'groq' | 'openai';
  // Legacy individual provider configs (for backward compatibility)
  groqApiKey?: string;
  groqModel: string;
  groqTimeout: number;
  groqMaxRetries: number;
  openaiApiKey?: string;
  openaiModel: string;
  openaiTimeout: number;
  openaiMaxRetries: number;
}