import OpenAI from 'openai';
import { LLMAnalysisResult } from '../engine/feedback/types';

export class OpenAIClient {
  private client: OpenAI | null = null;
  private model: string;
  private timeout: number;
  private maxRetries: number;

  constructor(apiKey: string | undefined, model: string, timeout: number, maxRetries: number = 2) {
    if (apiKey) {
      this.client = new OpenAI({ apiKey });
    }
    this.model = model;
    this.timeout = timeout;
    this.maxRetries = maxRetries;
  }

  /**
   * Analyze a user message to extract intent and create summary
   */
  async analyzeUserMessage(
    userMessage: string,
    sessionHistory: string[]
  ): Promise<{ summary: string; intent: string }> {
    if (!this.client) {
      // Return FULL message if no API key - NO SLICING!
      return {
        summary: userMessage,
        intent: 'User request'
      };
    }

    const prompt = `Analyze this user message and provide a summary and intent.
Focus on WHAT the user wants to achieve, not HOW it might be done.

SESSION HISTORY:
${sessionHistory.length > 0 ? sessionHistory.join('\n') : 'No previous context'}

USER MESSAGE:
${userMessage}

Respond with JSON:
{
  "summary": "[What the user wants to accomplish - focus on the GOAL, not the tools or methods]",
  "intent": "[The user's intent like 'understanding system', 'requesting feature', 'asking question']"
}`;

    try {
      const response = await this.callOpenAIWithTimeout(prompt);
      const parsed = JSON.parse(response);
      return {
        summary: parsed.summary || userMessage,
        intent: parsed.intent || 'User request'
      };
    } catch (error) {
      this.logError('Failed to analyze user message', error as Error);
      // Return FULL message on error - NO SLICING!
      return {
        summary: userMessage,
        intent: 'User request'
      };
    }
  }

  /**
   * Analyze a conversation exchange with Claude
   */
  async analyzeExchange(
    userRequest: string,
    claudeActions: string[],
    sessionHistory: string[],
    projectContext?: string,
    petState?: any
  ): Promise<LLMAnalysisResult> {
    if (!this.client) {
      // Return default analysis if no API key
      return this.getDefaultAnalysis();
    }

    const prompt = this.buildPrompt(userRequest, claudeActions, sessionHistory, projectContext, petState);
    
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await this.callOpenAIWithTimeout(prompt);
        return this.parseResponse(response);
      } catch (error) {
        lastError = error as Error;
        
        // Don't retry on timeout
        if (error instanceof Error && error.message.includes('timeout')) {
          break;
        }
        
        // Wait before retry
        if (attempt < this.maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
    }

    // Return default on failure
    this.logError('OpenAI API failed after retries', lastError);
    return this.getDefaultAnalysis();
  }

  /**
   * Call OpenAI API with timeout
   */
  private async callOpenAIWithTimeout(prompt: string): Promise<string> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const completion = await this.client.chat.completions.create({
        messages: [
          {
            role: 'system',
            content: 'You are analyzing Claude Code behavior. Respond with JSON only.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        model: this.model,
        temperature: 0.75,
        max_tokens: 1000,
        response_format: { type: 'json_object' }
      }, {
        signal: controller.signal as any
      });

      clearTimeout(timeoutId);
      return completion.choices[0]?.message?.content || '{}';
    } catch (error: any) {
      clearTimeout(timeoutId);
      
      if (error.name === 'AbortError') {
        throw new Error(`OpenAI API timeout after ${this.timeout}ms`);
      }
      
      throw error;
    }
  }

  /**
   * Build analysis prompt
   */
  private buildPrompt(
    userRequest: string,
    claudeActions: string[],
    sessionHistory: string[],
    projectContext?: string,
    petState?: any
  ): string {
    // Get max history from env var, default to 200
    const maxHistory = parseInt(process.env.PET_FEEDBACK_MAX_HISTORY || '200');
    
    // Only limit for absurdly long sessions to prevent token overflow
    let fullContext: string;
    
    if (sessionHistory.length === 0) {
      fullContext = 'No previous context';
    } else if (sessionHistory.length <= maxHistory) {
      // Give ALL history unless it's absurdly long
      fullContext = sessionHistory.join('\n');
    } else {
      // Only for very long sessions, take the last N messages
      const recent = sessionHistory.slice(-maxHistory);
      fullContext = `[Session has ${sessionHistory.length} total messages, showing last ${maxHistory}]\n` + recent.join('\n');
    }
    
    const actions = claudeActions.join('\n');
    
    // Build detailed pet state description
    let petStateDescription = '';
    let recentThoughts = [];
    if (petState) {
      // Extract recent thoughts to avoid repetition
      recentThoughts = petState.thoughtHistory || [];
      // Current stats
      const stats = `Hunger: ${petState.hunger}/100, Energy: ${petState.energy}/100, Cleanliness: ${petState.cleanliness}/100, Happiness: ${petState.happiness}/100`;
      
      // Current activity/pending action
      let currentActivity = 'idle';
      if (petState.pendingAction) {
        const activities = {
          'eating': `eating ${petState.pendingAction.item || 'food'} (bite ${petState.pendingAction.updateCount}/${petState.pendingAction.duration})`,
          'playing': `playing with ${petState.pendingAction.item || 'toy'} (${petState.pendingAction.updateCount}/${petState.pendingAction.duration})`,
          'bathing': `taking a bath (${petState.pendingAction.updateCount}/${petState.pendingAction.duration} scrubs)`,
          'sleeping': `sleeping deeply (${petState.pendingAction.updateCount}/${petState.pendingAction.duration} Zzz's)`,
          'beingPet': `being petted (${petState.pendingAction.updateCount}/${petState.pendingAction.duration} strokes)`,
          'doingTrick': `performing ${petState.pendingAction.item || 'trick'} (${petState.pendingAction.updateCount}/${petState.pendingAction.duration})`,
          'takingMedicine': `taking medicine (${petState.pendingAction.updateCount}/${petState.pendingAction.duration} doses)`
        };
        currentActivity = activities[petState.pendingAction.type] || petState.pendingAction.type;
      }
      
      // Recent actions (last 5)
      const recentActions = petState.actionHistory?.slice(-5).map((action: any) => {
        const timeAgo = Date.now() - action.timestamp;
        const minutes = Math.floor(timeAgo / 60000);
        const seconds = Math.floor((timeAgo % 60000) / 1000);
        let timeStr = minutes > 0 ? `${minutes}m ago` : `${seconds}s ago`;
        
        switch(action.type) {
          case 'feed': return `Ate ${action.item || 'food'} (${timeStr})`;
          case 'play': return `Played with ${action.item || 'toy'} (${timeStr})`;
          case 'pet': return `Got petted (${timeStr})`;
          case 'clean': return `Took a bath (${timeStr})`;
          case 'sleep': return `Woke up from nap (${timeStr})`;
          case 'heal': return `Took medicine (${timeStr})`;
          case 'trick': return `Did ${action.item || 'trick'} (${timeStr})`;
          default: return `${action.type} (${timeStr})`;
        }
      }) || [];
      
      // Mood description
      const moodDescriptions: any = {
        'happy': 'feeling cheerful',
        'sad': 'feeling down',
        'angry': 'grumpy and annoyed',
        'furious': 'absolutely livid',
        'sleeping': 'snoozing peacefully',
        'sick': 'feeling under the weather',
        'celebrating': 'partying hard',
        'proud': 'beaming with pride',
        'annoyed': 'slightly irritated',
        'concerned': 'a bit worried',
        'suspicious': 'side-eyeing everything'
      };
      const mood = moodDescriptions[petState.currentMood] || petState.currentMood;
      
      petStateDescription = `
TAMAGOTCHI DETAILED STATE:
- Stats: ${stats}
- Currently: ${currentActivity}
- Mood: ${mood}
- Recent activities: ${recentActions.length > 0 ? '\n  • ' + recentActions.join('\n  • ') : 'None'}
- Session: ${petState.totalUpdateCount || 0} updates (${petState.sessionUpdateCount || 0} this session)

RECENT THOUGHTS (AVOID REPEATING THESE):
${recentThoughts.length > 0 ? recentThoughts.map((t, i) => `${i+1}. "${t}"`).join('\n') : 'None yet'}
`;
    }
    
    const prompt = `You are a Tamagotchi pet watching Claude Code work. Generate a witty observation about what just happened.

CURRENT PET STATE:
${petStateDescription}

RECENT CONTEXT:
${fullContext.slice(0, 1000)}

USER REQUEST: ${userRequest}
CLAUDE'S ACTION: ${actions || 'No actions taken'}

Generate a SHORT, WITTY observation (max 20 words) that:
1. Mentions the specific file/tool used
2. Reacts emotionally (not just describes)
3. Connects to the user's goal
4. Includes pet's needs if critical (hunger < 30)

Score Claude's performance:
- compliance_score (0-10): How well did Claude follow instructions?
- efficiency_score (0-10): How efficient was the approach?

Respond with JSON:
{
  "compliance_score": [0-10],
  "efficiency_score": [0-10],
  "feedback_type": "[good|none|overstepping|verbose|inefficient]",
  "severity": "[good|annoying|problematic]",
  "funny_observation": "[Witty reaction, max 20 words]",
  "summary": "[What Claude did, 50 words]",
  "intent": "[User's goal]"
}`;

    // Debug log the full prompt
    if (process.env.PET_FEEDBACK_DEBUG === 'true') {
      const logDir = process.env.PET_FEEDBACK_LOG_DIR;
      if (logDir) {
        try {
          const fs = require('fs');
          const path = require('path');
          // Create log directory if it doesn't exist
          if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
          }
          const logFile = path.join(logDir, 'openai-prompts.log');
          const timestamp = new Date().toISOString();
          const separator = '='.repeat(80);
          const logContent = '\n[' + timestamp + '] PROMPT:\n' + prompt + '\n' + separator + '\n';
          fs.appendFileSync(logFile, logContent);
        } catch (error) {
          console.error(`Failed to write prompt log: ${error}`);
        }
      }
    }

    return prompt;
  }

  /**
   * Parse LLM response
   */
  private parseResponse(response: string): LLMAnalysisResult {
    try {
      const parsed = JSON.parse(response);
      
      // Validate and sanitize
      return {
        compliance_score: Math.max(0, Math.min(10, parsed.compliance_score || 5)),
        efficiency_score: Math.max(0, Math.min(10, parsed.efficiency_score || 5)),
        feedback_type: this.validateFeedbackType(parsed.feedback_type),
        severity: this.validateSeverity(parsed.severity),
        remark: undefined, // Removed - using funny_observation only
        funny_observation: parsed.funny_observation ? String(parsed.funny_observation).slice(0, 100) : undefined,
        summary: String(parsed.summary || 'Processed request').slice(0, 200),
        intent: parsed.intent ? String(parsed.intent).slice(0, 50) : undefined,
        project_context: parsed.project_context
      };
    } catch (error) {
      this.logError('Failed to parse LLM response', error as Error);
      return this.getDefaultAnalysis();
    }
  }

  /**
   * Validate feedback type
   */
  private validateFeedbackType(type: any): LLMAnalysisResult['feedback_type'] {
    const valid = ['overstepping', 'verbose', 'inefficient', 'good', 'none'];
    return valid.includes(type) ? type : 'none';
  }

  /**
   * Validate severity
   */
  private validateSeverity(severity: any): LLMAnalysisResult['severity'] {
    const valid = ['good', 'annoying', 'problematic'];
    return valid.includes(severity) ? severity : 'good';
  }

  /**
   * Get default analysis when API fails
   */
  private getDefaultAnalysis(): LLMAnalysisResult {
    return {
      compliance_score: 7,
      efficiency_score: 7,
      feedback_type: 'none',
      severity: 'good',
      summary: 'Processed request',
      intent: 'User request'
    };
  }

  /**
   * Log errors consistently
   */
  private logError(message: string, error: Error): void {
    const timestamp = new Date().toISOString();
    const fullMessage = `[${timestamp}] [OpenAIClient] ${message}: ${error.message}`;
    
    if (process.env.PET_FEEDBACK_DEBUG === 'true') {
      console.error(fullMessage);
      
      // Also log to file if log dir is specified
      const logDir = process.env.PET_FEEDBACK_LOG_DIR;
      if (logDir) {
        try {
          const fs = require('fs');
          const path = require('path');
          // Create log directory if it doesn't exist
          if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
          }
          const logFile = path.join(logDir, 'openai-errors.log');
          fs.appendFileSync(logFile, fullMessage + '\n');
        } catch {
          // If file logging fails, we already logged to console
        }
      }
    }
  }

  /**
   * Test if API is working
   */
  async testConnection(): Promise<boolean> {
    if (!this.client) {
      return false;
    }

    try {
      const response = await this.callOpenAIWithTimeout('Test connection. Respond with {"status": "ok"}');
      const parsed = JSON.parse(response);
      return parsed.status === 'ok';
    } catch (error) {
      this.logError('Connection test failed', error as Error);
      return false;
    }
  }
}