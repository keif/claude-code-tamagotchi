import { TranscriptAnalyzer } from './TranscriptAnalyzer';
import { PetState } from '../StateManager';
import { config } from '../../utils/config';
import { FeedbackConfig, Feedback } from './types';

export class FeedbackSystem {
  private analyzer: TranscriptAnalyzer | null = null;
  private initialized: boolean = false;
  private currentSessionId?: string;
  
  constructor() {
    if (config.feedbackEnabled) {
      this.debug('Feedback system enabled, initializing...');
      this.initialize();
    } else {
      this.debug('Feedback system disabled');
    }
  }
  
  private initialize(): void {
    const feedbackConfig: FeedbackConfig = {
      enabled: config.feedbackEnabled,
      mode: config.feedbackMode,
      checkInterval: config.feedbackCheckInterval,
      batchSize: config.feedbackBatchSize,
      minMessages: config.feedbackMinMessages,
      staleLockTime: config.feedbackStaleLockTime,
      dbPath: config.feedbackDbPath,
      dbMaxSize: config.feedbackDbMaxSize,
      // AI Provider selection - default to 'openai' for backward compatibility
      aiProvider: (process.env.PET_AI_PROVIDER as 'groq' | 'openai') || 'openai',
      // Provider-specific configuration
      groqApiKey: config.groqApiKey,
      groqModel: config.groqModel,
      groqTimeout: config.groqTimeout,
      groqMaxRetries: config.groqMaxRetries,
      openaiApiKey: config.openaiApiKey,
      openaiModel: config.openaiModel,
      openaiTimeout: config.openaiTimeout,
      openaiMaxRetries: config.openaiMaxRetries
    };
    
    this.analyzer = new TranscriptAnalyzer(feedbackConfig);
    this.initialized = true;
  }
  
  /**
   * Process feedback for the current update
   */
  processFeedback(
    state: PetState,
    transcriptPath?: string,
    sessionId?: string
  ): void {
    // Store session ID for later use
    this.currentSessionId = sessionId;
    if (!this.initialized || !this.analyzer || !transcriptPath || !sessionId) {
      this.debug('Feedback not processed - missing requirements');
      return;
    }
    
    this.debug(`Processing feedback for session ${sessionId}`);
    
    // Quick analysis (< 10ms)
    const analysis = this.analyzer.quickAnalyze(transcriptPath, sessionId);
    
    // Update behavior score
    state.claudeBehaviorScore = analysis.behaviorScore;
    state.recentViolations = analysis.violationCount;
    
    // Update mood based on violations
    this.updateMoodFromFeedback(state, analysis.violationCount, analysis.behaviorScore);
    
    // Store feedback for display
    if (analysis.cachedFeedback) {
      this.debug(`Applying feedback: ${analysis.cachedFeedback.feedback_type}/${analysis.cachedFeedback.severity}`);
      this.applyFeedback(state, analysis.cachedFeedback);
    }
    
    // Spawn background worker if needed
    if (analysis.shouldSpawn) {
      this.debug('Spawning background worker with pet state');
      this.analyzer.spawnAnalysisWorker(transcriptPath, sessionId, state);
    }
  }
  
  private debug(message: string, error?: Error): void {
    if (process.env.PET_FEEDBACK_DEBUG === 'true') {
      const timestamp = new Date().toISOString();
      const errorInfo = error ? ` - Error: ${error.message}` : '';
      const logMessage = `[${timestamp}] [FeedbackSystem] ${message}${errorInfo}\n`;
      
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
          const logFile = path.join(logDir, 'feedback-system.log');
          fs.appendFileSync(logFile, logMessage);
        } catch (error) {
          // Log error to stderr if file logging fails
          console.error(`Failed to write to log file: ${error}`);
        }
      }
    }
  }
  
  /**
   * Update mood based on feedback
   */
  private updateMoodFromFeedback(
    state: PetState,
    violationCount: number,
    behaviorScore: number
  ): void {
    // Don't update mood if system is disabled
    if (!this.initialized) {
      return;
    }
    
    // Simplified mood system based on behavior score
    if (behaviorScore >= 85) {
      state.currentMood = 'happy';
    } else if (behaviorScore >= 70) {
      state.currentMood = 'normal';
    } else if (behaviorScore >= 50) {
      state.currentMood = 'concerned';
    } else {
      state.currentMood = 'annoyed';
    }
    
    // Override with special moods for edge cases
    if (behaviorScore >= 95 && violationCount === 0) {
      state.currentMood = 'proud';
    } else if (violationCount >= 5) {
      state.currentMood = 'frustrated';
    }
  }
  
  /**
   * Gradually improve mood
   */
  private decayMood(state: PetState): void {
    const moodProgression = {
      'frustrated': 'annoyed',
      'annoyed': 'concerned',
      'concerned': 'normal',
      'normal': 'happy'
    };
    
    const nextMood = moodProgression[state.currentMood as keyof typeof moodProgression];
    if (nextMood) {
      state.currentMood = nextMood as any;
    }
  }
  
  /**
   * Apply feedback to state
   */
  private applyFeedback(state: PetState, feedback: Feedback): void {
    // Store in history
    state.feedbackHistory.push({
      type: feedback.feedback_type,
      severity: feedback.severity,
      remark: feedback.remark || '',
      timestamp: feedback.created_at
    });
    
    // Keep only recent history
    if (state.feedbackHistory.length > 20) {
      state.feedbackHistory.shift();
    }
    
    // Track thought history - add the funny_observation to thoughtHistory (what users see)
    if (feedback.funny_observation) {
      // Add to thought history
      if (!state.thoughtHistory) {
        state.thoughtHistory = [];
      }
      
      // Simple duplicate check - exact match only
      const isDuplicate = state.thoughtHistory.some(
        existing => existing.toLowerCase() === feedback.funny_observation.toLowerCase()
      );
      
      // Only add if not duplicate
      if (!isDuplicate) {
        state.thoughtHistory.push(feedback.funny_observation);
        
        // Keep only last 10 unique thoughts for avoiding repetition
        if (state.thoughtHistory.length > 10) {
          state.thoughtHistory.shift();
        }
      }
    }
    
    // Set current feedback for display
    state.currentFeedback = {
      icon: feedback.icon || this.getIconForFeedback(feedback),
      remark: feedback.funny_observation || '', // Show funny_observation to users, not the internal remark
      timestamp: Date.now()
    };
    
    // Apply happiness changes
    if (feedback.severity === 'good') {
      state.happiness = Math.min(100, state.happiness + 5);
    } else if (feedback.severity === 'problematic') {
      state.happiness = Math.max(0, state.happiness - 5);
    } else if (feedback.severity === 'annoying') {
      state.happiness = Math.max(0, state.happiness - 2);
    }
  }
  
  /**
   * Get icon for feedback type
   */
  private getIconForFeedback(feedback: Feedback): string {
    if (feedback.severity === 'problematic') {
      return '⚠️';
    } else if (feedback.severity === 'annoying') {
      return '💭';
    } else if (feedback.severity === 'good') {
      return '✨';
    } else {
      return '👀';
    }
  }
  
  /**
   * Get feedback thought for display
   */
  getFeedbackThought(state: PetState): string | null {
    // Return null if system is not initialized (disabled)
    if (!this.initialized || !this.analyzer) {
      return null;
    }
    
    // Always try to get the latest feedback from the database
    if (this.analyzer) {
      const latestFeedback = this.analyzer.getCachedFeedback();
      if (latestFeedback && latestFeedback.length > 0) {
        const mostRecent = latestFeedback[0]; // Already sorted by recency
        if (mostRecent.funny_observation) {
          // Update state with the latest
          state.currentFeedback = {
            icon: mostRecent.icon || this.getIconForFeedback(mostRecent.severity),
            remark: mostRecent.funny_observation,
            timestamp: Date.now()
          };
          // Mark as shown so we don't repeat it
          if (mostRecent.id) {
            this.analyzer.markFeedbackShown([mostRecent.id]);
          }
          return mostRecent.funny_observation;
        }
      }
    }
    
    // Fall back to current feedback if nothing new
    if (!state.currentFeedback) {
      return null;
    }
    
    // Keep feedback visible longer (5 minutes)
    const age = Date.now() - state.currentFeedback.timestamp;
    if (age > 300000) {
      state.currentFeedback = undefined;
      return null;
    }
    
    return state.currentFeedback.remark;
  }
  
  /**
   * Get feedback icon for display
   */
  getFeedbackIcon(state: PetState): string | null {
    // Return null if system is not initialized (disabled)
    if (!this.initialized) {
      return null;
    }
    
    if (!state.currentFeedback) {
      return null;
    }
    
    return state.currentFeedback.icon;
  }
  
  /**
   * Cleanup
   */
  close(): void {
    if (this.analyzer) {
      this.analyzer.close();
    }
  }
}