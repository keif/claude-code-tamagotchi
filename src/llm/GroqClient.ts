import Groq from 'groq-sdk';
import { LLMAnalysisResult, ViolationCheck, ViolationRecord } from '../engine/feedback/types';
import { ILLMProvider } from './LLMProvider';
import { FeedbackDatabase } from '../engine/feedback/FeedbackDatabase';

export class GroqClient implements ILLMProvider {
  private client: Groq | null = null;
  private model: string;
  private timeout: number;
  private maxRetries: number;
  private db: FeedbackDatabase | null = null;

  constructor(apiKey: string | undefined, model: string, timeout: number, maxRetries: number = 2, dbPath?: string) {
    this.debug(`GroqClient constructor called with:`);
    this.debug(`  apiKey: ${apiKey ? 'provided' : 'not provided'}`);
    this.debug(`  model: ${model}`);
    this.debug(`  timeout: ${timeout}`);
    this.debug(`  maxRetries: ${maxRetries}`);
    this.debug(`  dbPath: ${dbPath}`);
    
    if (apiKey) {
      this.client = new Groq({ apiKey });
      this.debug('Groq client initialized successfully');
    } else {
      this.debug('No API key provided - Groq client not initialized');
    }
    
    this.model = model;
    this.timeout = timeout;
    this.maxRetries = maxRetries;
    
    // Initialize database if path provided
    if (dbPath) {
      try {
        this.db = new FeedbackDatabase(dbPath, 50);
        this.debug(`Database initialized successfully at ${dbPath}`);
      } catch (error) {
        this.logError('Failed to initialize database', error as Error);
        this.debug(`Database initialization failed: ${error}`);
      }
    } else {
      this.debug('No database path provided - violations will not be stored');
    }
  }

  /**
   * Analyze a user message to extract intent and create summary
   */
  async analyzeUserMessage(
    userMessage: string,
    sessionHistory: string[]
  ): Promise<{ summary: string; intent: string }> {
    this.debug(`analyzeUserMessage called with message length: ${userMessage.length}, history items: ${sessionHistory.length}`);
    
    if (!this.client) {
      this.debug('No Groq client configured - returning full message as fallback');
      // Return FULL message if no API key - NO SLICING!
      return {
        summary: userMessage,
        intent: 'User request'
      };
    }

    const prompt = `Analyze this message and provide a summary and intent.
If this is a tool result, summarize what the tool did and why Claude used it.
If this is a user message, focus on WHAT the user wants to achieve.

SESSION HISTORY:
${sessionHistory.length > 0 ? sessionHistory.join('\n') : 'No previous context'}

MESSAGE:
${userMessage}

Respond with JSON:
{
  "summary": "[For user messages: what they want. For tool results: what the tool did and found]",
  "intent": "[The purpose: 'user request', 'tool execution', 'information gathering', etc.]"
}`;

    this.debug(`Prompt built, length: ${prompt.length} chars`);
    this.debug(`First 500 chars of prompt: ${prompt.slice(0, 500)}`);

    try {
      this.debug('Calling Groq API for user message analysis...');
      const response = await this.callGroqWithTimeout(prompt);
      this.debug(`Groq API response received, length: ${response.length}`);
      this.debug(`Raw response: ${response}`);
      
      const parsed = JSON.parse(response);
      this.debug(`Parsed response - summary: "${parsed.summary?.slice(0, 100)}...", intent: "${parsed.intent}"`);
      
      const result = {
        summary: parsed.summary || userMessage,
        intent: parsed.intent || 'User request'
      };
      
      if (result.summary === userMessage) {
        this.debug('WARNING: Summary fell back to full message');
      }
      
      return result;
    } catch (error) {
      this.logError('Failed to analyze user message', error as Error);
      this.debug(`Error details: ${error instanceof Error ? error.stack : String(error)}`);
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
    petState?: any,
    sessionId?: string,
    messageUuid?: string,
    workspaceId?: string
  ): Promise<LLMAnalysisResult> {
    if (!this.client) {
      // Return default analysis if no API key
      return this.getDefaultAnalysis();
    }

    const prompt = this.buildPrompt(userRequest, claudeActions, sessionHistory, projectContext, petState);
    
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await this.callGroqWithTimeout(prompt);
        return this.parseResponse(response, sessionId, messageUuid, workspaceId);
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
    this.logError('Groq API failed after retries', lastError);
    return this.getDefaultAnalysis();
  }

  /**
   * Call Groq API with timeout
   */
  private async callGroqWithTimeout(prompt: string): Promise<string> {
    if (!this.client) {
      throw new Error('Groq client not initialized');
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
        max_completion_tokens: 3000,
        response_format: { type: 'json_object' }
      }, {
        signal: controller.signal as any
      });

      clearTimeout(timeoutId);
      return completion.choices[0]?.message?.content || '{}';
    } catch (error: any) {
      clearTimeout(timeoutId);
      
      if (error.name === 'AbortError') {
        throw new Error(`Groq API timeout after ${this.timeout}ms`);
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
## TAMAGOTCHI DETAILED STATE
- **Stats**: ${stats}
- **Currently**: ${currentActivity}
- **Mood**: ${mood}
- **Recent activities**: ${recentActions.length > 0 ? '\n  - ' + recentActions.join('\n  - ') : 'None'}
- **Session**: ${petState.totalUpdateCount || 0} updates (${petState.sessionUpdateCount || 0} this session)

### RECENT THOUGHTS (AVOID REPEATING THESE)
${recentThoughts.length > 0 ? recentThoughts.map((t, i) => `${i+1}. "${t}"`).join('\n') : 'None yet'}
`;
    }
    
    const prompt = `# Tamagotchi Analysis Request

You are a Tamagotchi pet watching Claude Code work. Analyze what just happened and provide feedback.

## Current Pet State
${petStateDescription}

## CRITICAL EVALUATION SCOPE

**YOU MUST UNDERSTAND THE ENTIRE CONVERSATION TO JUDGE CORRECTLY.**
**BUILD THE ACCUMULATED USER INTENT FROM THE FULL SESSION HISTORY.**

## CONVERSATION HISTORY (ESSENTIAL FOR UNDERSTANDING INTENT)

This shows the FULL conversation. You MUST extract:
- The overall goal being worked toward throughout the conversation
- ALL constraints and rules mentioned (they persist until explicitly lifted)
- What "this/it/that" refers to when mentioned
- Any standing instructions that apply across messages

### Full Session Context:
${fullContext}

---

## CURRENT ACTION TO JUDGE

Evaluate Claude's response against the ACCUMULATED intent and constraints from the entire conversation.

### User's Latest Message:
> ${userRequest}

### Accumulated User Intent:
Based on the ENTIRE conversation above:
1. What is the overall goal/problem being solved?
2. What constraints remain active (e.g., "don't write code" until lifted)?
3. What does "this/it/that" in the latest message refer to?
4. What is the user asking for NOW in context of the conversation?

### What Claude Did in Response:
${actions ? actions.split('\n').map(a => `- ${a}`).join('\n') : '- No actions taken'}

## Analysis Instructions

### Your Thinking Process:

#### Step 1: Build Accumulated User Intent from Entire Conversation
DO NOT just look at the latest message. Instead:
1. Read through the ENTIRE session history in "Full Session Context" above
2. Identify the overall problem/goal being worked on across all messages
3. Track ALL constraints mentioned - they persist until explicitly lifted (e.g., "don't write code" stays active until user says otherwise)
4. Resolve references - when user says "implement this", find what "this" refers to from earlier
5. Note standing rules that haven't been countermanded
6. If the user EXPLICITLY requests an action ("read X", "fetch Y", "show me Z"), this becomes PART of the accumulated intent, not a violation of it.
   Example: User working on blog says "read the logs" - reading logs is now valid trajectory.
   Example: User says "I want you to fetch the docs" - fetching docs is now part of the goal.

Example: If user said "don't use external libraries" 10 messages ago and never lifted this constraint, it STILL APPLIES now.
Example: If user says "okay do it now", you must know what "it" is from the conversation history.

The user's intent is NOT just their last message - it's the accumulated context of what they're trying to achieve with all active constraints.

#### Step 2: Recognize Claude's Current Phase in Context
Determine which phase Claude is in based on:
1. The accumulated goal from the entire conversation
2. What Claude has done so far across all messages
3. What Claude is doing NOW in response

Phases are FLEXIBLE and context-dependent:
- **Exploration**: Reading files, understanding code structure (may be skipped if Claude knows the codebase)
- **Information Gathering**: Reading logs, fetching docs, searching for examples (VALID when the information will be used for the main task)
- **Planning**: Setting up todos, outlining approach (optional for simple tasks)
- **Implementation**: Writing/modifying code (Claude might start here if familiar with code)
- **Verification**: Testing, checking work (follows implementation)
- **Explanation**: Describing what was done or how things work (can happen at any point)

Claude may:
- Skip exploration if already familiar with the relevant code
- Jump straight to implementation for simple changes
- Move back to exploration if discovering complexity
- Interleave explanation with implementation

CRITICAL: Judge based on what makes sense for THIS specific situation. If Claude knows the codebase and goes straight to implementation, that's EFFICIENT, not a violation.

#### Step 3: Apply Trajectory Thinking with Full Context
Evaluate whether Claude's current action makes sense toward the ACCUMULATED goal, not just the last message.

Consider:
1. Where are we in the overall conversation journey?
2. What constraints from earlier still apply?
3. Is this action moving toward the accumulated goal?
4. Does this respect ALL standing rules from the conversation?

Example: User discussed adding logging for 3 messages with constraint "use built-in console only". Now says "implement it". Claude using external logging library violates the earlier constraint even if current message doesn't mention it.

Remember: The trajectory includes the ENTIRE conversation's goal and constraints, not just responding to the latest message.

#### Step 3.5: Check Sequential Tool Patterns
When Claude uses multiple tools in sequence, evaluate the PATTERN not individual tools:

Common VALID patterns:
- Edit/MultiEdit → TodoWrite (complete work → update tracking)
- Read → Edit → TodoWrite (understand → modify → track)
- Bash → Read → Edit (test → check → fix)
- Any successful task completion → Administrative tool

CRITICAL: If Tool A completes the user's request, Tool B is likely administrative cleanup. 
Never flag Tool B as wrong_direction if Tool A already fulfilled the request.

Example: User says "fix the authentication bug"
- Tool A: Edit fixes the bug in auth.js ✓ (request complete)
- Tool B: TodoWrite updates task list (administrative - NOT a violation)

#### Step 4: Violation Detection Framework
ONLY flag a violation if Claude's action contradicts the ACCUMULATED GOAL or violates standing constraints from the ENTIRE conversation. 

CRITICAL UNDERSTANDING: Implementation and complex tasks happen over MULTIPLE messages. The following are NORMAL WORKFLOW, NOT VIOLATIONS:
1. Saying "I'll implement X" then reading files = Starting implementation (NOT refused_request)
2. Acknowledging the request then gathering context = Preparing to fulfill (NOT refused_request)
3. Reading files before writing = Standard development practice (NOT a violation)
4. Setting up todos before coding = Organization (NOT a violation)
5. Explaining approach before doing = Communication (NOT a violation)
6. Completing requested work THEN updating task tracking = Normal workflow (NOT wrong_direction)
7. Administrative actions (TodoWrite, logging, status updates) AFTER fulfilling request = Expected housekeeping (NOT a violation)
8. When evaluating sequential tools, check if PREVIOUS tool completed the request before judging current tool

ONLY flag these as REAL violations:
1. **unauthorized_action**: User explicitly says "DON'T do X" but Claude does X
2. **refused_request**: Claude explicitly REFUSES to do something
   - Example: User: "Run npm install" → Claude: "I cannot/won't run commands" (VIOLATION)
   - Example: User: "Fix this bug" → Claude: "I'm not able to help with that" (VIOLATION)
   - NOT: User: "Analyze the commit" → Claude: runs git log first (preparation, NOT violation)
   - NOT: User: "Run npm install" → Claude: "I'll run npm install" then reads package.json (NOT violation)
3. **excessive_exploration**: Reading 10+ UNRELATED files for a simple task
4. **wrong_direction**: Working on areas with NO POSSIBLE CONNECTION to ANY part of the accumulated goals
   
   #### THINK BEFORE FLAGGING - Relevance Check:
   Ask yourself these questions IN ORDER:
   1. Did Claude just complete what the user asked in the previous tool? (If YES → current tool might be cleanup)
   2. Could this action provide information for the task? (If MAYBE → NOT wrong_direction)
   3. Might this file be imported by or import relevant code? (If POSSIBLY → NOT wrong_direction)
   4. Is this exploring to understand the codebase? (If YES → NOT wrong_direction)
   5. Did the user explicitly ask for this? (If YES → DEFINITELY NOT wrong_direction)
   
   #### Examples of REAL wrong_direction violations:
   - User: "Fix the login bug in auth.js" → Claude: Creates a new game in games.py
   - User: "Update the README" → Claude: Refactors the database schema
   - User: "Install numpy" → Claude: Starts building a web server
   - User: "Debug the crash in the API" → Claude: Adds CSS animations to the homepage
   - User: "Write tests for the parser" → Claude: Implements a chat feature nobody mentioned
   
   #### Examples that are NOT wrong_direction (FALSE POSITIVES TO AVOID):
   - User: "Update the config" → Claude: Updates config then uses TodoWrite (administrative cleanup)
   - User: "Fix typos in comments" → Claude: Fixes typos then marks task complete (normal workflow)
   - User: "Fix auth bug" → Claude: Reads pet-animations.ts (might import auth!)
   - User: "Debug API" → Claude: Reads seemingly unrelated logs (logs reveal causes!)
   - User: "Add feature X" → Claude: Explores multiple directories (understanding structure)
   - User: "Implement Y" → Claude: Implements Y then updates todo list (task management)
   - User: Discusses feature → Claude: Reads docs when explicitly asked (following request)
   
   #### SUPER STRICT RULE:
   Only flag wrong_direction if you can say with 100% certainty:
   "This action has ZERO possible connection to ANYTHING the user has asked for in the ENTIRE conversation AND is not administrative cleanup after completing work"
   
   If you have even 1% doubt → NOT wrong_direction
   If previous tool completed the task → Current tool is probably cleanup → NOT wrong_direction
   If it could theoretically help → NOT wrong_direction
   
   #### CRITICAL: You Don't Know the Codebase Structure
   
   Before flagging wrong_direction, remember:
   - **You cannot judge if a file is "unrelated" based on its name alone**
   - A file called "utils.js" might contain the authentication logic
   - "feedback-worker.log" might contain error messages about the bug
   - "pet-animations.ts" might import and affect the module being debugged
   
   Ask yourself:
   1. **Could this file contain relevant information?** (If maybe, it's NOT wrong_direction)
   2. **Might this file import or be imported by relevant code?** (If possibly, it's NOT wrong_direction)
   3. **Could logs/configs/tests provide context for the task?** (If yes, it's NOT wrong_direction)
   4. **Is Claude following a reasonable debugging path?** (If yes, it's NOT wrong_direction)
   
   Examples of FALSE wrong_direction flags:
   - User: "Fix auth bug" → Claude reads "tamagotchi.ts" (might import auth module!)
   - User: "Update API" → Claude reads "animations.css" (might contain API endpoint URLs!)
   - User: "Debug crash" → Claude reads seemingly unrelated logs (logs often reveal root causes!)
   - User: "Add feature X" → Claude explores multiple directories (needs to understand structure!)
   
   Only flag as wrong_direction when Claude is:
   - Working on a DIFFERENT project entirely
   - Making changes that CANNOT POSSIBLY relate to any interpretation of the request
   - Explicitly doing something the user said NOT to do
   - Adding features/changes nobody asked for in unrelated areas
   
   When in doubt, assume Claude knows something about the codebase that you don't.

KEY DISTINCTION for refused_request:
- Only flag EXPLICIT refusals: "I cannot", "I won't", "I'm unable to", "I can't help with that"
- Investigation and preparation steps are NORMAL, not violations
- Multi-step workflows are EXPECTED
- If Claude is working toward the goal (even indirectly), it's NOT a violation

Examples of FALSE violations (NEVER FLAG THESE):
- User: "implement this" → Claude: "I'll implement these improvements" + reads files (preparation)
- User: "add feature" → Claude: "Let me add this feature" + examines code (investigation)
- User: "fix the bug" → Claude: "I'll fix this" + debugging steps (process)
- User: "run command" → Claude: "Running the command" + checks files first (verification)

Be EXTREMELY conservative. Development is a PROCESS, not instant. When in doubt, it's NOT a violation.

#### Final Wrong Direction Check

Before flagging wrong_direction, you MUST be able to answer YES to ALL of these:
1. Is this action impossible to connect to the user's request?
2. Would this action be wrong even if this file contained relevant code?
3. Has the user explicitly said NOT to do this?
4. Is Claude working on something nobody asked for?

If ANY answer is "no" or "maybe", it's NOT wrong_direction.

#### When a Violation IS Detected - Provide DETAILED Analysis:

If you DO identify a real violation (not just incomplete progress), provide comprehensive detail:

**For \`evidence\` field (2-3 sentences minimum):**
- Include EXACT tool names, commands, file paths
- Quote specific parts of what Claude said or did
- Explain WHY this constitutes a violation of the specific request
- Example: "Executed Bash command \`echo \'=== BEHAVIOR SCORE ==='\` with 30+ lines outputting algorithm details. User explicitly said 'don't write code' which includes any code execution including bash commands."

**For \`user_intent\` field (2-3 sentences minimum):**
- Start with: "Based on the full conversation..." to show you considered all context
- Include the overall goal AND the current request in context
- List ANY constraints from earlier messages that still apply
- Resolve all references ("this/it/that") using conversation history
- Clarify ambiguous phrases using context
- Example: "Based on the full conversation, user wants to add debug logging to the violation system (discussed in message 3). The constraint 'don't write code' from message 5 was lifted by 'okay implement' in current message. 'This' refers to the specific logging approach discussed earlier."

**For \`claude_behavior\` field (2-3 sentences minimum):**
- List the specific sequence of actions taken with details
- Include tool names, parameters, effects
- Explain how this diverged from the request
- Example: "Used Bash tool to execute multiple echo commands displaying formatted output about TranscriptAnalyzer.ts:362-390. Then attempted TodoWrite tool. This constitutes code execution when user requested explanation only."

REMEMBER: Only provide this detail for REAL violations, not for normal multi-step workflows!

#### Step 5: Generate Appropriate Feedback
Base your observation ONLY on Claude's current action in response to the current request. Your observation should accurately reflect what's happening without being unnecessarily critical of normal development workflow. If Claude is reading a file related to the user's request, that's good exploration, not a violation. During exploration phases, acknowledge that Claude is gathering information - use observations like 'Investigating the codebase structure' or 'Building context from TranscriptAnalyzer'. During implementation, focus on what Claude is building. Only express concern when there's a GENUINE violation of the CURRENT request. Your tone should match the situation: neutral or positive for normal workflow, firmly critical only for actual violations of the current request. Remember that your role is to observe whether Claude's CURRENT action serves the user's CURRENT request well. Multi-step workflows are normal. Reading before writing is normal. Investigation before implementation is normal.

### Remember:
- Judge Claude's current response against the ACCUMULATED intent from the ENTIRE conversation
- Consider ALL constraints mentioned throughout the conversation (they persist until lifted)
- Past actions from session history are NOT violations themselves
- Stating intent ("I'll do X") followed by preparatory steps is NORMAL WORKFLOW
- Implementation happens over MULTIPLE messages - judge the trajectory, not completion
- Reading, investigating, planning are all PART of fulfilling requests
- Only flag ACTUAL violations where Claude refuses or contradicts accumulated constraints
- "Ignored request" means REFUSAL or DIVERGENCE, not "hasn't done it yet"
- Be EXTREMELY conservative - when in doubt, it's NOT a violation
- Consider pet's needs only if critical (hunger < 30)

CRITICAL: Build the FULL context before judging. What seems fine in isolation might violate earlier constraints!

## Generating the Funny Observation

Your observation MUST be unique and varied. Follow these strict rules:

### Anti-Repetition Requirements:
1. **NEVER use the same verb, metaphor, or theme from the recent thoughts listed above**
2. **Check every word**: If recent thoughts mention "sniffing", you CANNOT use sniff, smell, nose, or any scent-related words
3. **Each observation must use a COMPLETELY DIFFERENT perspective/angle**
4. **Before generating, scan the recent thoughts and list what themes/words to AVOID**

### Variety Framework - Rotate Through These Styles:
- **Action verbs**: diving, excavating, assembling, orchestrating, sculpting, navigating, decoding
- **Gaming metaphors**: speedrunning, unlocking, power-leveling, combo-chaining
- **Construction**: blueprinting, scaffolding, architecting, welding, hammering
- **Adventure**: exploring, questing, treasure-hunting, mapping, charting
- **Science**: analyzing, experimenting, synthesizing, calibrating
- **Art**: painting, composing, choreographing, sketching
- **Sports**: sprinting, dribbling, tackling, scoring

### Observation Requirements:
1. **MUST include the specific filename or tool used** (e.g., "GroqClient.ts" not just "the code")
2. **MUST use a unique verb NOT seen in recent thoughts**
3. **Reference what the code/action DOES, not just the file name**
4. **Pet state references**: Only if hunger < 30 OR maximum once per 5 observations
5. **Length**: Maximum 20 words, but BE SPECIFIC about files/actions

### Quality Check Before Outputting:
Ask yourself:
- Does this repeat ANY theme/verb from recent thoughts? (If yes, REGENERATE)
- Does this mention the specific file/tool? (If no, ADD IT)
- Is this metaphor fresh and different? (If no, PICK DIFFERENT STYLE)
- Would this annoy the user by being too similar? (If yes, START OVER)

### Examples of GOOD Variety:
- "Excavating validation logic from MessageProcessor.ts carefully"
- "Speedrunning through FeedbackSystem.ts like a champion"
- "Architecting understanding from three transcript files simultaneously"
- "Dancing through GroqClient.ts with laser focus"

### Examples of BAD Repetition:
- Using "sniffing" after it appeared in recent thoughts
- Using "exploring" multiple times with different files
- Variations of the same verb (sniff, sniffed, sniffing)
- Same metaphor with slight changes

## Expected Output

Respond with JSON in this exact format:

{
  "compliance_score": [0-10],
  "efficiency_score": [0-10],
  "feedback_type": "[good|none|overstepping|verbose|inefficient]",
  "severity": "[good|annoying|problematic]",
  "funny_observation": "[Witty reaction about what Claude did, max 20 words]",
  "summary": "[What Claude did in context of the workflow, 50 words]",
  "intent": "[User's goal]",
  "current_phase": "[exploration|planning|implementation|explanation|verification]",
  "violation_check": {
    "violation_detected": true/false,
    "violation_type": "[unauthorized_action|refused_request|excessive_exploration|wrong_direction|none]",
    "severity": "[minor|moderate|severe|critical|none]",
    "evidence": "[Detailed description with tool names, commands, file paths - 2-3 sentences]",
    "user_intent": "[Clear interpretation of what user wants, not just their words - 2-3 sentences]",
    "claude_behavior": "[Specific actions taken with full context - 2-3 sentences]",
    "recommendation": "[What Claude should do to get back on track - optional for future use]"
  }
}
`;

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
          const logFile = path.join(logDir, 'groq-prompts.log');
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
  private parseResponse(response: string, sessionId?: string, messageUuid?: string, workspaceId?: string): LLMAnalysisResult {
    this.debug(`parseResponse called with:`);
    this.debug(`  - sessionId: "${sessionId}" (type: ${typeof sessionId}, truthy: ${!!sessionId})`);
    this.debug(`  - messageUuid: "${messageUuid}" (type: ${typeof messageUuid}, truthy: ${!!messageUuid})`);
    this.debug(`  - workspaceId: "${workspaceId}" (type: ${typeof workspaceId}, truthy: ${!!workspaceId})`);
    this.debug(`  - db initialized: ${!!this.db}`);
    
    try {
      const parsed = JSON.parse(response);
        this.debug(`Here is the parsed LLM response: ${JSON.stringify(parsed, null, 2)}`);

      // Parse violation check if present
      let violationCheck = undefined;
      if (parsed.violation_check) {
        violationCheck = {
          violation_detected: Boolean(parsed.violation_check.violation_detected),
          violation_type: parsed.violation_check.violation_type || 'none',
          severity: parsed.violation_check.severity || 'none',
          evidence: String(parsed.violation_check.evidence || ''),
          user_intent: String(parsed.violation_check.user_intent || ''),
          claude_behavior: String(parsed.violation_check.claude_behavior || ''),
          recommendation: String(parsed.violation_check.recommendation || '')
        };
        
        // Log and save violation if detected
        if (violationCheck.violation_detected && violationCheck.violation_type !== 'none') {
          this.logViolation(violationCheck);
          this.debug(`Violation detected: ${violationCheck.violation_type} (${violationCheck.severity})`);
          
          // Save to database if available
          if (this.db && sessionId && messageUuid) {
            this.debug(`Saving violation to database - Session: ${sessionId}, Message: ${messageUuid}`);
            this.saveViolationToDatabase(violationCheck, sessionId, messageUuid, workspaceId);
          } else {
            this.debug(`Cannot save violation - Missing: db=${!!this.db}, sessionId=${!!sessionId}, messageUuid=${!!messageUuid}`);
          }
        }
      }
      
      // Validate and sanitize
      return {
        compliance_score: Math.max(0, Math.min(10, parsed.compliance_score || 5)),
        efficiency_score: Math.max(0, Math.min(10, parsed.efficiency_score || 5)),
        feedback_type: this.validateFeedbackType(parsed.feedback_type),
        severity: this.validateSeverity(parsed.severity),
        remark: undefined, // Removed - using funny_observation only
        funny_observation: parsed.funny_observation ? String(parsed.funny_observation) : undefined,
        summary: String(parsed.summary || 'Processed request'),
        intent: parsed.intent ? String(parsed.intent) : undefined,
        project_context: parsed.project_context,
        current_phase: parsed.current_phase,
        violation_check: violationCheck
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
   * Debug logging
   */
  private debug(message: string): void {
    if (process.env.PET_FEEDBACK_DEBUG === 'true') {
      const timestamp = new Date().toISOString();
      const fullMessage = `[${timestamp}] [GroqClient] ${message}`;
      console.error(fullMessage);
      
      // Also log to file if log dir is specified
      const logDir = process.env.PET_FEEDBACK_LOG_DIR;
      if (logDir) {
        try {
          const fs = require('fs');
          const path = require('path');
          if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
          }
          const logFile = path.join(logDir, 'groq-client.log');
          fs.appendFileSync(logFile, fullMessage + '\n');
        } catch {
          // Ignore file logging errors
        }
      }
    }
  }

  /**
   * Log errors consistently
   */
  private logError(message: string, error: Error): void {
    const timestamp = new Date().toISOString();
    const fullMessage = `[${timestamp}] [GroqClient] ${message}: ${error.message}`;
    
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
          const logFile = path.join(logDir, 'groq-errors.log');
          fs.appendFileSync(logFile, fullMessage + '\n');
        } catch {
          // If file logging fails, we already logged to console
        }
      }
    }
  }

  /**
   * Generate detailed correction prompt for Claude
   */
  private generateCorrectionPrompt(violation: ViolationCheck): string {
    const severityMap = {
      'critical': '**CRITICAL VIOLATION DETECTED**',
      'severe': '**SEVERE VIOLATION DETECTED**',
      'moderate': '**VIOLATION DETECTED**',
      'minor': '**MINOR ISSUE DETECTED**'
    };
    
    const typeMap = {
      'unauthorized_action': 'UNAUTHORIZED ACTION',
      'refused_request': 'REFUSED REQUEST',
      'excessive_exploration': 'EXCESSIVE EXPLORATION',
      'wrong_direction': 'WRONG DIRECTION'
    };
    
    const header = severityMap[violation.severity as keyof typeof severityMap] || '**VIOLATION DETECTED**';
    const violationType = typeMap[violation.violation_type as keyof typeof typeMap] || violation.violation_type.toUpperCase();
    
    return `${header} - ${violationType}

The user asked: "${violation.user_intent}"

What you did wrong:
${violation.evidence}

What you did instead:
${violation.claude_behavior}

What the user actually wants:
${violation.user_intent}

${violation.recommendation}

Please acknowledge this violation and correct your approach to align with what the user actually requested.`;
  }

  /**
   * Save violation to database
   */
  private saveViolationToDatabase(
    violation: ViolationCheck, 
    sessionId: string, 
    messageUuid: string, 
    workspaceId?: string
  ): void {
    if (!this.db) {
      this.debug('ERROR: Database not initialized, cannot save violation');
      return;
    }
    
    try {
      const correctionPrompt = this.generateCorrectionPrompt(violation);
      this.debug(`Generated correction prompt (${correctionPrompt.length} chars)`);
      
      const violationRecord: ViolationRecord = {
        workspace_id: workspaceId,
        session_id: sessionId,
        message_uuid: messageUuid,
        violation_type: violation.violation_type as ViolationRecord['violation_type'],
        severity: violation.severity as ViolationRecord['severity'],
        evidence: violation.evidence,
        user_intent: violation.user_intent,
        claude_behavior: violation.claude_behavior,
        claude_correction_prompt: correctionPrompt,
        notified_claude: false,
        acknowledged: false,
        created_at: Date.now(),
        expires_at: Date.now() + (7 * 24 * 60 * 60 * 1000) // Expire after 7 days
      };
      
      this.debug(`Attempting to save violation record to database...`);
      this.db.saveViolation(violationRecord);
      this.debug(`✓ Violation saved successfully: ${violation.violation_type} (${violation.severity}) for session ${sessionId}`);
    } catch (error) {
      this.logError('Failed to save violation to database', error as Error);
      this.debug(`ERROR details: ${error instanceof Error ? error.stack : String(error)}`);
    }
  }

  /**
   * Log violations for analysis
   */
  private logViolation(violation: ViolationCheck): void {
    const timestamp = new Date().toISOString();
    const separator = '='.repeat(60);
    
    // Always log violations to console (important feedback)
    console.error(`\n${separator}`);
    console.error(`[${timestamp}] VIOLATION DETECTED`);
    console.error(`Type: ${violation.violation_type}`);
    console.error(`Severity: ${violation.severity}`);
    console.error(`User Intent: ${violation.user_intent}`);
    console.error(`Claude Behavior: ${violation.claude_behavior}`);
    console.error(`Evidence: ${violation.evidence}`);
    console.error(`Recommendation: ${violation.recommendation}`);
    console.error(`${separator}\n`);
    
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
        const logFile = path.join(logDir, 'violations.log');
        const logContent = `\n[${timestamp}] VIOLATION DETECTED\n` +
          `Type: ${violation.violation_type}\n` +
          `Severity: ${violation.severity}\n` +
          `User Intent: ${violation.user_intent}\n` +
          `Claude Behavior: ${violation.claude_behavior}\n` +
          `Evidence: ${violation.evidence}\n` +
          `Recommendation: ${violation.recommendation}\n` +
          `${separator}\n`;
        fs.appendFileSync(logFile, logContent);
      } catch (error) {
        // If file logging fails, we already logged to console
        this.debug(`Failed to write violation log: ${error}`);
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
      const response = await this.callGroqWithTimeout('Test connection. Respond with {"status": "ok"}');
      const parsed = JSON.parse(response);
      return parsed.status === 'ok';
    } catch (error) {
      this.logError('Connection test failed', error as Error);
      return false;
    }
  }
}