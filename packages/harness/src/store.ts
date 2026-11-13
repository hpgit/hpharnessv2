import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS objects (kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,type TEXT NOT NULL,created_at TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY,project_id TEXT,content TEXT NOT NULL,kind TEXT NOT NULL,source TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED,content,tokenize='trigram');`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS message_session ON objects(kind,json_extract(json,'$.sessionId'));
      CREATE TABLE IF NOT EXISTS memory_confirmation(id TEXT PRIMARY KEY,confirmed INTEGER NOT NULL);`);
  }
  put(kind: string, value: { id: string }) {
    this.db
      .prepare(
        "INSERT INTO objects VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json",
      )
      .run(kind, value.id, JSON.stringify(value));
    return value;
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT json FROM objects WHERE kind=? AND id=?")
      .get(kind, id);
    return row ? JSON.parse(String(row.json)) : undefined;
  }
  list<T>(kind: string): T[] {
    return this.db
      .prepare("SELECT json FROM objects WHERE kind=? ORDER BY rowid")
      .all(kind)
      .map((r) => JSON.parse(String(r.json)));
  }
  messages<T>(sessionId: string): T[] {
    return this.db.prepare("SELECT json FROM objects WHERE kind='message' AND json_extract(json,'$.sessionId')=? ORDER BY rowid")
      .all(sessionId).map((r) => JSON.parse(String(r.json)));
  }
  memoryDelete(id: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare("DELETE FROM memories WHERE id=?").run(id);
      this.db.prepare("DELETE FROM memory_fts WHERE id=?").run(id);
      this.db.prepare("DELETE FROM memory_confirmation WHERE id=?").run(id);
      this.db.exec("COMMIT");
      return { id, deleted: Number(result.changes) > 0 };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  memoryGet(id: string) {
    return this.db.prepare("SELECT id,project_id AS projectId,content,kind,source FROM memories WHERE id=?").get(id);
  }
  event(type: string, data: unknown) {
    const event = {
      id: randomUUID(),
      type,
      createdAt: new Date().toISOString(),
      data,
    };
    const result = this.db
      .prepare("INSERT INTO events(id,type,created_at,json) VALUES(?,?,?,?)")
      .run(event.id, type, event.createdAt, JSON.stringify(data));
    return { ...event, seq: Number(result.lastInsertRowid) };
  }
  events(after = 0): Array<{
    seq: number;
    id: string;
    type: string;
    createdAt: string;
    data: any;
  }> {
    return this.db
      .prepare(
        "SELECT seq,id,type,created_at AS createdAt,json FROM events WHERE seq>? ORDER BY seq LIMIT 1000",
      )
      .all(after)
      .map((r) => ({
        seq: Number(r.seq),
        id: String(r.id),
        type: String(r.type),
        createdAt: String(r.createdAt),
        data: JSON.parse(String(r.json)),
      }));
  }
  memoryUpsert(value: {
    id?: string;
    projectId?: string;
    content: string;
    kind?: string;
    source?: string;
    confirmed?: boolean;
  }) {
    const entry = {
      ...value,
      id: value.id || randomUUID(),
      projectId: value.projectId ?? null,
      kind: value.kind ?? "fact",
      source: value.source ?? "user",
      updatedAt: new Date().toISOString(),
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO memories VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,content=excluded.content,kind=excluded.kind,source=excluded.source,updated_at=excluded.updated_at",
        )
        .run(
          entry.id,
          entry.projectId,
          entry.content,
          entry.kind,
          entry.source,
          entry.updatedAt,
        );
      this.db.prepare("DELETE FROM memory_fts WHERE id=?").run(entry.id);
      this.db.prepare("INSERT INTO memory_confirmation VALUES(?,?) ON CONFLICT(id) DO UPDATE SET confirmed=excluded.confirmed")
        .run(entry.id, value.confirmed === true ? 1 : 0);
      this.db
        .prepare("INSERT INTO memory_fts VALUES(?,?)")
        .run(entry.id, entry.content);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return entry;
  }
  memoryList(projectId?: string, query = "") {
    const clause = projectId ? " AND (project_id=? OR project_id IS NULL)" : "";
    const args: any[] = [
      `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`,
    ];
    if (projectId) args.push(projectId);
    return this.db
      .prepare(
        `SELECT id,project_id AS projectId,content,kind,source,updated_at AS updatedAt,COALESCE((SELECT confirmed FROM memory_confirmation c WHERE c.id=memories.id),0) AS confirmed FROM memories WHERE content LIKE ? ESCAPE '\\' ${clause} ORDER BY updated_at DESC LIMIT 200`,
      )
      .all(...args);
  }
  close() {
    this.db.close();
  }
}
