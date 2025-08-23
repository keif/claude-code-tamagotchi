#!/usr/bin/env bun

/**
 * Background worker for analyzing transcript messages
 * Runs as a detached process to avoid blocking the main statusline
 */

import { FeedbackDatabase } from '../engine/feedback/FeedbackDatabase';
import { MessageProcessor } from '../engine/feedback/MessageProcessor';
import { LLMProviderFactory, ILLMProvider } from '../llm/LLMProvider';
import { 
  TranscriptMessage, 
  MessageMetadata, 
  Feedback,
  LLMAnalysisResult 
} from '../engine/feedback/types';
import * as fs from 'fs';
import * as path from 'path';

// Debug logging
function debug(message: string): void {
  if (process.env.PET_FEEDBACK_DEBUG === 'true') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [Worker:${process.pid}] ${message}\n`;
    
    // Log to console
    console.log(logMessage.trim());
    
    // Log to file if specified
    const logDir = process.env.PET_FEEDBACK_LOG_DIR;
    if (logDir) {
      try {
        // Create log directory if it doesn't exist
        if (!fs.existsSync(logDir)) {
          fs.mkdirSync(logDir, { recursive: true });
        }
        const logFile = path.join(logDir, 'feedback-worker.log');
        fs.appendFileSync(logFile, logMessage);
      } catch {
        // Ignore logging errors
      }
    }
  }
}

// Parse command line arguments
const [transcriptPath, sessionId, dbPath, petStateJson] = process.argv.slice(2);

if (!transcriptPath || !sessionId || !dbPath) {
  console.error('Usage: analyze-transcript.ts <transcript_path> <session_id> <db_path> [pet_state_json]');
  process.exit(1);
}

// Parse pet state if provided
let petState: any = null;
if (petStateJson) {
  try {
    petState = JSON.parse(petStateJson);
    debug(`Pet state: hunger=${petState.hunger}, energy=${petState.energy}, cleanliness=${petState.cleanliness}, happiness=${petState.happiness}`);
  } catch (error) {
    debug(`Failed to parse pet state: ${error}`);
  }
}

debug(`Worker started for session ${sessionId}`);

// Configuration from environment
const config = {
  // AI Provider configuration
  aiProvider: (process.env.PET_AI_PROVIDER as 'groq' | 'openai') || 'openai',
  // Provider-specific config
  groqApiKey: process.env.PET_GROQ_API_KEY || process.env.GROQ_API_KEY,
  groqModel: process.env.PET_GROQ_MODEL || 'openai/gpt-oss-20b',
  groqTimeout: parseInt(process.env.PET_GROQ_TIMEOUT || '2000'),
  openaiApiKey: process.env.PET_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
  openaiModel: process.env.PET_OPENAI_MODEL || 'gpt-3.5-turbo',
  openaiTimeout: parseInt(process.env.PET_OPENAI_TIMEOUT || '2000'),
  // Other config
  batchSize: parseInt(process.env.PET_FEEDBACK_BATCH_SIZE || '10'),
  staleLockTime: parseInt(process.env.PET_FEEDBACK_STALE_LOCK_TIME || '30000')
};

// Initialize components
const db = new FeedbackDatabase(dbPath);
const processor = new MessageProcessor(db, config.staleLockTime);

// Create LLM provider based on configuration
const providerConfig = {
  provider: config.aiProvider,
  apiKey: config.aiProvider === 'groq' ? config.groqApiKey : config.openaiApiKey,
  model: config.aiProvider === 'groq' ? config.groqModel : config.openaiModel,
  timeout: config.aiProvider === 'groq' ? config.groqTimeout : config.openaiTimeout,
  maxRetries: 2
};

debug(`Using ${config.aiProvider.toUpperCase()} provider with model: ${providerConfig.model}`);
let llmProvider: ILLMProvider;

async function initializeLLMProvider() {
  try {
    llmProvider = await LLMProviderFactory.createProvider(providerConfig);
    debug(`${config.aiProvider.toUpperCase()} provider initialized successfully`);
  } catch (error) {
    debug(`Failed to initialize ${config.aiProvider.toUpperCase()} provider: ${error}`);
    process.exit(1);
  }
}

// Main worker function
async function runWorker() {
  // Initialize LLM provider
  await initializeLLMProvider();

// Get recent funny observations for this session to avoid repetition
if (petState) {
  try {
    const recentObservations = db.getRecentFunnyObservations(sessionId, 10);
    petState.thoughtHistory = recentObservations;
    debug(`Loaded ${recentObservations.length} recent observations for session ${sessionId}`);
  } catch (error) {
    debug(`Failed to load recent observations: ${error}`);
    petState.thoughtHistory = [];
  }
}

/**
 * Main analysis function
 */
async function analyzeTranscript() {
  try {
    debug(`Starting analysis for transcript: ${transcriptPath}`);
    
    // Claim messages for processing
    const messages = await processor.claimMessagesForProcessing(
      transcriptPath, 
      config.batchSize
    );
    
    if (messages.length === 0) {
      debug('No new messages to process');
      return;
    }
    
    debug(`Processing ${messages.length} messages...`);
    
    // Get all messages for context
    const allMessages = await processor.readTranscript(transcriptPath);
    debug(`Total messages in transcript: ${allMessages.length}`);
    
    // Process each message
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      debug(`Processing message ${i+1}/${messages.length}: ${message.uuid} (${message.type})`);
      
      try {
        await processMessage(message, allMessages, sessionId, transcriptPath);
      } catch (error) {
        debug(`Failed to process message ${message.uuid}: ${error}`);
        console.error(`Failed to process message ${message.uuid}:`, error);
      }
    }
    
    // Mark all messages as processed
    const uuids = messages.map(m => m.uuid);
    processor.markMessagesProcessed(uuids);
    debug(`Marked ${uuids.length} messages as processed`);
    
    // Cleanup old data if needed
    db.checkAndCleanup();
    
  } catch (error) {
    debug(`Analysis failed: ${error}`);
    console.error('Analysis failed:', error);
  } finally {
    db.close();
    debug('Worker completed');
  }
}

/**
 * Process a single message
 */
async function processMessage(
  message: TranscriptMessage,
  allMessages: TranscriptMessage[],
  sessionId: string,
  transcriptPath: string
): Promise<void> {
  // Get workspace ID for isolation
  const workspaceId = FeedbackDatabase.extractWorkspaceId(transcriptPath);
  // Get message index for context
  const messageIndex = allMessages.findIndex(m => m.uuid === message.uuid);
  
  // Extract message content regardless of type
  const extracted = processor.extractMessageContent(message);
  
  // Process based on message type
  if (message.type === 'user') {
    debug(`Processing user message: ${message.uuid}`);
    
    const userContent = extracted.content || 'No content';
    
    // Check if this is a tool result (not an actual user message)
    // Tool results have specific patterns or are system-generated responses
    const isToolResult = userContent.startsWith('[Tool Result:') || 
                        userContent.startsWith('[[Tool output]]') ||
                        userContent.includes('Tool ran without output') ||
                        userContent.includes('Applied ') && userContent.includes(' edits to ') ||
                        userContent.includes('The file ') && userContent.includes(' has been ') ||
                        (userContent.startsWith('```') && userContent.length < 100) || // Short code blocks are often tool outputs
                        userContent === 'Processed request' ||
                        message.type === 'tool_result'; // Some transcripts mark these explicitly
    
    if (isToolResult) {
      // This is a tool result - find which tool was called and format it
      debug(`Processing tool result message: ${message.uuid}`);
      debug(`Tool result content preview: "${userContent.slice(0, 50)}..."`);
      
      const toolCall = processor.findToolCallForResult(allMessages, message);
      let summary = '[Tool output]';
      
      if (toolCall) {
        // Format based on tool type
        const { toolName, toolInput } = toolCall;
        
        switch (toolName) {
          case 'Read':
            summary = `Tool: Read - ${toolInput.file_path || 'unknown file'}`;
            if (toolInput.limit) summary += ` (limit: ${toolInput.limit})`;
            if (toolInput.offset) summary += ` (offset: ${toolInput.offset})`;
            break;
          
          case 'Edit':
            summary = `Tool: Edit - ${toolInput.file_path || 'unknown file'}`;
            if (toolInput.old_string) {
              const preview = toolInput.old_string.slice(0, 30).replace(/\n/g, ' ');
              summary += ` (replacing: "${preview}...")`;
            }
            break;
          
          case 'Write':
            summary = `Tool: Write - ${toolInput.file_path || 'unknown file'}`;
            break;
          
          case 'MultiEdit':
            summary = `Tool: MultiEdit - ${toolInput.file_path || 'unknown file'}`;
            if (toolInput.edits) summary += ` (${toolInput.edits.length} edits)`;
            break;
          
          case 'Bash':
            const cmd = toolInput.command || 'unknown command';
            const shortCmd = cmd.length > 50 ? cmd.slice(0, 47) + '...' : cmd;
            summary = `Tool: Bash - ${shortCmd}`;
            break;
          
          case 'Glob':
            summary = `Tool: Glob - pattern: ${toolInput.pattern || 'unknown'}`;
            if (toolInput.path) summary += ` in ${toolInput.path}`;
            break;
          
          case 'Grep':
            summary = `Tool: Grep - "${toolInput.pattern || 'unknown'}"`;
            if (toolInput.path) summary += ` in ${toolInput.path}`;
            break;
          
          case 'LS':
            summary = `Tool: LS - ${toolInput.path || 'unknown path'}`;
            break;
          
          case 'WebFetch':
            summary = `Tool: WebFetch - ${toolInput.url || 'unknown URL'}`;
            break;
          
          case 'WebSearch':
            summary = `Tool: WebSearch - "${toolInput.query || 'unknown query'}"`;
            break;
          
          case 'Task':
            summary = `Tool: Task - ${toolInput.description || 'unknown task'}`;
            break;
            
          case 'TodoWrite':
            summary = `Tool: TodoWrite`;
            if (toolInput.todos && Array.isArray(toolInput.todos)) {
              summary += ` - ${toolInput.todos.length} tasks`;
            }
            break;
          
          default:
            summary = `Tool: ${toolName}`;
            break;
        }
        
        debug(`Formatted tool call: ${summary}`);
      }
      
      const metadata: MessageMetadata = {
        workspace_id: workspaceId,
        session_id: sessionId,
        message_uuid: message.uuid,
        parent_uuid: message.parentUuid,
        timestamp: message.timestamp,
        type: 'tool_call',  // Use 'tool_call' to distinguish from user/assistant
        role: 'system',
        summary: summary,
        intent: 'Tool execution',
        created_at: Date.now()
      };
      
      db.saveMessageMetadata(metadata);
      debug(`Saved tool call: "${summary}"`);
      return;
    }
    
    // This is a real user message - analyze it with LLM for proper summary
    debug(`Analyzing real user message with LLM: ${message.uuid}`);
    debug(`User message preview: "${userContent.slice(0, 100)}..."`);
    
    // Get session history for context
    const sessionMetadata = db.getSessionMetadata(sessionId);
    const sessionHistory: string[] = [];
    for (const meta of sessionMetadata) {
      if (meta.message_uuid === message.uuid) break;
      if (meta.summary) {
        if (meta.type === 'user') {
          sessionHistory.push(`User: ${meta.summary}`);
        } else if (meta.type === 'assistant') {
          sessionHistory.push(`Claude: ${meta.summary}`);
        } else if (meta.type === 'tool_call') {
          sessionHistory.push(`[${meta.summary}]`);
        }
      }
    }
    
    // Analyze user message with full context
    const analysis = await llmProvider.analyzeUserMessage(
      userContent,
      sessionHistory
    );
    
    // Save user message metadata with LLM-generated summary
    const metadata: MessageMetadata = {
      workspace_id: workspaceId,
      session_id: sessionId,
      message_uuid: message.uuid,
      parent_uuid: message.parentUuid,
      timestamp: message.timestamp,
      type: message.type,
      role: message.message?.role,
      summary: analysis.summary || userContent,
      intent: analysis.intent || 'User request',
      created_at: Date.now()
    };
    
    db.saveMessageMetadata(metadata);
    debug(`Saved user message with LLM summary: "${metadata.summary}"`);
    return;
    
  } else if (message.type === 'system') {
    // Handle system messages (errors, reminders, file opens, etc)
    debug(`Processing system message: ${message.uuid}`);
    
    const systemContent = extracted.content || 'System message';
    
    // Save system message metadata
    const metadata: MessageMetadata = {
      workspace_id: workspaceId,
      session_id: sessionId,
      message_uuid: message.uuid,
      parent_uuid: message.parentUuid,
      timestamp: message.timestamp,
      type: message.type,
      role: 'system',
      summary: `System: ${systemContent.slice(0, 100)}`,
      created_at: Date.now()
    };
    
    db.saveMessageMetadata(metadata);
    return;
    
  } else if (message.type !== 'assistant') {
    // Handle other message types (tool results, etc)
    debug(`Processing ${message.type} message: ${message.uuid}`);
    
    const metadata: MessageMetadata = {
      workspace_id: workspaceId,
      session_id: sessionId,
      message_uuid: message.uuid,
      parent_uuid: message.parentUuid,
      timestamp: message.timestamp,
      type: message.type,
      role: message.message?.role,
      summary: `${message.type}: ${extracted.content?.slice(0, 100) || 'No content'}`,
      created_at: Date.now()
    };
    
    db.saveMessageMetadata(metadata);
    return;
  }
  
  // Process assistant messages (existing logic)
  debug(`Analyzing assistant message: ${message.uuid}`);
  
  // Get context - look back up to 10 messages to find user request
  const context = await processor.getMessageContext(allMessages, messageIndex, 10);
  
  // Extract Claude's actions with specific details - keep FULL content up to 50k chars
  const claudeActions: string[] = [];
  
  if (extracted.content) {
    // Only slice if truly massive (over 50k chars)
    const content = extracted.content.length > 50000 
      ? extracted.content.slice(0, 50000) + '... [truncated]'
      : extracted.content;
    claudeActions.push(`Text: ${content}`);
  }
  
  // Include specific tool details for better feedback
  for (const tool of extracted.tools || []) {
    let toolDescription = `Tool: ${tool.name}`;
    
    // Add specific details based on tool type
    if (tool.input) {
      switch (tool.name) {
        case 'Read':
          if (tool.input.file_path) {
            toolDescription = `Tool: Read - ${tool.input.file_path}`;
          }
          break;
        case 'Edit':
        case 'Write':
        case 'MultiEdit':
          if (tool.input.file_path) {
            toolDescription = `Tool: ${tool.name} - ${tool.input.file_path}`;
          }
          break;
        case 'Bash':
          if (tool.input.command) {
            const cmd = tool.input.command.length > 50 
              ? tool.input.command.slice(0, 47) + '...'
              : tool.input.command;
            toolDescription = `Tool: Bash - "${cmd}"`;
          }
          break;
        case 'Grep':
          if (tool.input.pattern) {
            toolDescription = `Tool: Grep - pattern: "${tool.input.pattern}"`;
            if (tool.input.path) toolDescription += ` in ${tool.input.path}`;
          }
          break;
        case 'Glob':
          if (tool.input.pattern) {
            toolDescription = `Tool: Glob - pattern: "${tool.input.pattern}"`;
            if (tool.input.path) toolDescription += ` in ${tool.input.path}`;
          }
          break;
      }
    }
    
    claudeActions.push(toolDescription);
  }
  
  // Get FULL session history for complete context (with workspace isolation)
  const sessionMetadata = db.getSessionMetadata(sessionId, workspaceId);
  
  // Build session narrative from all previous messages
  const sessionHistory: string[] = [];
  for (const meta of sessionMetadata) {
    // Skip the current message being processed
    if (meta.message_uuid === message.uuid) break;
    
    // Build a narrative entry for each message with summary
    if (meta.summary) {
      if (meta.type === 'user') {
        sessionHistory.push(`User: ${meta.summary}`);
      } else if (meta.type === 'assistant') {
        sessionHistory.push(`Claude: ${meta.summary}`);
      } else if (meta.type === 'tool_call') {
        // Include all tool calls equally
        sessionHistory.push(`[${meta.summary}]`);
      } else if (meta.type === 'system' && meta.type !== 'tool_result') {
        // Include important system messages for context
        sessionHistory.push(`[${meta.summary}]`);
      }
    }
  }
  
  debug(`Session history contains ${sessionHistory.length} entries`);
  
  // Skip TodoWrite-only messages - they're not interesting for observations
  const isOnlyTodoWrite = extracted.tools && 
                          extracted.tools.length === 1 && 
                          extracted.tools[0].name === 'TodoWrite' &&
                          !extracted.content; // No text response, just todo
  
  if (isOnlyTodoWrite) {
    debug(`Skipping TodoWrite-only message - not interesting for observations`);
    
    // Still save metadata but with a simple summary
    const metadata: MessageMetadata = {
      workspace_id: workspaceId,
      session_id: sessionId,
      message_uuid: message.uuid,
      parent_uuid: message.parentUuid,
      timestamp: message.timestamp,
      type: message.type,
      role: message.message?.role,
      summary: 'Updated task list',
      intent: context.userRequest || 'Task management',
      created_at: Date.now()
    };
    
    db.saveMessageMetadata(metadata);
    return;
  }
  
  // Analyze with LLM
  debug(`Calling ${config.aiProvider.toUpperCase()} API for analysis...`);
  debug(`User request: "${context.userRequest || 'No specific request'}"`);
  debug(`Claude actions: ${claudeActions.join(', ') || 'None'}`);
  
  const analysis = await llmProvider.analyzeExchange(
    context.userRequest || 'No specific request',
    claudeActions,
    sessionHistory,
    undefined, // project context
    petState // pass pet state for contextual remarks
  );
  
  debug(`Analysis result: ${analysis.feedback_type}/${analysis.severity} - Score: ${analysis.compliance_score}/10`);
  if (analysis.remark) {
    debug(`Remark: "${analysis.remark}"`);
  }
  
  // Save metadata with workspace ID
  const metadata: MessageMetadata = {
    workspace_id: workspaceId,
    session_id: sessionId,
    message_uuid: message.uuid,
    parent_uuid: message.parentUuid,
    timestamp: message.timestamp,
    type: message.type,
    role: message.message?.role,
    summary: analysis.summary,
    intent: analysis.intent,
    project_context: analysis.project_context,
    compliance_score: analysis.compliance_score,
    efficiency_score: analysis.efficiency_score,
    created_at: Date.now()
  };
  
  db.saveMessageMetadata(metadata);
  
  // Save feedback if there's an issue or praise
  if (analysis.feedback_type !== 'none') {
    const feedback: Feedback = {
      workspace_id: workspaceId,
      session_id: sessionId,
      message_uuid: message.uuid,
      feedback_type: analysis.feedback_type,
      severity: analysis.severity,
      remark: analysis.remark,
      funny_observation: analysis.funny_observation,
      icon: getIconForFeedback(analysis),
      shown: false,
      expires_at: Date.now() + (60 * 60 * 1000), // Expire after 1 hour
      created_at: Date.now()
    };
    
    db.saveFeedback(feedback);
  }
}

/**
 * Get appropriate icon for feedback type
 */
function getIconForFeedback(analysis: LLMAnalysisResult): string {
  if (analysis.severity === 'critical') {
    return '💢'; // Angry outburst
  } else if (analysis.severity === 'problematic') {
    return '🗯️'; // Annoyed remark
  } else if (analysis.severity === 'annoying') {
    return '⚡'; // Quick reaction
  } else if (analysis.feedback_type === 'good') {
    return '✨'; // Praise
  } else if (analysis.funny_observation) {
    return '🎯'; // Project observation
  } else {
    return '🔍'; // Analysis insight
  }
}

  // Run the analysis
  await analyzeTranscript();
} // End of runWorker function

// Run the worker
runWorker().then(() => {
  console.log('Analysis complete');
  process.exit(0);
}).catch(error => {
  console.error('Analysis failed:', error);
  process.exit(1);
});