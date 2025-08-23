// Unified interface for LLM providers
import { LLMAnalysisResult } from '../engine/feedback/types';

/**
 * Common interface that all LLM providers must implement
 */
export interface ILLMProvider {
  /**
   * Analyze a user message to extract intent and create summary
   */
  analyzeUserMessage(
    userMessage: string,
    sessionHistory: string[]
  ): Promise<{ summary: string; intent: string }>;

  /**
   * Analyze a conversation exchange with Claude
   */
  analyzeExchange(
    userRequest: string,
    claudeActions: string[],
    sessionHistory: string[],
    projectContext?: string,
    petState?: any
  ): Promise<LLMAnalysisResult>;

  /**
   * Test if the provider's API is working
   */
  testConnection(): Promise<boolean>;
}

/**
 * Configuration for LLM providers
 */
export interface LLMProviderConfig {
  provider: 'groq' | 'openai';
  apiKey?: string;
  model: string;
  timeout: number;
  maxRetries?: number;
}

/**
 * Factory class for creating LLM provider instances
 */
export class LLMProviderFactory {
  /**
   * Create a provider instance based on configuration
   */
  static async createProvider(config: LLMProviderConfig): Promise<ILLMProvider> {
    const { provider, apiKey, model, timeout, maxRetries = 2 } = config;

    switch (provider) {
      case 'groq': {
        const { GroqClient } = await import('./GroqClient');
        return new GroqClient(apiKey, model, timeout, maxRetries);
      }
      
      case 'openai': {
        const { OpenAIClient } = await import('./OpenAIClient');
        return new OpenAIClient(apiKey, model, timeout, maxRetries);
      }
      
      default:
        throw new Error(`Unsupported AI provider: ${provider}. Supported providers: groq, openai`);
    }
  }

  /**
   * Create provider configuration from environment variables
   */
  static createConfigFromEnv(): LLMProviderConfig {
    // Provider selection - defaults to 'openai' for backward compatibility
    const provider = (process.env.PET_AI_PROVIDER?.toLowerCase() as 'groq' | 'openai') || 'openai';
    
    let apiKey: string | undefined;
    let model: string;
    let timeout: number;

    // Provider-specific configuration
    if (provider === 'groq') {
      // Groq-specific environment variables
      apiKey = process.env.PET_GROQ_API_KEY || process.env.GROQ_API_KEY;
      model = process.env.PET_GROQ_MODEL || 'openai/gpt-oss-20b';
      timeout = parseInt(process.env.PET_GROQ_TIMEOUT || '2000');
    } else {
      // OpenAI-specific environment variables
      apiKey = process.env.PET_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
      model = process.env.PET_OPENAI_MODEL || 'gpt-3.5-turbo';
      timeout = parseInt(process.env.PET_OPENAI_TIMEOUT || '2000');
    }

    return {
      provider,
      apiKey,
      model,
      timeout,
      maxRetries: 2
    };
  }

  /**
   * Validate that the provider configuration is complete
   */
  static validateConfig(config: LLMProviderConfig): { isValid: boolean; error?: string } {
    if (!config.apiKey) {
      const envVarName = config.provider === 'groq' ? 'PET_GROQ_API_KEY or GROQ_API_KEY' : 'PET_OPENAI_API_KEY or OPENAI_API_KEY';
      return {
        isValid: false,
        error: `API key not found. Please set ${envVarName} environment variable.`
      };
    }

    if (!config.model) {
      return {
        isValid: false,
        error: `Model not specified for ${config.provider} provider.`
      };
    }

    if (!config.timeout || config.timeout <= 0) {
      return {
        isValid: false,
        error: 'Timeout must be a positive number.'
      };
    }

    return { isValid: true };
  }
}