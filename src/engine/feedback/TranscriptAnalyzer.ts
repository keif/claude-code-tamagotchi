import { spawn } from 'child_process';
import * as path from 'path';
import { FeedbackDatabase } from './FeedbackDatabase';
import { MessageProcessor } from './MessageProcessor';
import { Feedback, FeedbackConfig } from './types';

export class TranscriptAnalyzer {
  private db: FeedbackDatabase;
  private processor: MessageProcessor;
  private config: FeedbackConfig;
  private lastCheckTime: number = 0;
  private checkCounter: number = 0;
  private isProcessing: boolean = false;

  constructor(config: FeedbackConfig) {
    this.config = config;
    this.db = new FeedbackDatabase(config.dbPath, config.dbMaxSize);
    this.processor = new MessageProcessor(this.db, config.staleLockTime);
  }

  /**
   * Quick check if we should analyze (< 5ms)
   */
  async shouldAnalyze(transcriptPath?: string): Promise<boolean> {
    // Check if feature is enabled
    if (!this.config.enabled || this.config.mode === 'off') {
      this.debug('Feedback disabled or off');
      return false;
    }

    // Check if we have a transcript
    if (!transcriptPath) {
      this.debug('No transcript path provided');
      return false;
    }

    // Check interval
    this.checkCounter++;
    if (this.checkCounter < this.config.checkInterval) {
      this.debug(`Check counter ${this.checkCounter}/${this.config.checkInterval}`);
      return false;
    }
    this.checkCounter = 0;

    // Check if already processing
    if (this.isProcessing) {
      this.debug('Already processing');
      return false;
    }

    // Quick check for new messages
    const hasNew = await this.processor.hasNewMessages(transcriptPath);
    this.debug(`Has new messages: ${hasNew}`);
    return hasNew;
  }
  
  private debug(message: string): void {
    if (process.env.PET_FEEDBACK_DEBUG === 'true') {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] [TranscriptAnalyzer] ${message}\n`;
      
      // Log to console if debug mode
      if (process.env.DEBUG_MODE === 'true') {
        console.error(logMessage.trim());
      }
      
      // Log to file if specified
      const logDir = process.env.PET_FEEDBACK_LOG_DIR;
      if (logDir) {
        try {
          const fs = require('fs');
          const path = require('path');
          // Create log directory if it doesn't exist
          if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
          }
          const logFile = path.join(logDir, 'feedback-analyzer.log');
          fs.appendFileSync(logFile, logMessage);
        } catch {
          // Ignore logging errors
        }
      }
    }
  }

  /**
   * Synchronous analysis for immediate feedback
   */
  async analyzeSynchronously(
    transcriptPath: string, 
    sessionId: string, 
    petState?: any
  ): Promise<Feedback | null> {
    if (this.isProcessing) {
      this.debug('Already processing, skipping');
      return null;
    }

    this.isProcessing = true;
    this.debug(`Starting synchronous analysis for session ${sessionId}`);
    
    try {
      // Get unprocessed messages
      const messages = await this.processor.getUnprocessedMessages(transcriptPath, 1);
      if (messages.length === 0) {
        this.debug('No new messages to process');
        return null;
      }

      const message = messages[0];
      this.debug(`Processing message: ${message.uuid}`);

      // Import dependencies - use unified provider system
      const { LLMProviderFactory } = await import('../../llm/LLMProvider');
      
      // Create provider configuration based on current config
      const providerConfig = {
        provider: this.config.aiProvider,
        apiKey: this.config.aiProvider === 'groq' ? this.config.groqApiKey : this.config.openaiApiKey,
        model: this.config.aiProvider === 'groq' ? this.config.groqModel : this.config.openaiModel,
        timeout: this.config.aiProvider === 'groq' ? this.config.groqTimeout : this.config.openaiTimeout,
        maxRetries: this.config.aiProvider === 'groq' ? this.config.groqMaxRetries : this.config.openaiMaxRetries
      };
      
      const llmProvider = await LLMProviderFactory.createProvider(providerConfig);

      // Get session history for context
      const recentMessages = await this.processor.readTranscript(transcriptPath);
      const sessionHistory = this.buildSessionHistory(recentMessages.slice(-100));

      // Extract context from the message
      const context = this.extractContext(message, recentMessages);
      
      // Get recent observations for this session to avoid repetition
      if (petState) {
        const recentObservations = this.db.getRecentFunnyObservations(sessionId, 10);
        petState.thoughtHistory = recentObservations;
        this.debug(`Loaded ${recentObservations.length} recent observations`);
      }

      // Analyze with LLM
      this.debug(`Calling ${this.config.aiProvider.toUpperCase()} LLM for analysis...`);
      const analysis = await llmProvider.analyzeExchange(
        context.userRequest || 'No specific request',
        context.claudeActions || [],
        sessionHistory,
        undefined,
        petState
      );

      this.debug(`Analysis complete: ${analysis.feedback_type}/${analysis.severity}`);

      // Save feedback to database
      const feedback: Feedback = {
        workspace_id: FeedbackDatabase.extractWorkspaceId(transcriptPath),
        session_id: sessionId,
        message_uuid: message.uuid,
        feedback_type: analysis.feedback_type,
        severity: analysis.severity,
        remark: analysis.remark,
        funny_observation: analysis.funny_observation,
        icon: this.getIconForFeedback(analysis.severity),
        created_at: Date.now()
      };

      this.db.saveFeedback(feedback);
      
      // Mark message as processed
      this.db.releaseLocks([message.uuid], process.pid);

      return feedback;
    } catch (error) {
      this.debug(`Synchronous analysis failed: ${error}`);
      return null;
    } finally {
      this.isProcessing = false;
    }
  }

  private buildSessionHistory(messages: any[]): string[] {
    const history: string[] = [];
    
    for (const msg of messages) {
      if (msg.type === 'message' && msg.message) {
        const role = msg.message.role;
        const content = msg.message.content || '';
        
        if (role === 'user') {
          history.push(`User: ${content.slice(0, 200)}`);
        } else if (role === 'assistant') {
          history.push(`Claude: ${content.slice(0, 200)}`);
        }
      } else if (msg.type === 'tool_use') {
        const toolName = msg.toolUse?.name || 'Unknown';
        history.push(`[Tool: ${toolName}]`);
      }
    }
    
    return history;
  }

  private extractContext(message: any, allMessages: any[]): any {
    let userRequest = '';
    const claudeActions: string[] = [];
    
    // Find the most recent user message
    for (let i = allMessages.length - 1; i >= 0; i--) {
      const msg = allMessages[i];
      if (msg.type === 'message' && msg.message?.role === 'user') {
        userRequest = msg.message.content || '';
        break;
      }
    }

    // Extract Claude's actions
    if (message.type === 'tool_use' && message.toolUse) {
      const tool = message.toolUse;
      claudeActions.push(`Tool: ${tool.name} - ${tool.input?.file_path || tool.input?.path || ''}`);
    } else if (message.type === 'message' && message.message?.role === 'assistant') {
      if (message.message.content) {
        claudeActions.push('Processed request');
      }
    }

    return { userRequest, claudeActions };
  }

  private getIconForFeedback(severity: string): string {
    switch (severity) {
      case 'problematic': return '⚠️';
      case 'annoying': return '💭';
      case 'good': return '✨';
      default: return '👀';
    }
  }

  /**
   * Spawn background worker to analyze transcript
   */
  spawnAnalysisWorker(transcriptPath: string, sessionId: string, petState?: any): void {
    if (this.isProcessing) {
      this.debug('Already processing, skipping spawn');
      return;
    }

    this.isProcessing = true;
    this.debug(`Spawning worker for session ${sessionId}`);
    
    // Path to worker script
    const workerPath = path.join(__dirname, '../../workers/analyze-transcript.js');
    
    // Prepare pet state JSON (if provided)
    const petStateJson = petState ? JSON.stringify(petState) : '';
    
    // Spawn detached process
    const worker = spawn('bun', [
      workerPath,
      transcriptPath,
      sessionId,
      this.config.dbPath,
      petStateJson
    ], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        // Provider selection
        PET_AI_PROVIDER: this.config.aiProvider,
        // Provider-specific configuration
        PET_GROQ_API_KEY: this.config.groqApiKey,
        PET_GROQ_MODEL: this.config.groqModel,
        PET_GROQ_TIMEOUT: String(this.config.groqTimeout),
        PET_OPENAI_API_KEY: this.config.openaiApiKey,
        PET_OPENAI_MODEL: this.config.openaiModel,
        PET_OPENAI_TIMEOUT: String(this.config.openaiTimeout),
        // Other config
        PET_FEEDBACK_BATCH_SIZE: String(this.config.batchSize),
        PET_FEEDBACK_DEBUG: process.env.PET_FEEDBACK_DEBUG,
        PET_FEEDBACK_LOG_DIR: process.env.PET_FEEDBACK_LOG_DIR
      }
    });

    // Detach from parent
    worker.unref();
    this.debug(`Worker spawned with PID: ${worker.pid}`);

    // Reset flag after a delay
    setTimeout(() => {
      this.isProcessing = false;
      this.debug('Processing flag reset');
    }, 1000);
  }

  /**
   * Get cached feedback from database (< 10ms)
   */
  getCachedFeedback(): Feedback[] {
    try {
      return this.db.getUnshownFeedback(5);
    } catch {
      return [];
    }
  }

  /**
   * Get the most relevant feedback for display
   */
  getMostRelevantFeedback(feedback: Feedback[]): Feedback | null {
    if (feedback.length === 0) {
      return null;
    }

    // Priority: critical > problematic > annoying > good
    const severityOrder = ['problematic', 'annoying', 'good'];
    
    // Sort by severity then by recency
    feedback.sort((a, b) => {
      const aSeverity = severityOrder.indexOf(a.severity);
      const bSeverity = severityOrder.indexOf(b.severity);
      
      if (aSeverity !== bSeverity) {
        return aSeverity - bSeverity;
      }
      
      return b.created_at - a.created_at;
    });

    return feedback[0];
  }

  /**
   * Mark feedback as shown
   */
  markFeedbackShown(feedbackIds: number[]): void {
    try {
      this.db.markFeedbackShown(feedbackIds);
    } catch {
      // Ignore errors
    }
  }

  /**
   * Calculate behavior score based on recent feedback
   */
  calculateBehaviorScore(sessionId: string): number {
    try {
      const recentFeedback = this.db.getRecentFeedback(sessionId, 20);
      
      if (recentFeedback.length === 0) {
        return 80; // Default good score
      }

      let score = 100;
      
      for (const feedback of recentFeedback) {
        switch (feedback.severity) {
          case 'problematic':
            score -= 10;
            break;
          case 'annoying':
            score -= 5;
            break;
          case 'good':
            score = Math.min(100, score + 5);
            break;
        }
      }

      return Math.max(0, Math.min(100, score));
    } catch {
      return 80; // Default score on error
    }
  }

  /**
   * Get violation count for mood calculation
   */
  getRecentViolationCount(sessionId: string): number {
    try {
      const recentFeedback = this.db.getRecentFeedback(sessionId, 10);
      return recentFeedback.filter(f => 
        f.severity === 'annoying' || 
        f.severity === 'problematic'
      ).length;
    } catch {
      return 0;
    }
  }

  /**
   * Quick analysis for immediate feedback (sync, must be fast)
   */
  quickAnalyze(transcriptPath: string, sessionId: string): {
    shouldSpawn: boolean;
    cachedFeedback: Feedback | null;
    behaviorScore: number;
    violationCount: number;
  } {
    const startTime = Date.now();
    
    // Check if we should spawn worker (< 2ms)
    const shouldSpawn = this.checkCounter === 0 && !this.isProcessing;
    this.debug(`Quick analyze - should spawn: ${shouldSpawn}`);
    
    // Get cached feedback (< 5ms)
    const feedback = this.getCachedFeedback();
    const cachedFeedback = this.getMostRelevantFeedback(feedback);
    
    if (cachedFeedback) {
      this.debug(`Found cached feedback: ${cachedFeedback.feedback_type}/${cachedFeedback.severity} - "${cachedFeedback.remark}"`);
    }
    
    // Calculate scores (< 3ms)
    const behaviorScore = this.calculateBehaviorScore(sessionId);
    const violationCount = this.getRecentViolationCount(sessionId);
    this.debug(`Behavior score: ${behaviorScore}, Violations: ${violationCount}`);
    
    // Mark feedback as shown if we're returning it
    if (cachedFeedback && cachedFeedback.id) {
      this.markFeedbackShown([cachedFeedback.id]);
    }
    
    // Ensure we're under 10ms total
    const elapsed = Date.now() - startTime;
    if (elapsed > 10) {
      this.debug(`WARNING: quickAnalyze took ${elapsed}ms (> 10ms)`);
    } else {
      this.debug(`quickAnalyze completed in ${elapsed}ms`);
    }
    
    return {
      shouldSpawn,
      cachedFeedback,
      behaviorScore,
      violationCount
    };
  }

  /**
   * Cleanup and close database
   */
  close(): void {
    this.db.close();
  }
}