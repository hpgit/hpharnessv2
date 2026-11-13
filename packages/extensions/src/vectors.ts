import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
export class VectorIndex {
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS vectors (source TEXT, fingerprint TEXT, vector TEXT, PRIMARY KEY(source,fingerprint))",
    );
    this.db.exec(`CREATE TABLE IF NOT EXISTS vector_chunks(source TEXT NOT NULL,fingerprint TEXT NOT NULL,modality TEXT NOT NULL,chunk INTEGER NOT NULL,vector TEXT NOT NULL,PRIMARY KEY(source,fingerprint,modality,chunk));
      CREATE INDEX IF NOT EXISTS vector_chunks_model_source ON vector_chunks(fingerprint,source);
      INSERT OR IGNORE INTO vector_chunks SELECT source,fingerprint,'text',0,vector FROM vectors;
      DELETE FROM vectors;`);
  }
  put(source: string, fingerprint: string, vector: number[]) {
    if (vector.length !== 768 || vector.some((v) => !Number.isFinite(v)))
      throw new Error("Expected finite 768-dimensional embedding");
    this.db
      .prepare(
        "INSERT INTO vector_chunks VALUES (?,?,'text',0,?) ON CONFLICT(source,fingerprint,modality,chunk) DO UPDATE SET vector=excluded.vector",
      )
      .run(source, fingerprint, JSON.stringify(vector));
  }
  replace(source: string, fingerprint: string, modality: "text" | "image", vectors: number[][]) {
    if (!vectors.length || vectors.some((vector) => vector.length !== 768 || vector.some((v) => !Number.isFinite(v))))
      throw new Error("Expected finite 768-dimensional embeddings");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM vector_chunks WHERE source=? AND fingerprint=? AND modality=?").run(source, fingerprint, modality);
      const insert = this.db.prepare("INSERT INTO vector_chunks VALUES (?,?,?,?,?)");
      vectors.forEach((vector, chunk) => insert.run(source, fingerprint, modality, chunk, JSON.stringify(vector)));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  search(fingerprint: string, vector: number[], sources: Set<string>) {
    if (vector.length !== 768 || vector.some((v) => !Number.isFinite(v)))
      throw new Error("Invalid query vector");
    const norm = Math.hypot(...vector);
    if (!norm) throw new Error("Zero query vector");
    const scores = new Map<string, number>();
    const ids = [...sources];
    for (let offset = 0; offset < ids.length; offset += 500) {
      const batch = ids.slice(offset, offset + 500);
      const rows = this.db.prepare(`SELECT source,vector FROM vector_chunks WHERE fingerprint=? AND source IN (${batch.map(() => "?").join(",")})`).all(fingerprint, ...batch);
      for (const row of rows) {
        const v = JSON.parse(String(row.vector)) as number[];
        const score =
            v.reduce((s, x, i) => s + x * vector[i], 0) /
            (Math.hypot(...v) * norm || 1);
        const id = String(row.source);
        scores.set(id, Math.max(scores.get(id) ?? -Infinity, score));
      }
    }
    return [...scores].map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
  }
  close() {
    this.db.close();
  }
}
