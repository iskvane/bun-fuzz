/**
 * Persistence via `bun:sqlite` – built in, no external database, no driver.
 *
 * What gets recorded are the *quantized* events in beat positions rather than
 * samples, so a song can later be played back at any BPM.
 */

import { Database } from "bun:sqlite";
import type { SongInfo } from "../shared/protocol";

export interface RecordedEvent {
  beat: number;
  track: number;
  kind: number;
  note: number;
  vel: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room       TEXT    NOT NULL,
  bpm        REAL    NOT NULL,
  created_at INTEGER NOT NULL,
  title      TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  beat       REAL    NOT NULL,
  track      INTEGER NOT NULL,
  kind       INTEGER NOT NULL,
  note       INTEGER NOT NULL,
  vel        REAL    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_id, beat);
`;

export class Store {
  private readonly db: Database;
  private readonly insertEvent;
  private readonly insertMany;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.run(SCHEMA);

    this.insertEvent = this.db.prepare(
      `INSERT INTO events (session_id, beat, track, kind, note, vel)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    // A transaction wrapper for the batch insert: hundreds of events per second
    // land in a single commit this way.
    this.insertMany = this.db.transaction(
      (sessionId: number, events: RecordedEvent[]) => {
        for (const e of events) {
          this.insertEvent.run(sessionId, e.beat, e.track, e.kind, e.note, e.vel);
        }
        return events.length;
      },
    );
  }

  createSession(room: string, bpm: number): number {
    const row = this.db
      .query<{ id: number }, [string, number, number]>(
        `INSERT INTO sessions (room, bpm, created_at) VALUES (?, ?, ?) RETURNING id`,
      )
      .get(room, bpm, Date.now());
    return row!.id;
  }

  appendEvents(sessionId: number, events: RecordedEvent[]): number {
    if (events.length === 0) return 0;
    return this.insertMany(sessionId, events) as number;
  }

  /** Naming a session is what makes it visible as a song. */
  saveSession(sessionId: number, title: string, bpm: number): void {
    this.db.run(`UPDATE sessions SET title = ?, bpm = ? WHERE id = ?`, [title, bpm, sessionId]);
  }

  /** Only named sessions count as saved songs. */
  listSongs(): SongInfo[] {
    return this.db
      .query<
        { id: number; title: string; bpm: number; events: number; createdAt: number },
        []
      >(
        `SELECT s.id            AS id,
                s.title         AS title,
                s.bpm           AS bpm,
                COUNT(e.id)     AS events,
                s.created_at    AS createdAt
           FROM sessions s
           LEFT JOIN events e ON e.session_id = s.id
          WHERE s.title IS NOT NULL
          GROUP BY s.id
          ORDER BY s.created_at DESC`,
      )
      .all();
  }

  loadEvents(sessionId: number): RecordedEvent[] {
    return this.db
      .query<RecordedEvent, [number]>(
        `SELECT beat, track, kind, note, vel
           FROM events
          WHERE session_id = ?
          ORDER BY beat ASC, id ASC`,
      )
      .all(sessionId);
  }

  getSong(sessionId: number): { id: number; title: string | null; bpm: number } | null {
    return (
      this.db
        .query<{ id: number; title: string | null; bpm: number }, [number]>(
          `SELECT id, title, bpm FROM sessions WHERE id = ?`,
        )
        .get(sessionId) ?? null
    );
  }

  /** Cleans up unnamed, empty sessions – every connection creates one. */
  pruneEmptySessions(): void {
    this.db.run(
      `DELETE FROM sessions
        WHERE title IS NULL
          AND id NOT IN (SELECT DISTINCT session_id FROM events)`,
    );
  }

  close(): void {
    this.db.close();
  }
}
