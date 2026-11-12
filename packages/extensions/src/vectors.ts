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
  }
  put(source: string, fingerprint: string, vector: number[]) {
    if (vector.length !== 768 || vector.some((v) => !Number.isFinite(v)))
      throw new Error("Expected finite 768-dimensional embedding");
    this.db
      .prepare(
        "INSERT INTO vectors VALUES (?,?,?) ON CONFLICT(source,fingerprint) DO UPDATE SET vector=excluded.vector",
      )
      .run(source, fingerprint, JSON.stringify(vector));
  }
  search(fingerprint: string, vector: number[], sources: Set<string>) {
    if (vector.length !== 768 || vector.some((v) => !Number.isFinite(v)))
      throw new Error("Invalid query vector");
    const norm = Math.hypot(...vector);
    if (!norm) throw new Error("Zero query vector");
    return this.db
      .prepare("SELECT source,vector FROM vectors WHERE fingerprint=?")
      .all(fingerprint)
      .filter((r) => sources.has(String(r.source)))
      .map((row) => {
        const v = JSON.parse(String(row.vector)) as number[];
        return {
          id: String(row.source),
          score:
            v.reduce((s, x, i) => s + x * vector[i], 0) /
            (Math.hypot(...v) * norm || 1),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
  }
  close() {
    this.db.close();
  }
}
