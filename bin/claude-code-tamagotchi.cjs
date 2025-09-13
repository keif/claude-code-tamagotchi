#!/usr/bin/env node

// CLI entry point for claude-code-tamagotchi
// This file serves as the binary entry point when installed globally

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const command = args[0];
const commandArg = args[1];

// Pet care commands that can be run from CLI
const petCommands = ['feed', 'play', 'pet', 'clean', 'sleep', 'wake', 'stats', 'status', 'name', 'reset', 'violation-check'];

// If no command or "statusline" command, run the statusline
if (!command || command === 'statusline') {
  const scriptPath = path.join(__dirname, '..', 'src', 'index.ts');
  
  // Check if bun is available
  const runner = process.env.BUN_INSTALL ? 'bun' : 'node';
  
  const child = spawn(runner, [scriptPath], {
    stdio: 'inherit',
    env: process.env
  });
  
  child.on('error', (err) => {
    console.error('Failed to start claude-code-tamagotchi:', err);
    process.exit(1);
  });
  
  child.on('exit', (code) => {
    process.exit(code || 0);
  });
} else if (petCommands.includes(command)) {
  // Handle pet care commands
  const cliPath = path.join(__dirname, '..', 'src', 'commands', 'cli.ts');
  
  // Check if bun is available
  const runner = process.env.BUN_INSTALL ? 'bun' : 'node';
  
  // Build the command arguments
  const cliArgs = [cliPath, command];
  if (commandArg) {
    cliArgs.push(commandArg);
  }
  
  const child = spawn(runner, cliArgs, {
    stdio: 'inherit',
    env: process.env
  });
  
  child.on('error', (err) => {
    console.error(`Failed to execute pet command '${command}':`, err);
    process.exit(1);
  });
  
  child.on('exit', (code) => {
    process.exit(code || 0);
  });
} else if (command === '--version' || command === '-v' || command === 'version') {
  const pkg = require('../package.json');
  console.log(`claude-code-tamagotchi v${pkg.version}`);
} else if (command === 'help' || command === '--help' || command === '-h') {
  console.log(`
🐾 Claude Code Tamagotchi - Virtual Pet for your statusline

USAGE:
  claude-code-tamagotchi [command] [options]

GENERAL:
  claude-code-tamagotchi              Run the statusline (default)
  claude-code-tamagotchi statusline   Run the statusline
  claude-code-tamagotchi --version    Show version
  claude-code-tamagotchi help         Show this help message

PET CARE COMMANDS:
  claude-code-tamagotchi feed [food]  Feed your pet (pizza, cookie, sushi, etc.)
  claude-code-tamagotchi play [toy]   Play with your pet (ball, frisbee, laser, etc.)
  claude-code-tamagotchi pet          Pet your companion (+happiness)
  claude-code-tamagotchi clean        Give your pet a bath
  claude-code-tamagotchi sleep        Put your pet to sleep
  claude-code-tamagotchi wake         Wake up your pet
  claude-code-tamagotchi stats        View detailed pet statistics
  claude-code-tamagotchi status       Quick pet status check
  claude-code-tamagotchi name [name]  Set your pet's name
  claude-code-tamagotchi reset        Reset pet (careful - starts over!)

EXAMPLES:
  # Feed your pet pizza
  claude-code-tamagotchi feed pizza
  
  # Play fetch with your pet
  claude-code-tamagotchi play ball
  
  # Check how your pet is doing
  claude-code-tamagotchi status
  
  # Name your pet
  claude-code-tamagotchi name "Mr. Fluffkins"

INSTALLATION:
  # Global install with npm:
  npm install -g claude-code-tamagotchi
  
  # Or with bun:
  bun add -g claude-code-tamagotchi
  
  # Then update your Claude Code settings.json:
  {
    "statusLine": {
      "type": "command",
      "command": "bunx claude-code-tamagotchi statusline"
    }
  }

  # Or use slash commands in Claude Code:
  /pet-feed pizza
  /pet-play ball
  /pet-status

MORE INFO:
  https://github.com/Ido-Levi/claude-code-tamagotchi
`);
} else {
  console.error(`Unknown command: ${command}`);
  console.log('Run "claude-code-tamagotchi help" for usage information');
  console.log('');
  console.log('Available commands: feed, play, pet, clean, sleep, wake, stats, status, name, reset');
  process.exit(1);
}