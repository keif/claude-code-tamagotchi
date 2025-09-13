#!/usr/bin/env bun
// CLI handler for pet commands - to be called directly from command line
import { CommandProcessor } from './CommandProcessor';

const command = process.argv[2];
const args = process.argv.slice(3).join(' ');

async function main() {
  if (!command) {
    console.log('Usage: claude-code-tamagotchi <command> [args]');
    console.log('Run "claude-code-tamagotchi help" for available commands');
    return;
  }
  
  // Special handling for violation-check command
  if (command === 'violation-check') {
    // This command reads from stdin and needs special handling
    const { violationCheck } = await import('./violation-check');
    await violationCheck();
    return;
  }
  
  // Convert CLI command to slash command format expected by CommandProcessor
  // Special handling for commands that need "pet-" prefix
  let slashCommand: string;
  if (command === 'name' || command === 'reset' || command === 'stats' || command === 'status' || command === 'help') {
    slashCommand = `/pet-${command} ${args}`.trim();
  } else {
    // Commands like feed, play, pet, clean, sleep, wake are used without "pet-" prefix
    slashCommand = `/${command} ${args}`.trim();
  }
  const response = await CommandProcessor.processCommand(slashCommand);
  console.log(response);
}

main().catch(console.error);