#!/bin/bash

# Claude Code Tamagotchi - Feedback System Setup
# This script sets up all the environment variables needed for the AI feedback system

echo "=================================================="
echo "Claude Code Tamagotchi - AI Feedback System Setup"
echo "=================================================="
echo ""

# Create log directory
LOG_DIR="$HOME/.claude/pets/logs"
mkdir -p "$LOG_DIR"
echo "✓ Created log directory: $LOG_DIR"

# Display all the exports needed
cat << 'EOF'

Add these exports to your shell profile (~/.bashrc, ~/.zshrc, etc.):

# ============================================
# CLAUDE CODE TAMAGOTCHI - FEEDBACK SYSTEM
# ============================================

# Core Feature Enable (REQUIRED)
export PET_FEEDBACK_ENABLED=true

# Groq API Configuration (REQUIRED)
export PET_GROQ_API_KEY="your-groq-api-key-here"  # Get from https://console.groq.com/keys
export PET_GROQ_MODEL="openai/gpt-oss-20b"  # Best for quality. Alt: llama-3.1-8b-instant for speed
export PET_GROQ_TIMEOUT=3000
export PET_GROQ_MAX_RETRIES=2
# OpenAI API Configuration (REQUIRED)
export PET_OPENAI_API_KEY="your-openai-api-key-here"  # Get from https://platform.openai.com/api-keys
export PET_OPENAI_MODEL="gpt-3.5-turbo"  # Options: gpt-3.5-turbo, gpt-4, gpt-4-turbo
export PET_OPENAI_TIMEOUT=3000
export PET_OPENAI_MAX_RETRIES=2

# Processing Configuration (OPTIONAL - these are good defaults)
export PET_FEEDBACK_CHECK_INTERVAL=5        # Check every 5 statusline updates
export PET_FEEDBACK_BATCH_SIZE=10          # Process 10 messages at once
export PET_FEEDBACK_MIN_MESSAGES=3         # Min messages before analysis
export PET_FEEDBACK_MODE=full              # full|passive|off

# Mood Thresholds (OPTIONAL - customize pet reactions)
export PET_ANNOYED_THRESHOLD=3             # Issues before annoyed
export PET_ANGRY_THRESHOLD=5               # Issues before angry  
export PET_FURIOUS_THRESHOLD=8             # Issues before furious
export PET_MOOD_DECAY_RATE=10              # How fast mood improves
export PET_PRAISE_BOOST=10                 # Happiness boost for good behavior

# Debug & Logging (OPTIONAL but recommended for monitoring)
export PET_FEEDBACK_DEBUG=true                           # Enable debug logs
export PET_FEEDBACK_LOG_DIR="$HOME/.claude/pets/logs"    # Log directory
export DEBUG_MODE=false                                  # Set to true for console output

# Display Options (OPTIONAL)
export PET_FEEDBACK_ICON_STYLE=emoji       # emoji|ascii|minimal
export PET_SHOW_COMPLIANCE_SCORE=false     # Show Claude's score in statusline
export PET_FEEDBACK_REMARK_LENGTH=50       # Max remark length

# Database (OPTIONAL - default is fine)
export PET_FEEDBACK_DB_PATH="$HOME/.claude/pets/feedback.db"
export PET_FEEDBACK_DB_MAX_SIZE=50         # Max DB size in MB

# ============================================

EOF

echo ""
echo "To enable immediately in current shell, run:"
echo "source ~/.bashrc  # or ~/.zshrc"
echo ""
echo "=================================================="
echo "Testing the system..."
echo ""

# Test with exports
export PET_FEEDBACK_ENABLED=true
# Check for API keys (Groq or OpenAI)
if [ -z "$PET_GROQ_API_KEY" ] && [ -z "$PET_OPENAI_API_KEY" ]; then
  echo "Warning: No API key set. The test will run without AI feedback."
  echo "Set one of the following:"
  echo "  PET_GROQ_API_KEY   → https://console.groq.com/keys"
  echo "  PET_OPENAI_API_KEY → https://platform.openai.com/api-keys"
  export PET_GROQ_API_KEY=""
  export PET_OPENAI_API_KEY=""
fi

export PET_GROQ_MODEL="${PET_GROQ_MODEL:-openai/gpt-oss-20b}"
export PET_OPENAI_MODEL="${PET_OPENAI_MODEL:-gpt-3.5-turbo}"
export PET_FEEDBACK_DEBUG=true
export PET_FEEDBACK_LOG_DIR="$LOG_DIR"
export PET_FEEDBACK_CHECK_INTERVAL=1

# Create a test transcript
TEST_TRANSCRIPT="/tmp/feedback-test.jsonl"
cat > $TEST_TRANSCRIPT << 'TRANSCRIPT'
{"type":"user","uuid":"test1","parentUuid":"","sessionId":"setup123","timestamp":"2025-01-15T10:00:00Z","message":{"role":"user","content":[{"type":"text","text":"Just fix the typo in the header"}]}}
{"type":"assistant","uuid":"test2","parentUuid":"test1","sessionId":"setup123","timestamp":"2025-01-15T10:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"I'll fix the typo and also refactor the entire file for better readability"},{"type":"tool_use","id":"tool1","name":"Edit","input":{"file_path":"/app/header.js"}}]}}
TRANSCRIPT

echo "Running test..."
echo '{"session_id":"setup123","transcript_path":"'$TEST_TRANSCRIPT'"}' | bun run src/index.ts

echo ""
echo "=================================================="
echo "Log files will be saved to:"
echo "  • $LOG_DIR/feedback-system.log    (main system)"
echo "  • $LOG_DIR/feedback-analyzer.log  (analyzer)"
echo "  • $LOG_DIR/feedback-worker.log    (background worker)"
echo ""
echo "To monitor logs in real-time:"
echo "  tail -f $LOG_DIR/*.log"
echo ""
echo "To clear logs:"
echo "  rm $LOG_DIR/*.log"
echo ""
echo "Database location:"
echo "  $HOME/.claude/pets/feedback.db"
echo ""
echo "=================================================="
echo "Setup complete! Your pet will now monitor Claude's behavior!"
echo "=================================================="