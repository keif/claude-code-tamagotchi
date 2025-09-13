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
  maxRetries: 2,
  dbPath: dbPath // Pass database path for violation storage
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
    debug(`Messages to process: ${messages.map(m => `${m.uuid} (${m.type})`).join(', ')}`);
    
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
    
    // Check if this is a tool result (which is technically a user message but contains tool output)
    // We'll analyze these differently to get better summaries
    const isToolResult = userContent.startsWith('[Tool Result:') || 
                        userContent.startsWith('[[Tool output]]') ||
                        userContent.includes('Tool ran without output') ||
                        userContent.includes('Applied ') && userContent.includes(' edits to ') ||
                        userContent.includes('The file ') && userContent.includes(' has been ') ||
                        (userContent.startsWith('```') && userContent.length < 100) || // Short code blocks are often tool outputs
                        userContent === 'Processed request' ||
                        message.type === 'tool_result'; // Some transcripts mark these explicitly
    
    // Get session history for context - don't include current message
    const sessionMetadata = db.getSessionMetadata(sessionId);
    debug(`Retrieved ${sessionMetadata.length} total metadata entries for session`);
    const sessionHistory: string[] = [];
    
    // Build history from ALL previous messages (not stopping at current)
    let skippedCount = 0;
    for (const meta of sessionMetadata) {
      // Skip only if we've reached or passed the current message timestamp
      if (meta.timestamp && message.timestamp && meta.timestamp >= message.timestamp) {
        debug(`Skipping metadata entry ${meta.message_uuid} - timestamp ${meta.timestamp} >= current ${message.timestamp}`);
        skippedCount++;
        continue;
      }
      
      if (meta.summary) {
        debug(`Adding to history: type=${meta.type}, summary="${meta.summary.slice(0, 50)}..."`);
        if (meta.type === 'user') {
          sessionHistory.push(`User: ${meta.summary}`);
        } else if (meta.type === 'assistant') {
          sessionHistory.push(`Claude: ${meta.summary}`);
        } else if (meta.type === 'tool_call') {
          sessionHistory.push(`[${meta.summary}]`);
        }
      } else {
        debug(`Metadata entry ${meta.message_uuid} has no summary`);
      }
    }
    
    debug(`Session history for user message contains ${sessionHistory.length} entries (skipped ${skippedCount})`);
    if (sessionHistory.length > 0) {
      debug(`First history entry: "${sessionHistory[0]?.slice(0, 100)}..."`);
      debug(`Last history entry: "${sessionHistory[sessionHistory.length - 1]?.slice(0, 100)}..."`);
    }
    
    if (isToolResult) {
      // This is a tool result - find which tool was called
      debug(`Processing tool result message: ${message.uuid}`);
      debug(`Tool result content preview: "${userContent.slice(0, 50)}..."`);
      
      const toolCall = processor.findToolCallForResult(allMessages, message);
      let toolInfo = '[Tool output]';
      
      if (toolCall) {
        // Format based on tool type
        const { toolName, toolInput } = toolCall;
        
        switch (toolName) {
          case 'Read':
            toolInfo = `Tool: Read - ${toolInput.file_path || 'unknown file'}`;
            if (toolInput.limit) toolInfo += ` (limit: ${toolInput.limit})`;
            if (toolInput.offset) toolInfo += ` (offset: ${toolInput.offset})`;
            break;
          
          case 'Edit':
            toolInfo = `Tool: Edit - ${toolInput.file_path || 'unknown file'}`;
            if (toolInput.old_string) {
              const preview = toolInput.old_string.slice(0, 30).replace(/\n/g, ' ');
              toolInfo += ` (replacing: "${preview}...")`;
            }
            break;
          
          case 'Write':
            toolInfo = `Tool: Write - ${toolInput.file_path || 'unknown file'}`;
            break;
          
          case 'MultiEdit':
            toolInfo = `Tool: MultiEdit - ${toolInput.file_path || 'unknown file'}`;
            if (toolInput.edits) toolInfo += ` (${toolInput.edits.length} edits)`;
            break;
          
          case 'Bash':
            const cmd = toolInput.command || 'unknown command';
            const shortCmd = cmd.length > 50 ? cmd.slice(0, 47) + '...' : cmd;
            toolInfo = `Tool: Bash - ${shortCmd}`;
            break;
          
          case 'Glob':
            toolInfo = `Tool: Glob - pattern: ${toolInput.pattern || 'unknown'}`;
            if (toolInput.path) toolInfo += ` in ${toolInput.path}`;
            break;
          
          case 'Grep':
            toolInfo = `Tool: Grep - "${toolInput.pattern || 'unknown'}"`;
            if (toolInput.path) toolInfo += ` in ${toolInput.path}`;
            break;
          
          case 'LS':
            toolInfo = `Tool: LS - ${toolInput.path || 'unknown path'}`;
            break;
          
          case 'WebFetch':
            toolInfo = `Tool: WebFetch - ${toolInput.url || 'unknown URL'}`;
            break;
          
          case 'WebSearch':
            toolInfo = `Tool: WebSearch - "${toolInput.query || 'unknown query'}"`;
            break;
          
          case 'Task':
            toolInfo = `Tool: Task - ${toolInput.description || 'unknown task'}`;
            break;
            
          case 'TodoWrite':
            toolInfo = `Tool: TodoWrite`;
            if (toolInput.todos && Array.isArray(toolInput.todos)) {
              toolInfo += ` - ${toolInput.todos.length} tasks`;
            }
            break;
          
          default:
            toolInfo = `Tool: ${toolName}`;
            break;
        }
        
        debug(`Formatted tool call: ${toolInfo}`);
      }
      
      // Analyze tool result with LLM to understand what Claude did and why
      debug(`Analyzing tool result with LLM: ${message.uuid}`);
      debug(`Tool info: ${toolInfo}`);
      debug(`Session history size for tool result: ${sessionHistory.length}`);
      
      // Create a special prompt for tool results
      const toolResultPrompt = `This is a tool result from Claude Code.
${toolInfo}
Output preview: ${userContent.slice(0, 500)}`;
      
      debug(`Calling analyzeUserMessage for tool result...`);
      const analysis = await llmProvider.analyzeUserMessage(
        toolResultPrompt,
        sessionHistory
      );
      debug(`Tool result analysis received - summary: "${analysis.summary?.slice(0, 50)}...", intent: "${analysis.intent}"`)
      
      // Save with analyzed summary
      const metadata: MessageMetadata = {
        workspace_id: workspaceId,
        session_id: sessionId,
        message_uuid: message.uuid,
        parent_uuid: message.parentUuid,
        timestamp: message.timestamp,
        type: 'tool_call',  // Mark as tool_call for clarity
        role: 'system',
        summary: analysis.summary || toolInfo,
        intent: analysis.intent || 'Tool execution',
        created_at: Date.now()
      };
      
      db.saveMessageMetadata(metadata);
      debug(`Saved analyzed tool result: "${metadata.summary}"`);
      return;
    }
    
    // This is a real user message - analyze it with LLM for proper summary
    debug(`Analyzing real user message with LLM: ${message.uuid}`);
    debug(`User message preview: "${userContent.slice(0, 100)}..."`);
    debug(`Session history size for user message: ${sessionHistory.length}`);
    
    // Analyze user message with full context (sessionHistory already built above)
    debug(`Calling analyzeUserMessage for real user message...`);
    const analysis = await llmProvider.analyzeUserMessage(
      userContent,
      sessionHistory
    );
    debug(`User message analysis received - summary: "${analysis.summary?.slice(0, 50)}...", intent: "${analysis.intent}"`);
    
    if (analysis.summary === userContent) {
      debug(`WARNING: Analysis returned full message as summary - API may have failed`);
    }
    
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
  
  // Get FULL session history for complete context (NOTE: second param is ignored in current implementation)
  const sessionMetadata = db.getSessionMetadata(sessionId);
  debug(`Building session history for assistant message - found ${sessionMetadata.length} metadata entries`);
  
  // Build session narrative from all previous messages
  const sessionHistory: string[] = [];
  let skippedForTimestamp = 0;
  let noSummaryCount = 0;
  
  for (const meta of sessionMetadata) {
    // Skip only if we've reached or passed the current message timestamp
    if (meta.timestamp && message.timestamp && meta.timestamp >= message.timestamp) {
      debug(`Skipping future message: ${meta.message_uuid} (${meta.type}) - timestamp ${meta.timestamp} >= current ${message.timestamp}`);
      skippedForTimestamp++;
      continue;
    }
    
    // Build a narrative entry for each message with summary
    if (meta.summary) {
      debug(`Adding ${meta.type} to history: "${meta.summary.slice(0, 50)}..."`);
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
    } else {
      debug(`No summary for ${meta.type} message: ${meta.message_uuid}`);
      noSummaryCount++;
    }
  }
  
  debug(`Session history contains ${sessionHistory.length} entries (skipped ${skippedForTimestamp} future, ${noSummaryCount} no summary)`);
  if (sessionHistory.length > 0) {
    debug(`First entry: "${sessionHistory[0]?.slice(0, 100)}..."`);
    debug(`Last entry: "${sessionHistory[sessionHistory.length - 1]?.slice(0, 100)}..."`);
  } else {
    debug(`WARNING: Empty session history for assistant message!`);
  }
  
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
  debug(`Session ID: ${sessionId}, Message UUID: ${message.uuid}, Transcript Path: ${transcriptPath}`);
  debug(`Workspace ID (already extracted): ${workspaceId}`);
  
  debug(`Calling analyzeExchange with: sessionId=${sessionId}, messageUuid=${message.uuid}, workspaceId=${workspaceId}`);
  const analysis = await llmProvider.analyzeExchange(
    context.userRequest || 'No specific request',
    claudeActions,
    sessionHistory,
    undefined, // project context
    petState, // pass pet state for contextual remarks
    sessionId,      // Pass session ID for violation storage
    message.uuid,   // Pass message UUID for violation storage
    workspaceId     // Pass workspace ID for violation storage
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