#!/usr/bin/env bun

/**
 * Example showing how to use the unified LLM provider system
 * This demonstrates switching between Groq and OpenAI at runtime
 */

import { LLMProviderFactory, LLMProviderConfig } from './LLMProvider';

async function demonstrateProviderUsage() {
  console.log('🚀 LLM Provider System Demo\n');

  // Example 1: Create provider from environment configuration
  console.log('📋 Creating provider from environment variables...');
  try {
    const envConfig = LLMProviderFactory.createConfigFromEnv();
    console.log(`Selected provider: ${envConfig.provider}`);
    console.log(`Model: ${envConfig.model}`);
    console.log(`Timeout: ${envConfig.timeout}ms`);
    
    const validation = LLMProviderFactory.validateConfig(envConfig);
    if (!validation.isValid) {
      console.log(`❌ Config validation failed: ${validation.error}`);
    } else {
      console.log('✅ Environment config is valid');
      
      // Create provider and test connection
      const provider = await LLMProviderFactory.createProvider(envConfig);
      const connected = await provider.testConnection();
      console.log(`Connection test: ${connected ? '✅ Success' : '❌ Failed'}\n`);
    }
  } catch (error) {
    console.log(`❌ Failed to create provider: ${error}\n`);
  }

  // Example 2: Create specific providers programmatically
  console.log('🔧 Creating providers programmatically...\n');

  const configs: LLMProviderConfig[] = [
    {
      provider: 'openai',
      apiKey: process.env.OPENAI_API_KEY || process.env.PET_OPENAI_API_KEY,
      model: 'gpt-3.5-turbo',
      timeout: 5000,
      maxRetries: 2
    },
    {
      provider: 'groq',
      apiKey: process.env.GROQ_API_KEY || process.env.PET_GROQ_API_KEY,
      model: 'openai/gpt-oss-20b',
      timeout: 2000,
      maxRetries: 2
    }
  ];

  for (const config of configs) {
    console.log(`Testing ${config.provider.toUpperCase()} provider...`);
    
    const validation = LLMProviderFactory.validateConfig(config);
    if (!validation.isValid) {
      console.log(`❌ ${config.provider}: ${validation.error}`);
      continue;
    }

    try {
      const provider = await LLMProviderFactory.createProvider(config);
      console.log(`✅ ${config.provider}: Provider created successfully`);
      
      // Test connection
      const connected = await provider.testConnection();
      console.log(`${connected ? '✅' : '❌'} ${config.provider}: Connection ${connected ? 'successful' : 'failed'}`);
      
      // Test user message analysis if connected
      if (connected) {
        const testMessage = 'Help me implement a new feature for user authentication';
        const analysis = await provider.analyzeUserMessage(testMessage, []);
        console.log(`✅ ${config.provider}: Message analysis successful`);
        console.log(`   Summary: "${analysis.summary}"`);
        console.log(`   Intent: "${analysis.intent}"`);
      }
    } catch (error) {
      console.log(`❌ ${config.provider}: ${error}`);
    }
    console.log('');
  }

  // Example 3: Error handling for invalid provider
  console.log('❌ Testing invalid provider...');
  try {
    const invalidConfig: any = {
      provider: 'invalid-provider',
      apiKey: 'fake-key',
      model: 'fake-model',
      timeout: 5000
    };
    await LLMProviderFactory.createProvider(invalidConfig);
  } catch (error) {
    console.log(`✅ Correctly caught error: ${error}`);
  }

  console.log('\n🎉 Demo complete!');
}

// Run the demo
if (import.meta.main) {
  demonstrateProviderUsage().catch(console.error);
}