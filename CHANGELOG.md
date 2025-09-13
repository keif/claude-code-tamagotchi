# Changelog 📝

All the cool stuff we've added to Claude Code Tamagotchi!

## [1.3.0] - 2025-01-19 🛡️

### The Guardian Update - Your Pet Now Protects You!

#### 🚨 Major Features
- **Violation Detection System** - Your pet can now block Claude from doing things you didn't ask for!
  - Detects 4 violation types: unauthorized_action, refused_request, excessive_exploration, wrong_direction
  - Uses "trajectory thinking" to understand multi-step workflows
  - Pre-hook blocks operations before they execute
  - Experimental feature - help us improve by reporting false positives!

#### 🧠 AI Improvements
- **Session Isolation Fixed** - AI observations no longer leak between different Claude sessions
- **Better User Intent Display** - Violation messages now show proper user summaries from session history
- **Enhanced Trajectory Thinking** - System understands multi-step workflows and overall goals

#### 🔧 Technical Improvements
- Fixed contradiction in violation detection prompt instructions
- Session ID properly passed through feedback retrieval chain
- Database queries now filter by session for proper isolation

## [1.2.1] - 2024-12-02 🔑

### The Flexibility Update

#### 🔧 Fixes
- **API Key Flexibility** - Now accepts both `GROQ_API_KEY` and `PET_GROQ_API_KEY` environment variables
- **Directory Creation** - Automatically creates log directories if they don't exist
- **Better Error Handling** - More graceful failures when directories are missing

## [1.2.0] - 2024-11-25 🤖

### The AI Revolution - Your Pet Got Smarter!

#### ✨ Major Features
- **AI-Powered Real-Time Observations** - Pet generates contextual thoughts using Groq LLM!
  - Watches Claude Code work and reacts with witty commentary
  - 50ms response time for instant reactions
  - Mood changes based on Claude's behavior (happy → concerned → annoyed → angry)
  - Smart caching prevents repetitive thoughts

#### 🧠 AI System Architecture
- **Background Processing** - Spawns lightweight workers for analysis
- **SQLite Message Storage** - Every Claude message summarized and stored
- **Context Building** - Combines user request + Claude's actions + pet state
- **Groq Integration** - Ultra-fast inference with custom chips
- **Feedback Database** - Tracks observations to avoid repetition

#### 🎨 Enhanced Animations
- **Mood-based faces** - Each mood has unique facial expressions
- **Breathing animations** - Subtle movements make pet feel alive
- **Activity indicators** - Visual cues for long coding sessions

#### ⚙️ Configuration
- `PET_FEEDBACK_ENABLED` - Master switch for AI features
- `GROQ_API_KEY` - Your API key from console.groq.com
- `PET_GROQ_MODEL` - Choose between models (default: openai/gpt-oss-20b)
- `PET_FEEDBACK_CHECK_INTERVAL` - How often to check for new observations
- `PET_FEEDBACK_DEBUG` - Enable detailed logging

## [1.0.6] - 2024-10-15 📊

### The Model Display Update

#### ✨ Features
- **Model Display Default** - Now shows Claude's model name by default in statusline
- **Better Defaults** - Improved out-of-box experience

## [1.0.5] - 2024-10-12 🏷️

### The Name Tag Update

#### ✨ Features
- **Model Name Display** - Optionally show which Claude model you're using
- **Configurable via** `PET_SHOW_MODEL` environment variable
- **Cleaner statusline** options for minimalists

## [1.0.0] - 2024-08-14 🎉

### The Birth of Your New Best Friend!

#### ✨ Features
- **Virtual pet that lives in your statusline!** - Never code alone again
- **Activity-based metabolism** - Pet responds to your coding, not just time
- **Breathing animations** - Watch your pet come alive with subtle animations
- **Smart thought system** - Your pet has opinions about your code (and life)
- **12 slash commands** - Feed, play, clean, and more!
- **Session awareness** - Pet knows when you take breaks
- **Customizable personality** - Make your pet chatty or quiet
- **Configurable decay rates** - Casual or hardcore pet parent? You choose!

#### 🎮 Commands Added
- `/pet-pet` - Show your pet some love
- `/pet-feed` - Pizza, cookies, sushi, and more!
- `/pet-play` - Ball, frisbee, puzzle time!
- `/pet-clean` - Squeaky clean pet
- `/pet-sleep` - Nap time for tired pets
- `/pet-wake` - Rise and shine!
- `/pet-status` - Quick status check
- `/pet-stats` - Detailed pet info
- `/pet-name` - Give your pet a name
- `/pet-reset` - Start fresh with a new pet
- `/pet-help` - See all commands

#### 💭 Thought Categories
- **Need-based thoughts** - "My tummy goes hurt hurt!"
- **Coding observations** - "That's a lot of TODO comments..."
- **Random musings** - "Do androids dream of electric sheep?"
- **Mood thoughts** - "I'm so happy right now!"
- **Combo thoughts** - Multiple needs at once

#### ⚙️ Configuration Options
- Environment variables for everything
- Customizable state file location
- Optional directory display
- Optional session counter
- Adjustable decay rates
- Thought frequency controls

#### 🏗️ Technical
- Built with TypeScript and Bun
- State persistence to `~/.claude/pets/`
- Activity-based system (not real-time)
- Session detection with 5-minute gaps
- Atomic file writes for reliability

### Why We Built This
Because coding is better with a friend. Even if that friend occasionally judges your variable names and reminds you that you haven't eaten in 6 hours.

---

*"The best code is written with a pet by your side"* - Ancient Developer Proverb