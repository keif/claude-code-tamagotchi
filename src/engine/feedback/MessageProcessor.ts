import { FeedbackDatabase } from './FeedbackDatabase';
import { TranscriptMessage } from './types';
import * as fs from 'fs';

export class MessageProcessor {
  private db: FeedbackDatabase;
  private staleLockTime: number;

  constructor(db: FeedbackDatabase, staleLockTime: number = 30000) {
    this.db = db;
    this.staleLockTime = staleLockTime;
  }

  /**
   * Read and parse transcript file
   */
  async readTranscript(transcriptPath: string): Promise<TranscriptMessage[]> {
    if (!fs.existsSync(transcriptPath)) {
      return [];
    }

    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    const messages: TranscriptMessage[] = [];

    for (const line of lines) {
      try {
        const message = JSON.parse(line) as TranscriptMessage;
        messages.push(message);
      } catch {
        // Skip malformed lines
        continue;
      }
    }

    return messages;
  }

  /**
   * Get messages that haven't been processed yet
   */
  async getUnprocessedMessages(
    transcriptPath: string, 
    limit: number = 10
  ): Promise<TranscriptMessage[]> {
    const allMessages = await this.readTranscript(transcriptPath);
    const state = this.db.getAnalysisState();
    
    let unprocessed: TranscriptMessage[] = [];
    
    if (state.last_processed_uuid) {
      // Find index of last processed
      const lastIndex = allMessages.findIndex(m => m.uuid === state.last_processed_uuid);
      if (lastIndex >= 0) {
        // Get messages after the last processed one
        unprocessed = allMessages.slice(lastIndex + 1);
      } else {
        // Last processed not found, process all
        unprocessed = allMessages;
      }
    } else {
      // No messages processed yet
      unprocessed = allMessages;
    }

    // Filter out already processed messages (belt and suspenders)
    unprocessed = unprocessed.filter(m => !this.db.isMessageProcessed(m.uuid));
    
    // Return limited batch
    return unprocessed.slice(0, limit);
  }

  /**
   * Atomically claim messages for processing
   */
  async claimMessagesForProcessing(
    transcriptPath: string,
    limit: number = 10
  ): Promise<TranscriptMessage[]> {
    // Clean stale locks first
    this.db.cleanStaleLocks(this.staleLockTime);
    
    // Get unprocessed messages
    const unprocessed = await this.getUnprocessedMessages(transcriptPath, limit);
    
    if (unprocessed.length === 0) {
      return [];
    }
    
    // Try to acquire locks
    const uuids = unprocessed.map(m => m.uuid);
    const acquiredUuids = this.db.acquireLocks(uuids, process.pid);
    
    // Return only messages we successfully locked
    return unprocessed.filter(m => acquiredUuids.includes(m.uuid));
  }

  /**
   * Mark messages as successfully processed
   */
  markMessagesProcessed(uuids: string[]): void {
    this.db.markMessagesProcessed(uuids);
  }

  /**
   * Check if there are new messages to process
   */
  async hasNewMessages(transcriptPath: string): Promise<boolean> {
    if (!fs.existsSync(transcriptPath)) {
      return false;
    }

    const messages = await this.readTranscript(transcriptPath);
    if (messages.length === 0) {
      return false;
    }

    const state = this.db.getAnalysisState();
    
    // If no messages processed yet, we have new messages
    if (!state.last_processed_uuid) {
      return true;
    }

    // Check if the last message in transcript is different from last processed
    const lastMessage = messages[messages.length - 1];
    return lastMessage.uuid !== state.last_processed_uuid;
  }

  /**
   * Get the last N message UUIDs for duplicate checking
   */
  getLastMessageUuids(transcriptPath: string, count: number = 10): string[] {
    const messages = this.readTranscriptSync(transcriptPath);
    return messages.slice(-count).map(m => m.uuid);
  }

  /**
   * Synchronous version for quick checks
   */
  private readTranscriptSync(transcriptPath: string): TranscriptMessage[] {
    if (!fs.existsSync(transcriptPath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());
      const messages: TranscriptMessage[] = [];

      for (const line of lines) {
        try {
          messages.push(JSON.parse(line));
        } catch {
          continue;
        }
      }

      return messages;
    } catch {
      return [];
    }
  }

  /**
   * Extract relevant content from a message for analysis
   */
  extractMessageContent(message: TranscriptMessage): {
    type: string;
    content: string;
    tools?: Array<{ name: string; input: any }>;
  } {
    const type = message.type;
    let content = '';
    const tools: Array<{ name: string; input: any }> = [];

    // Debug logging
    const debug = process.env.PET_FEEDBACK_DEBUG === 'true';
    if (debug) {
      console.log(`[MessageProcessor] Extracting content from ${type} message ${message.uuid}`);
    }

    if (message.message?.content) {
      // Handle both string format (user messages) and array format (assistant messages)
      if (typeof message.message.content === 'string') {
        // User messages have content as a string
        content = message.message.content;
        if (debug) {
          console.log(`[MessageProcessor] Extracted string content: "${content.slice(0, 50)}..."`);
        }
      } else if (Array.isArray(message.message.content)) {
        // Assistant messages have content as an array
        for (const item of message.message.content) {
          if (item.type === 'text' && item.text) {
            content += item.text + '\n';
          } else if (item.type === 'tool_use' && item.name) {
            tools.push({
              name: item.name,
              input: item.input
            });
          } else if (item.type === 'tool_result' && item.content) {
            // Handle tool results (from user messages responding to tool use)
            content += `[Tool Result: ${item.content}]\n`;
          }
        }
        if (debug) {
          console.log(`[MessageProcessor] Extracted array content: "${content.slice(0, 50)}..." with ${tools.length} tools`);
        }
      } else {
        if (debug) {
          console.log(`[MessageProcessor] Unknown content type: ${typeof message.message.content}`);
        }
      }
    } else {
      if (debug) {
        console.log(`[MessageProcessor] No message.content found for ${type} message`);
      }
    }

    return { type, content: content.trim(), tools };
  }

  /**
   * Find the tool call that corresponds to a tool result
   */
  findToolCallForResult(
    messages: TranscriptMessage[], 
    toolResultMessage: TranscriptMessage
  ): { toolName: string; toolInput: any } | null {
    // Extract tool_use_id from the tool result
    let toolUseId: string | undefined;
    
    if (toolResultMessage.message?.content && Array.isArray(toolResultMessage.message.content)) {
      for (const item of toolResultMessage.message.content) {
        if (item.type === 'tool_result' && item.tool_use_id) {
          toolUseId = item.tool_use_id;
          break;
        }
      }
    }
    
    if (!toolUseId) {
      return null;
    }
    
    // Search backward for the assistant message with this tool use
    const resultIndex = messages.findIndex(m => m.uuid === toolResultMessage.uuid);
    for (let i = resultIndex - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === 'assistant' && msg.message?.content && Array.isArray(msg.message.content)) {
        for (const item of msg.message.content) {
          if (item.type === 'tool_use' && item.id === toolUseId) {
            return {
              toolName: item.name || 'Unknown',
              toolInput: item.input || {}
            };
          }
        }
      }
    }
    
    return null;
  }

  /**
   * Get context from previous messages
   */
  async getMessageContext(
    messages: TranscriptMessage[],
    currentIndex: number,
    contextSize: number = 10
  ): Promise<{
    userRequest?: string;
    previousActions: string[];
  }> {
    // Look back further to find the user's request
    const start = Math.max(0, currentIndex - contextSize);
    const contextMessages = messages.slice(start, currentIndex);
    
    let userRequest: string | undefined;
    const previousActions: string[] = [];

    // Look backward from current message to find the most recent user message
    // Don't reverse - we want the most recent user message before this assistant message
    for (let i = contextMessages.length - 1; i >= 0; i--) {
      const msg = contextMessages[i];
      
      if (msg.type === 'user' && !userRequest) {
        // Check if this is a tool result (not a real user message)
        let isToolResult = false;
        if (msg.message?.content && Array.isArray(msg.message.content)) {
          for (const item of msg.message.content) {
            if (item.type === 'tool_result') {
              isToolResult = true;
              break;
            }
          }
        }
        
        // Skip tool results - we want actual user messages
        if (!isToolResult) {
          const extracted = this.extractMessageContent(msg);
          if (extracted.content && extracted.content.trim()) {
            userRequest = extracted.content;
            // Debug log
            if (process.env.PET_FEEDBACK_DEBUG === 'true') {
              console.log(`[MessageProcessor] Found user request at index ${start + i}: "${userRequest.slice(0, 100)}..."`);
            }
          }
        }
      } else if (msg.type === 'assistant') {
        const extracted = this.extractMessageContent(msg);
        if (extracted.tools && extracted.tools.length > 0) {
          for (const tool of extracted.tools) {
            previousActions.push(`${tool.name}: ${JSON.stringify(tool.input).slice(0, 100)}`);
          }
        }
      }
    }

    // If we didn't find a user request in the immediate context, look further back
    if (!userRequest && currentIndex > contextSize) {
      const extendedStart = Math.max(0, currentIndex - 20);
      const extendedContext = messages.slice(extendedStart, start);
      
      for (let i = extendedContext.length - 1; i >= 0; i--) {
        const msg = extendedContext[i];
        if (msg.type === 'user') {
          // Check if this is a tool result
          let isToolResult = false;
          if (msg.message?.content && Array.isArray(msg.message.content)) {
            for (const item of msg.message.content) {
              if (item.type === 'tool_result') {
                isToolResult = true;
                break;
              }
            }
          }
          
          if (!isToolResult) {
            const extracted = this.extractMessageContent(msg);
            if (extracted.content && extracted.content.trim()) {
              userRequest = extracted.content;
              if (process.env.PET_FEEDBACK_DEBUG === 'true') {
                console.log(`[MessageProcessor] Found user request in extended context at index ${extendedStart + i}: "${userRequest.slice(0, 100)}..."`);
              }
              break;
            }
          }
        }
      }
    }

    if (process.env.PET_FEEDBACK_DEBUG === 'true' && !userRequest) {
      console.log(`[MessageProcessor] No user request found for message at index ${currentIndex}`);
    }

    return { userRequest, previousActions };
  }
}