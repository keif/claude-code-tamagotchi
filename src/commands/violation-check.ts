#!/usr/bin/env bun

import { FeedbackDatabase } from '../engine/feedback/FeedbackDatabase';
import { ViolationRecord } from '../engine/feedback/types';

/**
 * Pre-hook command for Claude Code to check for violations
 * Reads hook input from stdin and blocks if violations are detected
 */
export async function violationCheck(): Promise<void> {
  try {
    // Check if violation checking is enabled
    const enabled = process.env.PET_VIOLATION_CHECK_ENABLED !== 'false';
    if (!enabled) {
      process.exit(0);
    }

    // If running from terminal (TTY), exit immediately - no stdin to read
    if (process.stdin.isTTY) {
      // Running from terminal, not from hook - exit cleanly
      if (process.env.PET_FEEDBACK_DEBUG === 'true') {
        console.error('[violation-check] No stdin available (running from terminal) - exiting');
      }
      process.exit(0);
    }

    // Read hook input from stdin (we know stdin is available since not TTY)
    const stdinText = await Bun.stdin.text();
    if (!stdinText || !stdinText.trim()) {
      // Empty stdin
      process.exit(0);
    }

    let input: any;
    let sessionId: string | undefined;
    
    try {
      input = JSON.parse(stdinText);
      sessionId = input.session_id;
    } catch (error) {
      // Invalid JSON from stdin
      if (process.env.PET_FEEDBACK_DEBUG === 'true') {
        console.error('[violation-check] Invalid JSON from stdin:', error);
      }
      process.exit(0);
    }
    
    if (!sessionId) {
      // No session ID in input
      process.exit(0);
    }

    // Get configuration from environment
    const minSeverity = process.env.PET_VIOLATION_MIN_SEVERITY || 'moderate';
    const batchViolations = process.env.PET_VIOLATION_BATCH !== 'false'; // Default true
    const maxAgeMinutes = parseInt(process.env.PET_VIOLATION_MAX_AGE || '30');
    
    // Severity levels for comparison
    const severityLevels: Record<string, number> = {
      'minor': 1,
      'moderate': 2,
      'severe': 3,
      'critical': 4
    };
    
    const threshold = severityLevels[minSeverity] || 2;
    
    // Connect to database
    const dbPath = process.env.PET_STATE_FILE?.replace('claude-pet-state.json', 'feedback.db') 
      || process.env.PET_FEEDBACK_DB_PATH
      || '~/.claude/pets/feedback.db';
    
    const db = new FeedbackDatabase(dbPath, 50);
    
    // Get unnotified violations for this session
    const allViolations = db.getUnnotifiedViolations(sessionId);
    
    // Filter by severity threshold and age
    const cutoffTime = Date.now() - (maxAgeMinutes * 60 * 1000);
    const relevantViolations = allViolations.filter(v => {
      const severityLevel = severityLevels[v.severity] || 0;
      const isRecent = v.created_at > cutoffTime;
      return severityLevel >= threshold && isRecent;
    });
    
    if (relevantViolations.length === 0) {
      // No relevant violations, proceed normally
      db.close();
      process.exit(0);
    }
    
    // Sort by severity (most severe first)
    relevantViolations.sort((a, b) => {
      const aLevel = severityLevels[b.severity] || 0;
      const bLevel = severityLevels[a.severity] || 0;
      return bLevel - aLevel;
    });
    
    // Build correction message
    let message: string;
    let violationIdsToMark: number[] = [];
    
    if (batchViolations && relevantViolations.length > 1) {
      // Batch multiple violations
      const header = `**MULTIPLE VIOLATIONS DETECTED (${relevantViolations.length})**\n\n`;
      const violations = relevantViolations.map((v, i) => {
        violationIdsToMark.push(v.id!);
        return `--- Violation ${i + 1} (${v.severity.toUpperCase()}) ---\n${v.claude_correction_prompt}`;
      }).join('\n\n');
      
      message = header + violations + '\n\nPlease acknowledge ALL violations and adjust your approach accordingly.';
    } else {
      // Single violation (or batch disabled)
      const violation = relevantViolations[0];
      violationIdsToMark.push(violation.id!);
      message = violation.claude_correction_prompt;
    }
    
    // Output to stderr (goes to Claude)
    console.error(message);
    
    // Mark violations as notified
    const messageUuid = input.tool_input?.message_uuid || `hook-${Date.now()}`;
    db.markViolationsNotified(violationIdsToMark, messageUuid);
    
    // Clean up
    db.close();
    
    // Exit with code 2 to block the tool and send feedback to Claude
    process.exit(2);
    
  } catch (error) {
    // On any error, don't block Claude - just proceed
    if (process.env.PET_FEEDBACK_DEBUG === 'true') {
      console.error(`[violation-check] Error: ${error}`);
    }
    process.exit(0);
  }
}

// Run if called directly
if (import.meta.main) {
  await violationCheck();
}