import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { 
  MessageMetadata, 
  Feedback, 
  ProcessingLock, 
  AnalysisState,
  ViolationRecord 
} from './types';

export class FeedbackDatabase {
  private db: Database;
  private readonly dbPath: string;
  private readonly maxSizeMB: number;

  constructor(dbPath: string, maxSizeMB: number = 50) {
    // Resolve ~ to home directory
    this.dbPath = dbPath.startsWith('~') 
      ? path.join(os.homedir(), dbPath.slice(1))
      : dbPath;
    
    this.maxSizeMB = maxSizeMB;
    
    // Ensure directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // Open database
    this.db = new Database(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    
    // Initialize schema
    this.initializeSchema();
  }

  /**
   * Extract workspace ID from transcript path
   */
  static extractWorkspaceId(transcriptPath: string): string {
    // Path format: /Users/.../projects/WORKSPACE_ID/session.jsonl
    const match = transcriptPath.match(/\/projects\/([^\/]+)\//);  
    return match ? match[1] : 'default';
  }

  private initializeSchema(): void {
    // Create tables
    this.db.exec(`
      -- Processing lock table
      CREATE TABLE IF NOT EXISTS processing_lock (
        message_uuid TEXT PRIMARY KEY,
        process_pid INTEGER NOT NULL,
        locked_at INTEGER NOT NULL,
        completed BOOLEAN DEFAULT 0,
        completed_at INTEGER
      );

      -- Analysis state tracking
      CREATE TABLE IF NOT EXISTS analysis_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_processed_uuid TEXT,
        last_processed_timestamp INTEGER,
        total_messages_processed INTEGER DEFAULT 0,
        last_cleanup_at INTEGER
      );

      -- Message metadata
      CREATE TABLE IF NOT EXISTS message_metadata (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        session_id TEXT NOT NULL,
        message_uuid TEXT UNIQUE NOT NULL,
        parent_uuid TEXT,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        role TEXT,
        summary TEXT,
        intent TEXT,
        project_context TEXT,
        compliance_score INTEGER,
        efficiency_score INTEGER,
        created_at INTEGER NOT NULL
      );

      -- Feedback
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        session_id TEXT NOT NULL,
        message_uuid TEXT NOT NULL,
        feedback_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        remark TEXT,
        funny_observation TEXT,
        icon TEXT,
        shown BOOLEAN DEFAULT 0,
        expires_at INTEGER,
        created_at INTEGER NOT NULL
      );

      -- Violations table for tracking Claude's misbehavior
      CREATE TABLE IF NOT EXISTS violations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT,
        session_id TEXT NOT NULL,
        message_uuid TEXT NOT NULL,
        violation_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        evidence TEXT NOT NULL,
        user_intent TEXT NOT NULL,
        claude_behavior TEXT NOT NULL,
        claude_correction_prompt TEXT NOT NULL,
        notified_claude BOOLEAN DEFAULT 0,
        notified_at INTEGER,
        claude_response_uuid TEXT,
        acknowledged BOOLEAN DEFAULT 0,
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      );

      -- Create indexes
      CREATE INDEX IF NOT EXISTS idx_lock_completed 
        ON processing_lock(completed, locked_at);
      CREATE INDEX IF NOT EXISTS idx_metadata_session 
        ON message_metadata(workspace_id, session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_metadata_uuid 
        ON message_metadata(message_uuid);
      CREATE INDEX IF NOT EXISTS idx_feedback_shown 
        ON feedback(shown, severity, expires_at);
      CREATE INDEX IF NOT EXISTS idx_feedback_uuid 
        ON feedback(message_uuid);
      CREATE INDEX IF NOT EXISTS idx_violations_session 
        ON violations(session_id);
      CREATE INDEX IF NOT EXISTS idx_violations_notified 
        ON violations(notified_claude, session_id);
      CREATE INDEX IF NOT EXISTS idx_violations_severity 
        ON violations(severity, created_at);
    `);

    // Initialize analysis state if not exists
    const state = this.db.query('SELECT * FROM analysis_state WHERE id = 1').get();
    if (!state) {
      this.db.query(
        'INSERT INTO analysis_state (id, total_messages_processed) VALUES (1, 0)'
      ).run();
    }
  }

  // Message metadata operations
  saveMessageMetadata(metadata: MessageMetadata): void {
    const stmt = this.db.query(`
      INSERT OR REPLACE INTO message_metadata (
        session_id, message_uuid, parent_uuid, timestamp, type, role,
        summary, intent, project_context, compliance_score, efficiency_score, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      metadata.session_id,
      metadata.message_uuid,
      metadata.parent_uuid || null,
      metadata.timestamp,
      metadata.type,
      metadata.role || null,
      metadata.summary || null,
      metadata.intent || null,
      metadata.project_context || null,
      metadata.compliance_score || null,
      metadata.efficiency_score || null,
      metadata.created_at
    );
  }

  getRecentMetadata(sessionId: string, limit: number = 10): MessageMetadata[] {
    return this.db.query(`
      SELECT * FROM message_metadata 
      WHERE session_id = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `).all(sessionId, limit) as MessageMetadata[];
  }

  /**
   * Get ALL metadata for a session to build complete context
   */
  getSessionMetadata(sessionId: string): MessageMetadata[] {
    return this.db.query(`
      SELECT * FROM message_metadata 
      WHERE session_id = ? 
      ORDER BY timestamp ASC
    `).all(sessionId) as MessageMetadata[];
  }

  // Feedback operations
  saveFeedback(feedback: Feedback): void {
    const stmt = this.db.query(`
      INSERT INTO feedback (
        session_id, message_uuid, feedback_type, severity,
        remark, funny_observation, icon, shown, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      feedback.session_id,
      feedback.message_uuid,
      feedback.feedback_type,
      feedback.severity,
      feedback.remark || null,
      feedback.funny_observation || null,
      feedback.icon || null,
      feedback.shown ? 1 : 0,
      feedback.expires_at || null,
      feedback.created_at
    );
  }

  getUnshownFeedback(limit: number = 5, sessionId?: string): Feedback[] {
    const now = Date.now();
    
    if (sessionId) {
      // Filter by session ID when provided
      return this.db.query(`
        SELECT * FROM feedback 
        WHERE session_id = ?
        AND shown = 0 
        AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at DESC 
        LIMIT ?
      `).all(sessionId, now, limit) as Feedback[];
    } else {
      // Fallback to original behavior when no session ID
      return this.db.query(`
        SELECT * FROM feedback 
        WHERE shown = 0 
        AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at DESC 
        LIMIT ?
      `).all(now, limit) as Feedback[];
    }
  }

  getLatestSessionFeedback(sessionId: string): Feedback | null {
    const result = this.db.query(`
      SELECT * FROM feedback 
      WHERE session_id = ? 
      AND funny_observation IS NOT NULL
      AND shown = 0
      ORDER BY created_at DESC 
      LIMIT 1
    `).get(sessionId) as Feedback | undefined;
    
    return result || null;
  }

  markFeedbackShown(ids: number[]): void {
    if (ids.length === 0) return;
    
    const placeholders = ids.map(() => '?').join(',');
    this.db.query(`
      UPDATE feedback 
      SET shown = 1 
      WHERE id IN (${placeholders})
    `).run(...ids);
  }

  getRecentFeedback(sessionId: string, limit: number = 10): Feedback[] {
    return this.db.query(`
      SELECT * FROM feedback 
      WHERE session_id = ? 
      ORDER BY created_at DESC 
      LIMIT ?
    `).all(sessionId, limit) as Feedback[];
  }

  getRecentFunnyObservations(sessionId: string, limit: number = 10): string[] {
    const results = this.db.query(`
      SELECT funny_observation FROM feedback 
      WHERE session_id = ? 
      AND funny_observation IS NOT NULL 
      AND funny_observation != ''
      ORDER BY created_at DESC 
      LIMIT ?
    `).all(sessionId, limit) as { funny_observation: string }[];
    
    return results.map(r => r.funny_observation);
  }

  // Processing lock operations
  cleanStaleLocks(staleLockTime: number): number {
    const cutoff = Date.now() - staleLockTime;
    this.db.query(`
      DELETE FROM processing_lock 
      WHERE completed = 0 
      AND locked_at < ?
    `).run(cutoff);
    
    // Bun SQLite doesn't have .changes, so we return 0
    return 0;
  }

  acquireLocks(messageUuids: string[], pid: number): string[] {
    const now = Date.now();
    const acquired: string[] = [];
    
    // Bun SQLite doesn't have transaction() method, use exec with BEGIN/COMMIT
    this.db.exec('BEGIN');
    try {
      for (const uuid of messageUuids) {
        // Check if already locked
        const existing = this.db.query(
          'SELECT * FROM processing_lock WHERE message_uuid = ?'
        ).get(uuid) as ProcessingLock | undefined;
        
        if (!existing || existing.completed) {
          // Acquire lock
          this.db.query(`
            INSERT OR REPLACE INTO processing_lock 
            (message_uuid, process_pid, locked_at, completed) 
            VALUES (?, ?, ?, 0)
          `).run(uuid, pid, now);
          
          acquired.push(uuid);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return acquired;
  }

  markMessagesProcessed(uuids: string[]): void {
    if (uuids.length === 0) return;
    
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      for (const uuid of uuids) {
        // Mark as completed
        this.db.query(`
          UPDATE processing_lock 
          SET completed = 1, completed_at = ? 
          WHERE message_uuid = ?
        `).run(now, uuid);
        
        // Update analysis state
        this.db.query(`
          UPDATE analysis_state 
          SET last_processed_uuid = ?, 
              last_processed_timestamp = ?,
              total_messages_processed = total_messages_processed + 1
          WHERE id = 1
        `).run(uuid, now);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // Analysis state operations
  getAnalysisState(): AnalysisState {
    return this.db.query('SELECT * FROM analysis_state WHERE id = 1').get() as AnalysisState;
  }

  updateLastProcessed(uuid: string): void {
    const now = Date.now();
    this.db.query(`
      UPDATE analysis_state 
      SET last_processed_uuid = ?, last_processed_timestamp = ? 
      WHERE id = 1
    `).run(uuid, now);
  }

  // Check if a message has been processed
  isMessageProcessed(uuid: string): boolean {
    const result = this.db.query(
      'SELECT completed FROM processing_lock WHERE message_uuid = ?'
    ).get(uuid) as { completed: number } | undefined;
    
    return result?.completed === 1;
  }

  // Get unprocessed message UUIDs
  getUnprocessedMessageUuids(afterUuid?: string, limit: number = 10): string[] {
    // This would need to be coordinated with actual transcript reading
    // For now, return empty array as we'll get UUIDs from transcript
    return [];
  }

  // Database maintenance
  checkAndCleanup(): void {
    const stats = fs.statSync(this.dbPath);
    const sizeMB = stats.size / (1024 * 1024);
    
    if (sizeMB > this.maxSizeMB) {
      // Clean old data
      const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000); // 7 days
      
      this.db.query('DELETE FROM message_metadata WHERE created_at < ?').run(cutoff);
      this.db.query('DELETE FROM feedback WHERE created_at < ?').run(cutoff);
      this.db.query('DELETE FROM processing_lock WHERE completed = 1 AND completed_at < ?').run(cutoff);
      
      // Vacuum to reclaim space
      this.db.exec('VACUUM');
      
      // Update cleanup timestamp
      this.db.query('UPDATE analysis_state SET last_cleanup_at = ? WHERE id = 1').run(Date.now());
    }
  }

  // Close database connection
  // Violation operations
  saveViolation(violation: ViolationRecord): void {
    const stmt = this.db.query(`
      INSERT INTO violations (
        workspace_id, session_id, message_uuid, violation_type, severity,
        evidence, user_intent, claude_behavior, claude_correction_prompt,
        notified_claude, notified_at, claude_response_uuid, acknowledged,
        created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      violation.workspace_id || null,
      violation.session_id,
      violation.message_uuid,
      violation.violation_type,
      violation.severity,
      violation.evidence,
      violation.user_intent,
      violation.claude_behavior,
      violation.claude_correction_prompt,
      violation.notified_claude ? 1 : 0,
      violation.notified_at || null,
      violation.claude_response_uuid || null,
      violation.acknowledged ? 1 : 0,
      violation.created_at,
      violation.expires_at || null
    );
  }

  /**
   * Get unnotified violations for a session
   */
  getUnnotifiedViolations(sessionId: string): ViolationRecord[] {
    return this.db.query(`
      SELECT * FROM violations 
      WHERE session_id = ? 
      AND notified_claude = 0
      ORDER BY created_at ASC
    `).all(sessionId) as ViolationRecord[];
  }

  /**
   * Get all violations for a session
   */
  getSessionViolations(sessionId: string): ViolationRecord[] {
    return this.db.query(`
      SELECT * FROM violations 
      WHERE session_id = ?
      ORDER BY created_at DESC
    `).all(sessionId) as ViolationRecord[];
  }

  /**
   * Mark violations as notified
   */
  markViolationsNotified(violationIds: number[], responseUuid: string): void {
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      for (const id of violationIds) {
        this.db.query(`
          UPDATE violations 
          SET notified_claude = 1, 
              notified_at = ?,
              claude_response_uuid = ?
          WHERE id = ?
        `).run(now, responseUuid, id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Mark a violation as acknowledged
   */
  markViolationAcknowledged(violationId: number): void {
    this.db.query(`
      UPDATE violations 
      SET acknowledged = 1
      WHERE id = ?
    `).run(violationId);
  }

  /**
   * Clean up old violations
   */
  cleanupExpiredViolations(): number {
    const now = Date.now();
    this.db.query(`
      DELETE FROM violations 
      WHERE expires_at IS NOT NULL 
      AND expires_at < ?
    `).run(now);
    
    return 0; // Bun SQLite doesn't have .changes
  }

  close(): void {
    this.db.close();
  }
}